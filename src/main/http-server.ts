import { createServer, type Server as HttpServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import express, { type Request, type Response, type NextFunction } from 'express'
import { localhostHostValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpConfig } from './config'
import type { IpcBridge } from './ipc-bridge'
import type { PageService } from './page-service'
import { createMcpServer, createPageOperationQueue } from './mcp-server'

/**
 * JSON 请求体上限。工具参数允许 10 万字符的文本/表达式（中文按 UTF-8 最多约 300 KB）
 * 和 1 MB 的 IPC 参数，JSON 转义还会放大体积，因此留出余量。
 */
export const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024

export interface HttpServerHandle {
  port: number
  endpoint: string
  close(): Promise<void>
}

interface ActiveSession {
  transport: StreamableHTTPServerTransport
  server: McpServer
}

function unauthorized(res: Response): void {
  res.status(401).json({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Unauthorized' },
    id: null,
  })
}

function methodNotAllowed(res: Response): void {
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    }),
  )
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  })
}

function tokensEqual(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(provided, 'utf8')
  if (a.length !== b.length) {
    // 长度不同时仍做一次 dummy compare，避免提前返回的时序差异过大
    const dummy = Buffer.alloc(a.length)
    timingSafeEqual(a, dummy)
    return false
  }
  return timingSafeEqual(a, b)
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!match) return null
  return match[1]?.trim() || null
}

export async function startMcpHttpServer(
  config: McpConfig,
  pageService: PageService,
  ipcBridge: IpcBridge,
): Promise<HttpServerHandle> {
  const app = express()
  // 与 SDK createMcpExpressApp 相同的 DNS rebinding 防护：只接受本机 Host
  app.use(localhostHostValidation())
  const active = new Set<ActiveSession>()
  const operationQueue = createPageOperationQueue()
  const MAX_ACTIVE_REQUESTS = 32
  let activeRequests = 0

  app.use((req: Request, res: Response, next: NextFunction) => {
    // 拒绝带 Origin 的浏览器跨站请求；标准本地 Agent 无需 Origin
    if (req.headers.origin !== undefined) {
      res.status(403).json({
        jsonrpc: '2.0',
        error: { code: -32003, message: 'Forbidden: browser Origin not allowed' },
        id: null,
      })
      return
    }
    next()
  })

  app.use('/mcp', (req: Request, res: Response, next: NextFunction) => {
    const token = extractBearerToken(
      typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
    )
    if (!token || !tokensEqual(config.token, token)) {
      unauthorized(res)
      return
    }
    next()
  })

  // 认证通过后再解析请求体，避免未认证请求占用解析开销
  app.use('/mcp', express.json({ limit: MAX_REQUEST_BODY_BYTES }))
  app.use('/mcp', (error: unknown, _req: Request, res: Response, next: NextFunction) => {
    const type = error && typeof error === 'object' && 'type' in error ? error.type : undefined
    if (type === 'entity.too.large') {
      jsonRpcError(res, 413, -32600, `请求体超过大小限制：${MAX_REQUEST_BODY_BYTES} bytes`)
      return
    }
    if (type === 'entity.parse.failed') {
      jsonRpcError(res, 400, -32700, 'Parse error: 请求体不是合法 JSON')
      return
    }
    next(error)
  })

  app.post('/mcp', async (req: Request, res: Response) => {
    if (activeRequests >= MAX_ACTIVE_REQUESTS) {
      res.status(503).json({
        jsonrpc: '2.0',
        error: { code: -32005, message: 'MCP 服务繁忙，请稍后重试' },
        id: null,
      })
      return
    }

    activeRequests += 1
    const server = createMcpServer(pageService, ipcBridge, operationQueue)
    let cleaned = false
    let session: ActiveSession | undefined
    const cleanup = (): void => {
      if (cleaned) return
      cleaned = true
      activeRequests -= 1
      if (session) active.delete(session)
      if (session) {
        void session.transport.close()
        void session.server.close()
      } else {
        void server.close()
      }
    }

    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      })
      session = { transport, server }
      active.add(session)
      res.setHeader('Cache-Control', 'no-store')
      res.on('close', cleanup)

      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch (error) {
      console.error('[qwqnt-mcp] MCP 请求处理失败:', error)
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        })
      }
      if (!session) cleanup()
    }
  })

  app.get('/mcp', (_req: Request, res: Response) => {
    methodNotAllowed(res)
  })

  app.delete('/mcp', (_req: Request, res: Response) => {
    methodNotAllowed(res)
  })

  const httpServer: HttpServer = createServer(app)

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      httpServer.off('listening', onListening)
      reject(err)
    }
    const onListening = (): void => {
      httpServer.off('error', onError)
      resolve()
    }
    httpServer.once('error', onError)
    httpServer.once('listening', onListening)
    httpServer.listen(config.port, '127.0.0.1')
  })

  const endpoint = `http://127.0.0.1:${config.port}/mcp`

  return {
    port: config.port,
    endpoint,
    async close(): Promise<void> {
      for (const session of Array.from(active)) {
        active.delete(session)
        try {
          await session.transport.close()
        } catch {
          // ignore
        }
        try {
          await session.server.close()
        } catch {
          // ignore
        }
      }
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    },
  }
}
