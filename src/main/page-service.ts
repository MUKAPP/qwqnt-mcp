import { CHANNEL_PING_READY } from '../shared/ipc'
import {
  parseConsoleMessageArgs,
  type PageObservability,
} from './page-observability'
import { buildPageScript, pageErrorReturn, PAGE_NORMALIZE_SOURCE } from './page-script'
import { ToolError } from './tool-error'


/** 窄接口：仅依赖 id / webContents 所需方法，便于 Vitest 注入伪窗口 */
export interface CaptureRect {
  x: number
  y: number
  width: number
  height: number
}

export interface CapturedImage {
  toPNG(): Buffer
  getSize(): { width: number; height: number }
  isEmpty(): boolean
}

export interface PageWebContents {
  id: number
  isDestroyed(): boolean
  getURL(): string
  getTitle(): string
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
  capturePage(rect?: CaptureRect): Promise<CapturedImage>
  send(channel: string, ...args: unknown[]): void
  on(event: string, listener: (...args: unknown[]) => void): void
  once?(event: string, listener: (...args: unknown[]) => void): void
  removeListener?(event: string, listener: (...args: unknown[]) => void): void
  /** Electron session（用于 webRequest 网络摘要）；伪窗口可省略 */
  session?: {
    webRequest?: {
      onCompleted?: (
        filter: { urls: string[] },
        listener: ((details: Record<string, unknown>) => void) | null,
      ) => void
      onErrorOccurred?: (
        filter: { urls: string[] },
        listener: ((details: Record<string, unknown>) => void) | null,
      ) => void
    }
  }
}

export interface PageWindow {
  id: number
  isDestroyed(): boolean
  isVisible(): boolean
  isFocused(): boolean
  getTitle(): string
  webContents: PageWebContents
  on(event: string, listener: (...args: unknown[]) => void): void
  removeListener?(event: string, listener: (...args: unknown[]) => void): void
}

export interface PageInfo {
  id: number
  title: string
  url: string
  visible: boolean
  focused: boolean
  ipcReady: boolean
}

export interface PageServiceDeps {
  getAllWindows: () => PageWindow[]
  /** 可选：注册窗口创建钩子，返回取消函数 */
  onWindowCreated?: (handler: (win: PageWindow) => void) => () => void
  /** 可选：console/network 环形缓冲 */
  observability?: PageObservability
}

export interface PageService {
  listPages(): PageInfo[]
  requirePage(pageId: number): PageWindow
  /** 登记 webContents → window 映射（不标记 ready） */
  registerWindow(win: PageWindow): void
  /** preload 就绪 */
  markIpcReady(webContentsId: number): void
  isIpcReady(pageId: number): boolean
  findWindowIdByWebContentsId(webContentsId: number): number | undefined
  getObservability(): PageObservability | undefined
  dispose(): void
}

const VOID_ELEMENTS = new Set([
  'br',
  'hr',
  'img',
  'input',
  'meta',
  'link',
  'area',
  'base',
  'col',
  'embed',
  'source',
  'track',
  'wbr',
])

/**
 * 在页面上下文中执行的 HTML 序列化器源码。
 * selector / includeShadowDom 经 JSON.stringify 嵌入。
 */
