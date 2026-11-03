import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { generateToken } from '../src/main/config'
import { startMcpHttpServer, type HttpServerHandle } from '../src/main/http-server'
import { createIpcBridge } from '../src/main/ipc-bridge'
import { createPageObservability } from '../src/main/page-observability'
import { createPageService } from '../src/main/page-service'
import { createWindowRegistry, FakeIpcMain, FakeWindow } from './helpers/fake-window'

const handles: HttpServerHandle[] = []

afterEach(async () => {
  while (handles.length) {
    const h = handles.pop()
    if (h) await h.close()
  }
})

async function startTestServer(opts?: {
  token?: string
  windows?: FakeWindow[]
  autoPreload?: boolean
}) {
  const token = opts?.token ?? generateToken()
  const registry = createWindowRegistry(opts?.windows ?? [])
  const ipcMain = new FakeIpcMain()
  for (const win of registry.windows) {
    win.webContents.bindIpcMain(ipcMain)
    if (opts?.autoPreload !== false) {
      win.webContents.autoPreload = true
    }
  }

  const observability = createPageObservability()
  const pageService = createPageService({
    getAllWindows: registry.getAllWindows,
    observability,
  })
  for (const win of registry.windows) {
    pageService.registerWindow(win)
    if (opts?.autoPreload !== false) {
      // 测试中直接 mark ready
      pageService.markIpcReady(win.webContents.id)
    }
  }

  const ipcBridge = createIpcBridge(pageService, ipcMain)

  // 使用随机高位端口避免冲突
  const port = 19000 + Math.floor(Math.random() * 1000)
  const handle = await startMcpHttpServer({ port, token }, pageService, ipcBridge)
  handles.push(handle)

  return { handle, token, pageService, ipcBridge, registry, ipcMain, port }
}

async function connectClient(url: string, token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  })
  const client = new Client({ name: 'test', version: '0.1.0' })
  await client.connect(transport)
  return { client, transport }
}

describe('HTTP 认证', () => {
  it('无 token 返回 401', async () => {
    const { handle } = await startTestServer()
    const res = await fetch(handle.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 't', version: '0' },
        },
        id: 1,
      }),
    })
    expect(res.status).toBe(401)
  })

  it('错误 token 返回 401', async () => {
    const { handle, token } = await startTestServer()
    const bad = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a')
    const res = await fetch(handle.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bad}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 't', version: '0' },
        },
        id: 1,
      }),
    })
    expect(res.status).toBe(401)
  })

  it('带 Origin 返回 403', async () => {
    const { handle, token } = await startTestServer()
    const res = await fetch(handle.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 't', version: '0' },
        },
        id: 1,
      }),
    })
    expect(res.status).toBe(403)
  })
})

