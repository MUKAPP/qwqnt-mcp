import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import * as z from 'zod/v4'
import { serializeError } from '../shared/serialize'
import { MAX_IPC_ARGS, type IpcBridge } from './ipc-bridge'
import {
  buildClickScript,
  buildPressKeyScript,
  buildQuerySelectorScript,
  buildTypeTextScript,
  buildWaitConditionScript,
} from './page-actions'
import type { ConsoleLevel } from './page-observability'
import {
  buildEvalScript,
  buildSerializeHtmlScript,
  type CaptureRect,
  type PageService,
} from './page-service'
import { normalizeValue, type ValueType } from '../shared/serialize'

const DEFAULT_JS_TIMEOUT_MS = 10_000
const MIN_JS_TIMEOUT_MS = 100
const MAX_JS_TIMEOUT_MS = 30_000
const DEFAULT_WAIT_TIMEOUT_MS = 10_000
const MIN_WAIT_TIMEOUT_MS = 100
const MAX_WAIT_TIMEOUT_MS = 60_000
const WAIT_POLL_MS = 100
const MAX_SELECTOR_LENGTH = 4_096
const MAX_EXPRESSION_LENGTH = 100_000
const MAX_TEXT_LENGTH = 100_000
const MAX_CHANNEL_LENGTH = 256
const MAX_HTML_CHARS = 1_000_000
const MAX_TOOL_RESPONSE_BYTES = 2_000_000
const MAX_CAPTURE_WIDTH = 4_096
const MAX_CAPTURE_HEIGHT = 4_096
const MAX_CAPTURE_PIXELS = 16_777_216
const MAX_CAPTURE_BYTES = 4_000_000
const QQ_PAGE_SCOPE = '（仅用于 QQNT 客户端）'

const pageIdSchema = z.number().int().nonnegative().describe('Electron BrowserWindow.id')
const selectorSchema = z
  .string()
  .min(1)
  .max(MAX_SELECTOR_LENGTH)
  .describe('CSS 选择器')
const timeoutSchema = z
  .number()
  .int()
  .min(MIN_JS_TIMEOUT_MS)
  .max(MAX_JS_TIMEOUT_MS)
  .optional()
  .describe(`页面脚本超时毫秒，默认 ${DEFAULT_JS_TIMEOUT_MS}，范围 ${MIN_JS_TIMEOUT_MS}–${MAX_JS_TIMEOUT_MS}`)
const waitTimeoutSchema = z
  .number()
  .int()
  .min(MIN_WAIT_TIMEOUT_MS)
  .max(MAX_WAIT_TIMEOUT_MS)
  .optional()
  .describe(`等待超时毫秒，默认 ${DEFAULT_WAIT_TIMEOUT_MS}，最大 ${MAX_WAIT_TIMEOUT_MS}`)

const pageInfoSchema = z.object({
  id: z.number(),
  title: z.string(),
  url: z.string(),
  visible: z.boolean(),
  focused: z.boolean(),
  ipcReady: z.boolean(),
})

const valueTypeSchema = z.enum([
  'undefined',
  'null',
  'boolean',
  'number',
  'string',
  'bigint',
  'array',
  'object',
  'function',
  'symbol',
])

const captureRectSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().positive().max(MAX_CAPTURE_WIDTH),
    height: z.number().positive().max(MAX_CAPTURE_HEIGHT),
  })
  .refine((rect) => rect.width * rect.height <= MAX_CAPTURE_PIXELS, {
    message: `截图区域像素数不能超过 ${MAX_CAPTURE_PIXELS}`,
  })

const ipcResultSchema = z.union([
  z.object({ ok: z.literal(true), sent: z.literal(true) }),
  z.object({ ok: z.literal(true), valueType: valueTypeSchema, value: z.unknown() }),
])
const normalizedIpcResultSchema = z.object({
  valueType: valueTypeSchema,
  value: z.unknown(),
})


type ToolErrorCode =
  | 'PAGE_NOT_FOUND'
  | 'ELEMENT_NOT_FOUND'
  | 'TIMEOUT'
  | 'PAGE_NOT_READY'
  | 'INVALID_ARGUMENT'
  | 'OUTPUT_LIMIT'
  | 'SCRIPT_ERROR'
  | 'IPC_ERROR'
  | 'INTERNAL_ERROR'