export function buildSerializeHtmlScript(selector: string | undefined, includeShadowDom: boolean): string {
  const selectorLiteral = JSON.stringify(selector ?? null)
  const includeShadowLiteral = JSON.stringify(includeShadowDom)
  return buildPageScript(`
    const selector = ${selectorLiteral};
    const includeShadowDom = ${includeShadowLiteral};
    const VOID_ELEMENTS = new Set(${JSON.stringify([...VOID_ELEMENTS])});

    function escapeText(text) {
      return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function escapeAttr(text) {
      return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    }

    function serializeNode(node) {
      switch (node.nodeType) {
        case Node.TEXT_NODE:
          return escapeText(node.textContent || '');
        case Node.COMMENT_NODE:
          return '<!--' + String(node.textContent || '').replace(/-->/g, '--&gt;') + '-->';
        case Node.DOCUMENT_TYPE_NODE: {
          const dt = node;
          let s = '<!DOCTYPE ' + dt.name;
          if (dt.publicId) s += ' PUBLIC "' + escapeAttr(dt.publicId) + '"';
          if (dt.systemId) {
            if (!dt.publicId) s += ' SYSTEM';
            s += ' "' + escapeAttr(dt.systemId) + '"';
          }
          return s + '>';
        }
        case Node.DOCUMENT_NODE: {
          let out = '';
          for (const child of node.childNodes) out += serializeNode(child);
          return out;
        }
        case Node.DOCUMENT_FRAGMENT_NODE: {
          let out = '';
          for (const child of node.childNodes) out += serializeNode(child);
          return out;
        }
        case Node.ELEMENT_NODE: {
          const tagName = node.tagName.toLowerCase();
          let str = '<' + tagName;
          for (const attr of node.attributes) {
            str += ' ' + attr.name + '="' + escapeAttr(attr.value) + '"';
          }
          str += '>';
          if (includeShadowDom && node.shadowRoot) {
            str += '<template shadowrootmode="open">';
            for (const child of node.shadowRoot.childNodes) {
              str += serializeNode(child);
            }
            str += '</template>';
          }
          for (const child of node.childNodes) {
            str += serializeNode(child);
          }
          if (!VOID_ELEMENTS.has(tagName)) {
            str += '</' + tagName + '>';
          }
          return str;
        }
        default:
          return '';
      }
    }

    if (selector == null) {
      const doctype = document.doctype ? serializeNode(document.doctype) + '\\n' : '';
      return doctype + serializeNode(document.documentElement);
    }

    const target = document.querySelector(selector);
    if (!target) {
      ${pageErrorReturn('ELEMENT_NOT_FOUND', "'页面中未找到选择器：' + selector")}
    }
    return serializeNode(target);
  `)
}

/**
 * 在页面上下文执行表达式的包装器。expression 经 JSON.stringify 嵌入。
 * 结果在页面内归一化（DOM、Date、Map 等 Electron 无法直接回传的值），
 * 返回 { __qwqntMcpValueType, __qwqntMcpValue }。
 */
export function buildEvalScript(expression: string): string {
  const exprLiteral = JSON.stringify(expression)
  return buildPageScript(`
    const __expr = ${exprLiteral};
    const __indirectEval = eval;
    const __result = await __indirectEval(__expr);
${PAGE_NORMALIZE_SOURCE}
    return __qwqntMcpNormalize(__result);
  `)
}