describe('MCP 工具', () => {
  it('initialize 后 listTools 精确十二个工具', async () => {
    const { handle, token } = await startTestServer()
    const { client, transport } = await connectClient(handle.endpoint, token)
    try {
      const { tools } = await client.listTools()
      const names = tools.map((t) => t.name).sort()
      expect(names).toEqual(
        [
          'capture_page',
          'click',
          'execute_javascript',
          'get_console_logs',
          'get_page_html',
          'list_network',
          'list_pages',
          'press_key',
          'query_selector',
          'send_ipc',
          'type_text',
          'wait_for',
        ].sort(),
      )
      expect(client.getInstructions()).toContain('遇到 QQ 窗口、页面 DOM、截图、元素交互')
      expect(client.getInstructions()).toContain('先调用 list_pages')
      expect(tools.find((tool) => tool.name === 'wait_for')?.description).toContain('可能产生副作用')
      expect(tools.find((tool) => tool.name === 'execute_javascript')?.description).toContain(
        '默认不授予 user gesture',
      )
      expect(tools.find((tool) => tool.name === 'send_ipc')?.description).toContain(
        'valueType',
      )
    } finally {
      await client.close()
      await transport.close()
    }
  })

  it('list_pages / get_page_html / execute_javascript / 页面不存在', async () => {
    const win = new FakeWindow(10, {
      title: '消息',
      url: 'https://qq.test/main',
      visible: true,
    })
    win.webContents.executeHandler = async (code: string) => {
      if (code.includes('serializeNode') || code.includes('document.documentElement')) {
        return '<!DOCTYPE html>\n<html><head></head><body>hi</body></html>'
      }
      if (code.includes('document.title') || code.includes('"document.title"')) {
        return '消息'
      }
      return null
    }

    const { handle, token } = await startTestServer({ windows: [win] })
    const { client, transport } = await connectClient(handle.endpoint, token)
    try {
      const list = await client.callTool({ name: 'list_pages', arguments: {} })
      expect(list.isError).toBeFalsy()
      const listData = list.structuredContent as { pages: Array<{ id: number; title: string }> }
      expect(listData.pages).toHaveLength(1)
      expect(listData.pages[0]?.id).toBe(10)
      expect(listData.pages[0]?.title).toBe('消息')

      const html = await client.callTool({
        name: 'get_page_html',
        arguments: { pageId: 10 },
      })
      expect(html.isError).toBeFalsy()
      const htmlData = html.structuredContent as { html: string; pageId: number }
      expect(htmlData.pageId).toBe(10)
      expect(htmlData.html).toContain('<html')

      const js = await client.callTool({
        name: 'execute_javascript',
        arguments: { pageId: 10, expression: 'document.title' },
      })
      expect(js.isError).toBeFalsy()
      const jsData = js.structuredContent as { value: unknown; valueType: string }
      expect(jsData.value).toBe('消息')
      expect(jsData.valueType).toBe('string')

      const missing = await client.callTool({
        name: 'get_page_html',
        arguments: { pageId: 99999 },
      })
      expect(missing.isError).toBe(true)
      const text = (missing.content as Array<{ type: string; text?: string }>)
        .map((c) => c.text || '')

        .join('')
      expect(text).toContain('未找到页面：99999')
    } finally {
      await client.close()
      await transport.close()
    }
  })
  it('页面脚本超时返回机器可读错误码', async () => {
    const win = new FakeWindow(14, { title: '卡住', url: 'https://qq.test/hang', visible: true })
    win.webContents.executeHandler = async () => new Promise<never>(() => {})
    const { handle, token } = await startTestServer({ windows: [win] })
    const { client, transport } = await connectClient(handle.endpoint, token)
    try {
      const html = await client.callTool({
        name: 'get_page_html',
        arguments: { pageId: 14, timeoutMs: 100 },
      })
      expect(html.isError).toBe(true)
      expect((html.structuredContent as { error?: { code?: string } }).error?.code).toBe('TIMEOUT')

      const wait = await client.callTool({
        name: 'wait_for',
        arguments: { pageId: 14, selector: '#never', timeoutMs: 100 },
      })
      expect(wait.isError).toBe(true)
      expect((wait.structuredContent as { error?: { code?: string } }).error?.code).toBe('TIMEOUT')
    } finally {
      await client.close()
      await transport.close()
    }
  })

  it('capture_page 返回 PNG image content', async () => {
    const win = new FakeWindow(12, {
      title: '截图页',
      url: 'https://qq.test/shot',
      visible: true,
    })
    const { handle, token } = await startTestServer({ windows: [win] })
    const { client, transport } = await connectClient(handle.endpoint, token)
    try {
      const result = await client.callTool({
        name: 'capture_page',
        arguments: { pageId: 12 },
      })
      expect(result.isError).toBeFalsy()

      const image = (result.content as Array<{ type: string; data?: string; mimeType?: string }>).find(
        (c) => c.type === 'image',
      )
      expect(image?.mimeType).toBe('image/png')
      expect(typeof image?.data).toBe('string')
      expect((image?.data || '').length).toBeGreaterThan(0)

      const data = result.structuredContent as {
        pageId: number
        mimeType: string
        width: number
        height: number
        byteLength: number
      }
      expect(data.pageId).toBe(12)
      expect(data.mimeType).toBe('image/png')
      expect(data.width).toBeGreaterThan(0)
      expect(data.height).toBeGreaterThan(0)
      expect(data.byteLength).toBeGreaterThan(0)

      const missing = await client.callTool({
        name: 'capture_page',
        arguments: { pageId: 99999 },
      })
      expect(missing.isError).toBe(true)
      const text = (missing.content as Array<{ type: string; text?: string }>)
        .map((c) => c.text || '')
        .join('')
      expect(text).toContain('未找到页面：99999')
    } finally {
      await client.close()
      await transport.close()
    }
  })

  it('capture_page 拒绝过大的截图区域', async () => {
    const win = new FakeWindow(15)
    const { handle, token } = await startTestServer({ windows: [win] })
    const { client, transport } = await connectClient(handle.endpoint, token)
    try {
      const result = await client.callTool({
        name: 'capture_page',
        arguments: {
          pageId: 15,
          rect: { x: 0, y: 0, width: 4097, height: 100 },
        },
      })
      expect(result.isError).toBe(true)
    } finally {
      await client.close()
      await transport.close()
    }
  })

  it('query_selector / wait_for / console logs', async () => {
    const win = new FakeWindow(13, { title: '交互', url: 'https://qq.test/ui', visible: true })
    win.webContents.executeHandler = async (code: string) => {
      if (code.includes('querySelectorAll') || code.includes('describe(el)')) {
        return {
          selector: '#ok',
          exists: true,
          count: 1,
          tagName: 'button',
          text: '确定',
          visible: true,
          enabled: true,
        }
      }
      if (code.includes('urlIncludes') || code.includes('requireVisible') || code.includes('return true')) {
        return true
      }
      return null
    }

    const { handle, token, pageService } = await startTestServer({ windows: [win] })
    pageService.getObservability()?.noteConsole({
      pageId: 13,
      webContentsId: win.webContents.id,
      level: 'info',
      message: 'hello-console',
    })
    pageService.getObservability()?.noteNetwork({
      pageId: 13,
      webContentsId: win.webContents.id,
      requestId: 'r1',
      url: 'https://qq.test/api',
      method: 'GET',
      statusCode: 200,
    })

    const { client, transport } = await connectClient(handle.endpoint, token)
    try {
      const q = await client.callTool({
        name: 'query_selector',
        arguments: { pageId: 13, selector: '#ok' },
      })
      expect(q.isError).toBeFalsy()
      const qData = q.structuredContent as { result: { exists?: boolean; text?: string } }
      expect(qData.result?.exists).toBe(true)
      expect(qData.result?.text).toBe('确定')

      const wait = await client.callTool({
        name: 'wait_for',
        arguments: { pageId: 13, selector: '#ok', timeoutMs: 1000 },
      })
      expect(wait.isError).toBeFalsy()
      const waitData = wait.structuredContent as { matched?: boolean }
      expect(waitData.matched).toBe(true)

      const logs = await client.callTool({
        name: 'get_console_logs',
        arguments: { pageId: 13, limit: 10 },
      })
      expect(logs.isError).toBeFalsy()
      const logData = logs.structuredContent as { logs: Array<{ message: string }> }
      expect(logData.logs.some((l) => l.message === 'hello-console')).toBe(true)

      const net = await client.callTool({
        name: 'list_network',
        arguments: { pageId: 13, limit: 10 },
      })
      expect(net.isError).toBeFalsy()
      const netData = net.structuredContent as { requests: Array<{ url: string }> }
      expect(netData.requests.some((r) => r.url === 'https://qq.test/api')).toBe(true)
    } finally {
      await client.close()
      await transport.close()
    }
  })

  it('send_ipc 在 ready 页面返回 sent:true', async () => {
    const win = new FakeWindow(11)
    const { handle, token } = await startTestServer({ windows: [win], autoPreload: true })
    const { client, transport } = await connectClient(handle.endpoint, token)
    try {
      const result = await client.callTool({
        name: 'send_ipc',
        arguments: {
          pageId: 11,
          channel: 'qwqnt_mcp_smoke',
          args: [],
          mode: 'send',
        },
      })
      expect(result.isError).toBeFalsy()
      const data = result.structuredContent as {
        result: { sent?: boolean }
        mode: string
      }
      expect(data.mode).toBe('send')
      expect(data.result?.sent).toBe(true)
    } finally {
      await client.close()
      await transport.close()
    }
  })

  it('send_ipc invoke 返回稳定结果结构', async () => {
    const win = new FakeWindow(16)
    const { handle, token } = await startTestServer({ windows: [win], autoPreload: true })
    const { client, transport } = await connectClient(handle.endpoint, token)
    try {
      const result = await client.callTool({
        name: 'send_ipc',
        arguments: {
          pageId: 16,
          channel: 'echo',
          args: ['x'],
          mode: 'invoke',
        },
      })
      expect(result.isError).toBeFalsy()
      const data = result.structuredContent as {
        result: { ok?: boolean; valueType?: string; value?: { invokeEcho?: string[] } }
      }
      expect(data.result.ok).toBe(true)
      expect(data.result.valueType).toBe('object')
      expect(data.result.value?.invokeEcho).toEqual(['x'])
    } finally {
      await client.close()
      await transport.close()
    }
  })
})