interface ToolErrorInfo {
  code: ToolErrorCode
  message: string
  retryable: boolean
}

function classifyToolError(error: unknown): ToolErrorInfo {
  const rawMessage = error instanceof Error ? error.message : String(error)
  if (rawMessage.startsWith('未找到页面：')) {
    return { code: 'PAGE_NOT_FOUND', message: rawMessage, retryable: false }
  }
  if (rawMessage.startsWith('页面中未找到选择器：')) {
    return { code: 'ELEMENT_NOT_FOUND', message: rawMessage, retryable: false }
  }
  if (rawMessage.startsWith('操作超时（')) {
    return { code: 'TIMEOUT', message: rawMessage, retryable: true }
  }
  if (rawMessage.startsWith('目标页面尚未加载')) {
    return { code: 'PAGE_NOT_READY', message: rawMessage, retryable: true }
  }
  if (
    rawMessage.startsWith('channel 不能为空') ||
    rawMessage.startsWith('channel 超过长度限制') ||
    rawMessage.startsWith('拒绝使用保留通道：') ||
    rawMessage.startsWith('IPC 参数无法') ||
    rawMessage.startsWith('IPC 参数不能超过') ||
    rawMessage.startsWith('IPC 参数超过大小限制') ||
    rawMessage.startsWith('截图区域无效') ||
    rawMessage.startsWith('截图区域像素数不能超过') ||
    rawMessage.startsWith('截图结果超过大小限制') ||
    rawMessage.startsWith('等待条件无效') ||
    rawMessage.startsWith('目标元素不可编辑')
  ) {
    return { code: 'INVALID_ARGUMENT', message: rawMessage, retryable: false }
  }
  if (rawMessage.startsWith('工具响应超过大小限制：')) {
    return { code: 'OUTPUT_LIMIT', message: rawMessage, retryable: false }
  }
  if (rawMessage.startsWith('页面脚本结果无效') || rawMessage.includes('SyntaxError')) {
    return { code: 'SCRIPT_ERROR', message: rawMessage, retryable: false }
  }
  if (rawMessage.startsWith('IPC 调用失败')) {
    return { code: 'IPC_ERROR', message: rawMessage, retryable: true }
  }
  return { code: 'INTERNAL_ERROR', message: '工具执行失败', retryable: false }
}

export function toolError(error: unknown): CallToolResult {
  const serialized = serializeError(error)
  const info = classifyToolError(error)
  if (info.code === 'INTERNAL_ERROR') {
    console.error('[qwqnt-mcp] 工具未知错误:', serialized.stack || serialized.message)
  }
  return {
    content: [{ type: 'text', text: info.message }],
    structuredContent: { error: info },
    isError: true,
  }
}