export function createPageService(deps: PageServiceDeps): PageService {
  /** webContents.id → BrowserWindow.id */
  const windowByWebContents = new Map<number, number>()
  /** 已发送 preload-ready 的 webContents.id */
  const ipcReadyWebContents = new Set<number>()
  const tracked = new WeakSet<object>()
  const windowCleanups = new Set<() => void>()
  /** session 共享，每个 session 只挂一次，并保留解除函数 */
  const hookedSessions = new Map<object, () => void>()
  const observability = deps.observability
  let disposed = false

  function clearWebContents(wcId: number): void {
    ipcReadyWebContents.delete(wcId)
    windowByWebContents.delete(wcId)
  }

  function attachObservability(win: PageWindow, on: PageWebContents['on']): void {
    if (!observability) return
    const pageId = win.id
    const wcId = win.webContents.id

    on('console-message', (...args: unknown[]) => {
      if (disposed) return
      const parsed = parseConsoleMessageArgs(args)
      observability.noteConsole({
        pageId,
        webContentsId: wcId,
        level: parsed.level,
        message: parsed.message,
        line: parsed.line,
        sourceId: parsed.sourceId,
      })
    })

    on('did-fail-load', (...args: unknown[]) => {
      if (disposed) return
      // 兼容 (event, errorCode, errorDescription, validatedURL, isMainFrame, ...)
      const errorCode = typeof args[1] === 'number' ? args[1] : undefined
      const errorDescription = typeof args[2] === 'string' ? args[2] : 'load failed'
      const validatedURL = typeof args[3] === 'string' ? args[3] : ''
      const isMainFrame = args[4] !== false
      observability.noteConsole({
        pageId,
        webContentsId: wcId,
        level: 'error',
        message: `did-fail-load${isMainFrame ? '' : '(subframe)'}: ${errorDescription}${errorCode !== undefined ? ` (${errorCode})` : ''}${validatedURL ? ` ${validatedURL}` : ''}`,
      })
    })

    const sessionObj = win.webContents.session as object | undefined
    const webRequest = win.webContents.session?.webRequest
    if (sessionObj && webRequest && !hookedSessions.has(sessionObj)) {
      const filter = { urls: ['*://*/*', 'app://*/*'] }
      hookedSessions.set(sessionObj, () => {
        // webRequest 每个事件只有一个监听槽，通过 null 解除。
        webRequest.onCompleted?.(filter, null)
        webRequest.onErrorOccurred?.(filter, null)
      })
      // 同一 session 可能服务多个窗口：通过 webContentsId 反查 pageId
      const resolvePageId = (webContentsId: number): number => {
        return windowByWebContents.get(webContentsId) ?? -webContentsId
      }

      webRequest.onCompleted?.(filter, (details) => {
        if (disposed) return
        const webContentsId =
          typeof details.webContentsId === 'number' ? details.webContentsId : wcId
        observability.noteNetwork({
          pageId: resolvePageId(webContentsId),
          webContentsId,
          requestId: String(details.id ?? `${Date.now()}`),
          url: String(details.url ?? ''),
          method: String(details.method ?? 'GET'),
          statusCode: typeof details.statusCode === 'number' ? details.statusCode : undefined,
          resourceType: typeof details.resourceType === 'string' ? details.resourceType : undefined,
          fromCache: typeof details.fromCache === 'boolean' ? details.fromCache : undefined,
        })
      })

      webRequest.onErrorOccurred?.(filter, (details) => {
        if (disposed) return
        const webContentsId =
          typeof details.webContentsId === 'number' ? details.webContentsId : wcId
        observability.noteNetwork({
          pageId: resolvePageId(webContentsId),
          webContentsId,
          requestId: String(details.id ?? `${Date.now()}`),
          url: String(details.url ?? ''),
          method: String(details.method ?? 'GET'),
          resourceType: typeof details.resourceType === 'string' ? details.resourceType : undefined,
          error: typeof details.error === 'string' ? details.error : 'error',
        })
      })
    }
  }

  function registerWindow(win: PageWindow): void {
    if (disposed || win.isDestroyed()) return
    const wc = win.webContents
    if (wc.isDestroyed()) return
    const windowId = win.id
    const wcId = wc.id
    windowByWebContents.set(wcId, windowId)

    if (tracked.has(win as object)) return
    tracked.add(win as object)

    const listeners: [string, (...args: unknown[]) => void][] = []
    const on: PageWebContents['on'] = (event, listener) => {
      listeners.push([event, listener])
      wc.on(event, listener)
    }
    const onGone = (): void => {
      observability?.clearPage(windowId)
      clearWebContents(wcId)
    }
    const cleanup = (): void => {
      if (!windowCleanups.delete(cleanup)) return
      if (!win.isDestroyed()) win.removeListener?.('closed', onDestroyed)
      if (!wc.isDestroyed()) {
        for (const [event, listener] of listeners) wc.removeListener?.(event, listener)
      }
    }
    const onDestroyed = (): void => {
      onGone()
      cleanup()
    }
    windowCleanups.add(cleanup)

    win.on('closed', onDestroyed)
    on('destroyed', onDestroyed)
    on('render-process-gone', onGone)
    // 加载开始时清除 ready（SPA/hash 导航不触发）。子帧加载也会触发该事件，
    // 而 preload 并未卸载，因此加载结束后若仍未就绪，主动请求 preload 重新报告。
    on('did-start-loading', () => {
      ipcReadyWebContents.delete(wcId)
    })
    on('did-stop-loading', () => {
      if (disposed || ipcReadyWebContents.has(wcId) || wc.isDestroyed()) return
      try {
        wc.send(CHANNEL_PING_READY)
      } catch {
        // 页面正在销毁时发送失败，等待下一次加载或 preload 自行报告
      }
    })

    attachObservability(win, on)
  }

  for (const win of deps.getAllWindows()) {
    registerWindow(win)
  }

  const unsub = deps.onWindowCreated?.((win) => {
    registerWindow(win)
  })

  return {
    listPages(): PageInfo[] {
      const pages: PageInfo[] = []
      for (const win of deps.getAllWindows()) {
        if (win.isDestroyed()) continue
        registerWindow(win)
        let url = ''
        let title = ''
        try {
          url = win.webContents.getURL()
          const wcTitle = win.webContents.getTitle()
          // 与 document.title 对齐：Electron 在 document.title 为空时可能回退为 URL
          if (wcTitle && wcTitle !== url && !/^(https?:|app:|file:|chrome:)/i.test(wcTitle)) {
            title = wcTitle
          } else {
            title = ''
          }
        } catch {
          // ignore
        }
        pages.push({
          id: win.id,
          title,
          url,
          visible: safeBool(() => win.isVisible()),
          focused: safeBool(() => win.isFocused()),
          ipcReady: ipcReadyWebContents.has(win.webContents.id),
        })
      }
      return pages
    },

    requirePage(pageId: number): PageWindow {
      const win = deps.getAllWindows().find((w) => w.id === pageId && !w.isDestroyed())
      if (!win) {
        throw new ToolError('PAGE_NOT_FOUND', `未找到页面：${pageId}`)
      }
      registerWindow(win)
      return win
    },

    registerWindow,

    markIpcReady(webContentsId: number): void {
      if (disposed) return
      ipcReadyWebContents.add(webContentsId)
      // 若尚未登记 window，尝试从当前窗口反查
      if (!windowByWebContents.has(webContentsId)) {
        for (const win of deps.getAllWindows()) {
          if (!win.isDestroyed() && win.webContents.id === webContentsId) {
            registerWindow(win)
            break
          }
        }
      }
    },

    isIpcReady(pageId: number): boolean {
      try {
        const win = this.requirePage(pageId)
        return ipcReadyWebContents.has(win.webContents.id)
      } catch {
        return false
      }
    },

    findWindowIdByWebContentsId(webContentsId: number): number | undefined {
      const cached = windowByWebContents.get(webContentsId)
      if (cached !== undefined) return cached
      for (const win of deps.getAllWindows()) {
        if (!win.isDestroyed() && win.webContents.id === webContentsId) {
          registerWindow(win)
          return win.id
        }
      }
      return undefined
    },

    getObservability(): PageObservability | undefined {
      return observability
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      unsub?.()
      for (const cleanup of windowCleanups) cleanup()
      for (const cleanup of hookedSessions.values()) cleanup()
      hookedSessions.clear()
      observability?.dispose()
      ipcReadyWebContents.clear()
      windowByWebContents.clear()
    },
  }
}

function safeBool(fn: () => boolean): boolean {
  try {
    return fn()
  } catch {
    return false
  }
}

/** Electron 绑定辅助：从真实 BrowserWindow 适配（避免 qwqnt 与 electron 类型冲突） */
export function adaptElectronWindow(win: unknown): PageWindow {
  return win as PageWindow
}
