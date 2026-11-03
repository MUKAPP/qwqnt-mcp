#!/usr/bin/env node
/**
 * 真实 QQ 冒烟客户端。
 * 用法: node scripts/smoke.mjs --url http://127.0.0.1:<port>/mcp --token <token>
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

function parseArgs(argv) {
  const out = { url: '', token: '' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--url') out.url = argv[++i] || ''
    else if (a === '--token') out.token = argv[++i] || ''
  }
  return out
}

function fail(message) {
  console.error(`[smoke] FAIL: ${message}`)
  process.exit(1)
}

function ok(message) {
  console.log(`[smoke] OK: ${message}`)
}

function textOf(result) {
  if (!result?.content) return ''
  return result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text || '')
    .join('\n')
}

async function main() {
  const { url, token } = parseArgs(process.argv.slice(2))
  if (!url || !token) {
    fail('需要 --url 与 --token')
  }

  // 1) 无 Authorization → 401
  const unauth = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'smoke-unauth', version: '0.1.0' },
      },
      id: 1,
    }),
  })
  if (unauth.status !== 401) {
    fail(`无 token 预期 401，实际 ${unauth.status}`)
  }
  ok('无 Authorization 返回 401')

  // 2) 带 token 连接
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  })
  const client = new Client({ name: 'qwqnt-mcp-smoke', version: '0.1.0' })
  await client.connect(transport)
  ok('MCP initialize 成功')

  const { tools } = await client.listTools()
  const names = tools.map((t) => t.name).sort()
  const expected = [
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
  ].sort()
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    fail(`工具列表不符：${names.join(',')}`)
  }
  ok(`十二个工具齐全：${names.join(', ')}`)

  const listResult = await client.callTool({ name: 'list_pages', arguments: {} })
  if (listResult.isError) {
    fail(`list_pages 失败：${textOf(listResult)}`)
  }
  const pages = listResult.structuredContent?.pages
  if (!Array.isArray(pages)) {
    fail('list_pages 无 pages 数组')
  }
  const page = pages.find((p) => p.visible && p.ipcReady)
  if (!page) {
    fail(`未找到 visible && ipcReady 页面；当前：${JSON.stringify(pages)}`)
  }
  ok(`选中页面 pageId=${page.id} title=${JSON.stringify(page.title)}`)

  const htmlResult = await client.callTool({
    name: 'get_page_html',
    arguments: { pageId: page.id },
  })
  if (htmlResult.isError) {
    fail(`get_page_html 失败：${textOf(htmlResult)}`)
  }
  const html = htmlResult.structuredContent?.html || ''
  if (!String(html).toLowerCase().includes('<html')) {
    fail('get_page_html 结果不包含 <html')
  }
  ok(`get_page_html 返回 ${String(html).length} 字符`)

  const shotResult = await client.callTool({
    name: 'capture_page',
    arguments: { pageId: page.id },
  })
  if (shotResult.isError) {
    fail(`capture_page 失败：${textOf(shotResult)}`)
  }
  const imagePart = (shotResult.content || []).find((c) => c.type === 'image')
  if (!imagePart || imagePart.mimeType !== 'image/png' || !imagePart.data) {
    fail(`capture_page 未返回 PNG image content：${JSON.stringify(shotResult.content)}`)
  }
  const shotMeta = shotResult.structuredContent || {}
  if (shotMeta.mimeType !== 'image/png' || !(shotMeta.byteLength > 0)) {
    fail(`capture_page 元数据异常：${JSON.stringify(shotMeta)}`)
  }
  ok(
    `capture_page PNG ${shotMeta.width}x${shotMeta.height} (${shotMeta.byteLength} bytes)`,
  )

  const jsResult = await client.callTool({
    name: 'execute_javascript',
    arguments: { pageId: page.id, expression: 'document.title' },
  })
  if (jsResult.isError) {
    fail(`execute_javascript 失败：${textOf(jsResult)}`)
  }
  const titleValue = jsResult.structuredContent?.value
  if (titleValue !== page.title) {
    fail(
      `document.title 与 list_pages.title 不一致：${JSON.stringify(titleValue)} vs ${JSON.stringify(page.title)}`,
    )
  }
  ok(`execute_javascript document.title === ${JSON.stringify(page.title)}`)

  const ipcResult = await client.callTool({
    name: 'send_ipc',
    arguments: {
      pageId: page.id,
      channel: 'qwqnt_mcp_smoke',
      args: [],
      mode: 'send',
    },
  })
  if (ipcResult.isError) {
    fail(`send_ipc 失败：${textOf(ipcResult)}`)
  }
  if (ipcResult.structuredContent?.result?.sent !== true) {
    fail(`send_ipc 未返回 result.sent===true：${JSON.stringify(ipcResult.structuredContent)}`)
  }
  ok('send_ipc mode=send → result.sent === true')

  // 失败路径：不存在的 pageId
  const missingId = 999999991
  const missing = await client.callTool({
    name: 'get_page_html',
    arguments: { pageId: missingId },
  })
  if (!missing.isError) {
    fail('不存在 pageId 应 isError=true')
  }
  const missingText = textOf(missing)
  if (!missingText.includes(`未找到页面：${missingId}`)) {
    fail(`错误文案不符：${missingText}`)
  }
  ok(`不存在 pageId → isError + 未找到页面：${missingId}`)

  await client.close()
  await transport.close()

  // 错误 token 重连 → 401
  const badToken = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0')
  const badRes = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${badToken}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'smoke-bad-token', version: '0.1.0' },
      },
      id: 2,
    }),
  })
  if (badRes.status !== 401) {
    fail(`错误 token 预期 401，实际 ${badRes.status}`)
  }
  ok('错误 token 返回 401')

  console.log('[smoke] 全部通过')
}

main().catch((err) => {
  console.error('[smoke] 未捕获错误', err)
  process.exit(1)
})