function successResult(structuredContent: Record<string, unknown>): CallToolResult {
  const text = JSON.stringify(structuredContent)
  if (Buffer.byteLength(text, 'utf8') > MAX_TOOL_RESPONSE_BYTES) {
    throw new Error(`工具响应超过大小限制：${MAX_TOOL_RESPONSE_BYTES} bytes`)
  }
  return {
    content: [{ type: 'text', text }],
    structuredContent,
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const { promise: timed, resolve, reject } = Promise.withResolvers<T>()
  const timer = setTimeout(() => {
    reject(new Error(`操作超时（${timeoutMs} ms）`))
  }, timeoutMs)
  promise.then(
    (value) => {
      clearTimeout(timer)
      resolve(value)
    },
    (err: unknown) => {
      clearTimeout(timer)
      reject(err instanceof Error ? err : new Error(String(err)))
    },
  )
  return timed
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

function throwIfPageScriptError(raw: unknown): void {
  if (raw && typeof raw === 'object' && '__qwqntMcpError' in raw) {
    const message = raw.__qwqntMcpError
    if (typeof message === 'string') {
      throw new Error(message)
    }
  }
}

async function runPageScript(
  pageService: PageService,
  pageId: number,
  script: string,
  timeoutMs = DEFAULT_JS_TIMEOUT_MS,
  userGesture = false,
): Promise<unknown> {
  const win = pageService.requirePage(pageId)
  const raw = await withTimeout(
    win.webContents.executeJavaScript(script, userGesture),
    timeoutMs,
  )
  throwIfPageScriptError(raw)
  return raw
}

export function createMcpServer(pageService: PageService, ipcBridge: IpcBridge): McpServer {
  const server = new McpServer(
    {
      name: 'qwqnt-mcp',
      version: '0.1.0',
    },
    {
      instructions:
        QQ_PAGE_SCOPE + ' 本服务专门用于检查和操作 QQ 桌面客户端页面。仅在任务目标为 QQ 时使用；不要为寻找普通浏览器或其他应用的页面而调用 list_pages。遇到 QQ 窗口、页面 DOM、截图、元素交互、页面网络/控制台日志或 IPC 调试任务时，优先使用本服务提供的工具，不要先使用通用浏览器或网页搜索工具。开始任务时如果尚未知道 pageId，先调用 list_pages；读取页面状态优先使用 get_page_html、query_selector、get_console_logs、list_network，只有没有专用工具时才使用 execute_javascript。执行点击、输入、键盘操作或 IPC 前先确认目标页面和参数。',
    },
  )
  const pageOperationTails = new Map<number, Promise<void>>()

  async function withPageOperation<T>(pageId: number, operation: () => Promise<T>): Promise<T> {
    const previous = pageOperationTails.get(pageId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => current)
    pageOperationTails.set(pageId, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (pageOperationTails.get(pageId) === tail) {
        pageOperationTails.delete(pageId)
      }
    }
  }

  server.registerTool(
    'list_pages',
    {
      title: '列出 QQ 页面',
      description: `${QQ_PAGE_SCOPE} 列出当前所有 QQ BrowserWindow 页面及其可见性、URL、IPC 就绪状态。`,
      inputSchema: {},
      outputSchema: {
        pages: z.array(pageInfoSchema),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async () => {
      try {
        return successResult({ pages: pageService.listPages() })
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    'get_page_html',
    {
      title: '读取页面 HTML',
      description:
        `${QQ_PAGE_SCOPE} 读取指定页面的实时 DOM HTML。可选 CSS selector；includeShadowDom 默认 true，将开放 ShadowRoot 序列化为 <template shadowrootmode="open">。页面脚本超时默认 ${DEFAULT_JS_TIMEOUT_MS} ms，响应最多 ${MAX_HTML_CHARS} 个字符。`,
      inputSchema: {
        pageId: pageIdSchema,
        selector: selectorSchema.optional().describe('CSS 选择器；省略则序列化完整 document'),
        includeShadowDom: z
          .boolean()
          .optional()
          .describe('是否序列化开放 Shadow DOM，默认 true'),
        timeoutMs: timeoutSchema,
      },
      outputSchema: {
        pageId: z.number(),
        url: z.string(),
        html: z.string(),
        truncated: z.boolean(),
        totalLength: z.number(),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ pageId, selector, includeShadowDom, timeoutMs }) => {
      try {
        const win = pageService.requirePage(pageId)
        const includeShadow = includeShadowDom !== false
        const script = buildSerializeHtmlScript(selector, includeShadow)
        const raw = await withTimeout(
          win.webContents.executeJavaScript(script, false),
          timeoutMs ?? DEFAULT_JS_TIMEOUT_MS,
        )
        throwIfPageScriptError(raw)
        if (typeof raw !== 'string') {
          throw new Error('页面 HTML 序列化结果无效')
        }
        let url = ''
        try {
          url = win.webContents.getURL()
        } catch {
          // ignore
        }
        const totalLength = raw.length
        const truncated = totalLength > MAX_HTML_CHARS
        const html = truncated ? raw.slice(0, MAX_HTML_CHARS) : raw
        return successResult({ pageId, url, html, truncated, totalLength })
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    'capture_page',
    {
      title: '截取页面图像',
      description:
        `${QQ_PAGE_SCOPE} 截取指定 QQ 页面的当前画面并返回 PNG 图片。可选 rect 指定页面内矩形区域（CSS 像素）；宽高最多 ${MAX_CAPTURE_WIDTH}×${MAX_CAPTURE_HEIGHT}，总像素最多 ${MAX_CAPTURE_PIXELS}。截图超时默认 ${DEFAULT_JS_TIMEOUT_MS} ms。`,
      inputSchema: {
        pageId: pageIdSchema,
        rect: captureRectSchema.optional().describe('可选截图区域，坐标和尺寸使用 CSS 像素'),
        timeoutMs: timeoutSchema,
      },
      outputSchema: {
        pageId: z.number(),
        url: z.string(),
        mimeType: z.literal('image/png'),
        width: z.number(),
        height: z.number(),
        byteLength: z.number(),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ pageId, rect, timeoutMs }) => {
      try {
        const win = pageService.requirePage(pageId)
        let captureRect: CaptureRect | undefined
        if (rect) {
          const x = Math.floor(rect.x)
          const y = Math.floor(rect.y)
          const width = Math.floor(rect.width)
          const height = Math.floor(rect.height)
          if (
            !Number.isFinite(x) ||
            !Number.isFinite(y) ||
            width <= 0 ||
            height <= 0 ||
            width > MAX_CAPTURE_WIDTH ||
            height > MAX_CAPTURE_HEIGHT ||
            width * height > MAX_CAPTURE_PIXELS
          ) {
            throw new Error('截图区域无效')
          }
          captureRect = { x, y, width, height }
        }

        const image = await withTimeout(
          win.webContents.capturePage(captureRect),
          timeoutMs ?? DEFAULT_JS_TIMEOUT_MS,
        )
        if (!image || image.isEmpty()) {
          throw new Error('截图结果为空')
        }
        const png = image.toPNG()
        if (!png || png.length === 0) {
          throw new Error('截图结果为空')
        }
        if (png.length > MAX_CAPTURE_BYTES) {
          throw new Error(`截图结果超过大小限制：${MAX_CAPTURE_BYTES} bytes`)
        }
        const size = image.getSize()
        let url = ''
        try {
          url = win.webContents.getURL()
        } catch {
          // ignore
        }
        const structuredContent = {
          pageId,
          url,
          mimeType: 'image/png' as const,
          width: size.width,
          height: size.height,
          byteLength: png.length,
        }
        return {
          content: [
            {
              type: 'image',
              data: png.toString('base64'),
              mimeType: 'image/png',
            },
            {
              type: 'text',
              text: JSON.stringify(structuredContent),
            },
          ],
          structuredContent,
        }
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    'query_selector',
    {
      title: '查询页面元素',
      description:
        `${QQ_PAGE_SCOPE} 查询 CSS 选择器对应元素的存在性、文本、属性、boundingClientRect、可见性与可用状态。all=true 时最多返回 50 个匹配；页面脚本超时默认 ${DEFAULT_JS_TIMEOUT_MS} ms。`,
      inputSchema: {
        pageId: pageIdSchema,
        selector: selectorSchema,
        all: z.boolean().optional().describe('是否返回全部匹配（最多 50），默认 false'),
        timeoutMs: timeoutSchema,
      },
      outputSchema: {
        pageId: z.number(),
        result: z.unknown(),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ pageId, selector, all, timeoutMs }) => {
      try {
        const result = await runPageScript(
          pageService,
          pageId,
          buildQuerySelectorScript(selector, all === true),
          timeoutMs ?? DEFAULT_JS_TIMEOUT_MS,
        )
        return successResult({ pageId, result })
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    'click',
    {
      title: '点击页面元素',
      description:
        `${QQ_PAGE_SCOPE} 对 CSS 选择器命中的首个元素执行页面内合成点击（先 scrollIntoView），不是系统级真实鼠标输入。button 默认 left；clickCount 默认 1。`,
      inputSchema: {
        pageId: pageIdSchema,
        selector: selectorSchema,
        button: z
          .enum(['left', 'middle', 'right'])
          .optional()
          .describe('鼠标按钮，默认 left'),
        clickCount: z
          .number()
          .int()
          .min(1)
          .max(3)
          .optional()
          .describe('点击次数，默认 1；页面事件不保证等同系统双击'),
        timeoutMs: timeoutSchema,
      },
      outputSchema: {
        pageId: z.number(),
        result: z.unknown(),
      },
      annotations: {
        readOnlyHint: false,
      },
    },
    async ({ pageId, selector, button, clickCount, timeoutMs }) => {
      try {
        const result = await withPageOperation(pageId, () =>
          runPageScript(
            pageService,
            pageId,
            buildClickScript(selector, { button, clickCount }),
            timeoutMs ?? DEFAULT_JS_TIMEOUT_MS,
          ),
        )
        return successResult({ pageId, result })
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    'type_text',
    {
      title: '向元素输入文本',
      description:
        `${QQ_PAGE_SCOPE} 向 CSS 选择器命中的 input、textarea 或 contenteditable 元素输入文本。clear 默认 true；submit=true 时追加 Enter 并尝试 requestSubmit。文本最多 ${MAX_TEXT_LENGTH} 个字符；操作使用页面内合成事件。`,
      inputSchema: {
        pageId: pageIdSchema,
        selector: selectorSchema,
        text: z.string().max(MAX_TEXT_LENGTH).describe('要输入的文本'),
        clear: z.boolean().optional().describe('是否先清空原值，默认 true'),
        submit: z.boolean().optional().describe('是否追加 Enter 并尝试提交表单，默认 false'),
        timeoutMs: timeoutSchema,
      },
      outputSchema: {
        pageId: z.number(),
        result: z.unknown(),
      },
      annotations: {
        readOnlyHint: false,
      },
    },
    async ({ pageId, selector, text, clear, submit, timeoutMs }) => {
      try {
        const result = await withPageOperation(pageId, () =>
          runPageScript(
            pageService,
            pageId,
            buildTypeTextScript(selector, text, { clear, submit }),
            timeoutMs ?? DEFAULT_JS_TIMEOUT_MS,
          ),
        )
        return successResult({ pageId, result })
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    'press_key',
    {
      title: '发送按键',
      description:
        `${QQ_PAGE_SCOPE} 向页面发送键盘合成事件。可选 selector 先聚焦目标；modifiers 支持 ctrl/alt/shift/meta。不是系统级真实键盘输入。`,
      inputSchema: {
        pageId: pageIdSchema,
        key: z.string().min(1).max(64).describe('如 Enter、Escape、a、Tab'),
        selector: selectorSchema.optional().describe('可选 CSS 选择器；省略则使用当前焦点元素'),
        modifiers: z
          .array(z.enum(['ctrl', 'control', 'alt', 'shift', 'meta', 'metaKey']))
          .max(4)
          .optional()
          .describe('修饰键列表'),
        timeoutMs: timeoutSchema,
      },
      outputSchema: {
        pageId: z.number(),
        result: z.unknown(),
      },
      annotations: {
        readOnlyHint: false,
      },
    },
    async ({ pageId, key, selector, modifiers, timeoutMs }) => {
      try {
        const result = await withPageOperation(pageId, () =>
          runPageScript(
            pageService,
            pageId,
            buildPressKeyScript(key, { selector, modifiers }),
            timeoutMs ?? DEFAULT_JS_TIMEOUT_MS,
          ),
        )
        return successResult({ pageId, result })
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    'wait_for',
    {
      title: '等待页面条件',
      description:
        `${QQ_PAGE_SCOPE} 轮询等待条件成立。可指定 selector（可选要求可见）、urlIncludes、expression（会在页面执行代码）。timeoutMs 默认 ${DEFAULT_WAIT_TIMEOUT_MS}，最大 ${MAX_WAIT_TIMEOUT_MS}。expression 可能产生副作用，因此该工具不标记为只读。`,
      inputSchema: {
        pageId: pageIdSchema,
        selector: selectorSchema.optional(),
        visible: z.boolean().optional().describe('selector 是否要求可见，默认 false'),
        urlIncludes: z.string().max(MAX_SELECTOR_LENGTH).optional().describe('URL 必须包含的文本'),
        expression: z
          .string()
          .max(MAX_EXPRESSION_LENGTH)
          .optional()
          .describe('在页面中间接 eval，结果为真即通过；可能产生副作用'),
        timeoutMs: waitTimeoutSchema,
      },
      outputSchema: {
        pageId: z.number(),
        waitedMs: z.number(),
        matched: z.boolean(),
      },
      annotations: {
        readOnlyHint: false,
      },
    },
    async ({ pageId, selector, visible, urlIncludes, expression, timeoutMs }) => {
      try {
        if (!selector && !urlIncludes && !expression) {
          throw new Error('等待条件无效：请提供 selector、urlIncludes 或 expression 之一')
        }
        const win = pageService.requirePage(pageId)
        const timeout = timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
        const script = buildWaitConditionScript({
          selector,
          urlIncludes,
          expression,
          visible,
        })
        const started = Date.now()
        while (Date.now() - started <= timeout) {
          const remaining = timeout - (Date.now() - started)
          const ok = await withTimeout(
            win.webContents.executeJavaScript(script, false),
            Math.min(Math.max(remaining, 1), MAX_JS_TIMEOUT_MS),
          )
          if (ok === true) {
            return successResult({
              pageId,
              waitedMs: Date.now() - started,
              matched: true,
            })
          }
          const sleepMs = Math.min(WAIT_POLL_MS, timeout - (Date.now() - started))
          if (sleepMs > 0) await sleep(sleepMs)
        }
        throw new Error(`操作超时（${timeout} ms）`)
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    'get_console_logs',
    {
      title: '读取页面控制台日志',
      description:
        `${QQ_PAGE_SCOPE} 读取主进程缓冲的页面 console / 加载失败日志。可按 pageId、level、after 过滤；单条内容已截断；limit 默认 100；clear=true 时消费已返回条目。`,
      inputSchema: {
        pageId: pageIdSchema.optional().describe('可选 BrowserWindow.id；省略则读取所有页面'),
        level: z.enum(['debug', 'info', 'warning', 'error', 'unknown']).optional().describe('日志级别'),
        after: z.number().int().nonnegative().optional().describe('只返回 sequence 大于此值的新日志'),
        limit: z.number().int().min(1).max(500).optional().describe('返回条数，默认 100，最大 500'),
        clear: z.boolean().optional().describe('是否消费已返回的条目，默认 false'),
      },
      outputSchema: {
        logs: z.array(
          z.object({
            sequence: z.number(),
            pageId: z.number(),
            webContentsId: z.number(),
            level: z.string(),
            message: z.string(),
            line: z.number().optional(),
            sourceId: z.string().optional(),
            timestamp: z.number(),
          }),
        ),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ pageId, level, after, limit, clear }) => {
      try {
        const obs = pageService.getObservability()
        if (!obs) {
          return successResult({ logs: [] })
        }
        if (typeof pageId === 'number') {
          pageService.requirePage(pageId)
        }
        const logs = obs.getConsoleLogs({
          pageId,
          level: level as ConsoleLevel | undefined,
          after,
          limit,
          clear,
        })
        return successResult({ logs })
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    'list_network',
    {
      title: '列出最近网络请求摘要',
      description:
        `${QQ_PAGE_SCOPE} 读取主进程缓冲的最近网络请求摘要（URL/method/status/resourceType，不含 body）。URL 默认移除 query 和 fragment；支持 after cursor；limit 默认 100；clear=true 时消费已返回条目。`,
      inputSchema: {
        pageId: pageIdSchema.optional().describe('可选 BrowserWindow.id；省略则读取所有页面'),
        after: z.number().int().nonnegative().optional().describe('只返回 sequence 大于此值的新请求'),
        limit: z.number().int().min(1).max(500).optional().describe('返回条数，默认 100，最大 500'),
        clear: z.boolean().optional().describe('是否消费已返回的条目，默认 false'),
      },
      outputSchema: {
        requests: z.array(
          z.object({
            sequence: z.number(),
            pageId: z.number(),
            webContentsId: z.number(),
            requestId: z.string(),
            url: z.string(),
            method: z.string(),
            statusCode: z.number().optional(),
            resourceType: z.string().optional(),
            fromCache: z.boolean().optional(),
            error: z.string().optional(),
            timestamp: z.number(),
          }),
        ),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ pageId, after, limit, clear }) => {
      try {
        const obs = pageService.getObservability()
        if (!obs) {
          return successResult({ requests: [] })
        }
        if (typeof pageId === 'number') {
          pageService.requirePage(pageId)
        }
        const requests = obs.getNetworkLogs({ pageId, after, limit, clear })
        return successResult({ requests })
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    'execute_javascript',
    {
      title: '在页面执行 JavaScript',
      description:
        `${QQ_PAGE_SCOPE} 在指定页面全局上下文执行 JavaScript 表达式并返回结果。默认不授予 user gesture；禁止执行无限循环。超时只停止 MCP 等待，无法取消已经进入 renderer 的脚本。timeoutMs 默认 ${DEFAULT_JS_TIMEOUT_MS}，范围 ${MIN_JS_TIMEOUT_MS}–${MAX_JS_TIMEOUT_MS}；表达式最多 ${MAX_EXPRESSION_LENGTH} 个字符。`,
      inputSchema: {
        pageId: pageIdSchema,
        expression: z
          .string()
          .min(1)
          .max(MAX_EXPRESSION_LENGTH)
          .describe('要执行的 JavaScript 表达式或语句'),
        timeoutMs: timeoutSchema,
      },
      outputSchema: {
        pageId: z.number(),
        valueType: valueTypeSchema,
        value: z.unknown(),
      },
      annotations: {
        readOnlyHint: false,
      },
    },
    async ({ pageId, expression, timeoutMs }) => {
      try {
        const raw = await withPageOperation(pageId, () =>
          runPageScript(
            pageService,
            pageId,
            buildEvalScript(expression),
            timeoutMs ?? DEFAULT_JS_TIMEOUT_MS,
            false,
          ),
        )
        const normalized = normalizeValue(raw)
        return successResult({
          pageId,
          valueType: normalized.valueType as ValueType,
          value: normalized.value,
        })
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    'send_ipc',
    {
      title: '从渲染进程发送 IPC',
      description:
        `${QQ_PAGE_SCOPE} 从目标 QQ 渲染进程调用 Electron ipcRenderer.send 或 ipcRenderer.invoke（mode 默认 send）。不是主进程向页面广播。拒绝保留通道 qwqnt-mcp:*；channel 最多 ${MAX_CHANNEL_LENGTH} 个字符，args 最多 ${MAX_IPC_ARGS} 项。send 返回 {ok:true,sent:true}，invoke 返回 {ok:true,valueType,value}。`,
      inputSchema: {
        pageId: pageIdSchema,
        channel: z
          .string()
          .min(1)
          .max(MAX_CHANNEL_LENGTH)
          .describe('IPC 通道名；不允许 qwqnt-mcp: 前缀'),
        args: z
          .array(z.unknown())
          .max(MAX_IPC_ARGS)
          .optional()
          .describe(`参数列表，默认 []，最多 ${MAX_IPC_ARGS} 项`),
        mode: z.enum(['send', 'invoke']).optional().describe('send 或 invoke，默认 send'),
      },
      outputSchema: {
        pageId: z.number(),
        channel: z.string(),
        mode: z.enum(['send', 'invoke']),
        result: ipcResultSchema,
      },
      annotations: {
        readOnlyHint: false,
      },
    },
    async ({ pageId, channel, args, mode }) => {
      try {
        const resolvedMode = mode === 'invoke' ? 'invoke' : 'send'
        const rawResult = await withPageOperation(pageId, () =>
          ipcBridge.dispatchIpc(pageId, {
            channel,
            args: args ?? [],
            mode: resolvedMode,
          }),
        )
        const result =
          resolvedMode === 'send'
            ? { ok: true as const, sent: true as const }
            : (() => {
                const normalized = normalizedIpcResultSchema.parse(rawResult)
                return {
                  ok: true as const,
                  valueType: normalized.valueType,
                  value: normalized.value,
                }
              })()
        return successResult({
          pageId,
          channel,
          mode: resolvedMode,
          result,
        })
      } catch (error) {
        return toolError(error)
      }
    },
  )

  return server
}
