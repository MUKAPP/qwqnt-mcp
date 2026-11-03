import { app, BrowserWindow, ipcMain } from 'electron'
import { loadConfig } from './config'
import { startMcpHttpServer, type HttpServerHandle } from './http-server'
import { createIpcBridge, type IpcBridge } from './ipc-bridge'
import {
  createPageService,
  adaptElectronWindow,
  type PageService,
} from './page-service'
import { createPageObservability } from './page-observability'

let pageService: PageService | undefined
let ipcBridge: IpcBridge | undefined
let httpHandle: HttpServerHandle | undefined
let shuttingDown = false

function logInfo(message: string): void {
  console.log(`[qwqnt-mcp] ${message}`)
}

function logError(message: string, error?: unknown): void {
  if (error !== undefined) {
    console.error(`[qwqnt-mcp] ${message}`, error)
  } else {
    console.error(`[qwqnt-mcp] ${message}`)
  }
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  try {
    if (httpHandle) {
      await httpHandle.close()
      httpHandle = undefined
    }
  } catch (error) {
    logError('关闭 HTTP 服务失败', error)
  }
  try {
    ipcBridge?.dispose()
    ipcBridge = undefined
  } catch (error) {
    logError('关闭 IPC bridge 失败', error)
  }
  try {
    pageService?.dispose()
    pageService = undefined
  } catch (error) {
    logError('关闭页面服务失败', error)
  }
}

async function bootstrap(): Promise<void> {
  const { config, configPath } = loadConfig()
  const observability = createPageObservability()

  pageService = createPageService({
    getAllWindows: () => BrowserWindow.getAllWindows().map((w) => adaptElectronWindow(w)),
    onWindowCreated: (handler) => {
      qwqnt.main.hooks.whenBrowserWindowCreated.peek((win) => {
        handler(adaptElectronWindow(win))
      })
      return () => {
        // peek 钩子通常不可取消
      }
    },
    observability,
  })

  // 登记已有窗口映射
  for (const win of BrowserWindow.getAllWindows()) {
    pageService.registerWindow(adaptElectronWindow(win))
  }

  ipcBridge = createIpcBridge(pageService, ipcMain)

  try {
    httpHandle = await startMcpHttpServer(config, pageService, ipcBridge)
    logInfo(`MCP 服务已启动：${httpHandle.endpoint}`)
    logInfo(`配置文件：${configPath}`)
  } catch (error) {
    logError(
      `MCP HTTP 服务启动失败（端口 ${config.port} 可能被占用）。QQ 将继续运行，请修改配置后重启。`,
      error,
    )
  }

  app.on('before-quit', () => {
    void shutdown()
  })
}

void bootstrap().catch((error) => {
  logError('插件启动失败', error)
})
