import { describe, expect, it, vi } from 'vitest'
import { createIpcBridge, IPC_DISPATCH_TIMEOUT_MS, MAX_IPC_ARGS_BYTES } from '../src/main/ipc-bridge'
import { createPageService } from '../src/main/page-service'
import { CHANNEL_DISPATCH } from '../src/shared/ipc'
import { createWindowRegistry, FakeIpcMain, FakeWindow } from './helpers/fake-window'

describe('IpcBridge', () => {
  it('preload ready 后可 send 并收到 sent:true', async () => {
    const win = new FakeWindow(1)
    const registry = createWindowRegistry([win])
    const ipcMain = new FakeIpcMain()
    win.webContents.bindIpcMain(ipcMain)
    win.webContents.autoPreload = true

    const pageService = createPageService({ getAllWindows: registry.getAllWindows })
    pageService.registerWindow(win)
    const bridge = createIpcBridge(pageService, ipcMain)

    ipcMain.simulatePreloadReady(win.webContents.id)
    expect(pageService.isIpcReady(1)).toBe(true)

    const result = await bridge.dispatchIpc(1, { channel: 'qwqnt_mcp_smoke', args: [], mode: 'send' })
    expect(result).toEqual({ sent: true })
    bridge.dispose()
  })

  it('未 ready 时拒绝', async () => {
    const win = new FakeWindow(2)
    const registry = createWindowRegistry([win])
    const ipcMain = new FakeIpcMain()
    const pageService = createPageService({ getAllWindows: registry.getAllWindows })
    pageService.registerWindow(win)
    const bridge = createIpcBridge(pageService, ipcMain)

    await expect(
      bridge.dispatchIpc(2, { channel: 'foo', mode: 'send' }),
    ).rejects.toThrow('目标页面尚未加载 QwQNT MCP preload，无法发送 IPC')
    bridge.dispose()
  })

  it('拒绝保留通道', async () => {
    const win = new FakeWindow(3)
    const registry = createWindowRegistry([win])
    const ipcMain = new FakeIpcMain()
    const pageService = createPageService({ getAllWindows: registry.getAllWindows })
    pageService.registerWindow(win)
    pageService.markIpcReady(win.webContents.id)
    const bridge = createIpcBridge(pageService, ipcMain)

    await expect(
      bridge.dispatchIpc(3, { channel: 'qwqnt-mcp:dispatch', mode: 'send' }),
    ).rejects.toThrow('拒绝使用保留通道：')
    bridge.dispose()
  })

  it('拒绝过大的 IPC 参数', async () => {
    const win = new FakeWindow(7)
    const registry = createWindowRegistry([win])
    const ipcMain = new FakeIpcMain()
    const pageService = createPageService({ getAllWindows: registry.getAllWindows })
    pageService.registerWindow(win)
    pageService.markIpcReady(win.webContents.id)
    const bridge = createIpcBridge(pageService, ipcMain)

    await expect(
      bridge.dispatchIpc(7, { channel: 'large', args: ['x'.repeat(MAX_IPC_ARGS_BYTES)] }),
    ).rejects.toThrow('IPC 参数超过大小限制')
    bridge.dispose()
  })

  it('忽略错误来源的回执', async () => {
    const win = new FakeWindow(4)
    const registry = createWindowRegistry([win])
    const ipcMain = new FakeIpcMain()
    const pageService = createPageService({ getAllWindows: registry.getAllWindows })
    pageService.registerWindow(win)
    pageService.markIpcReady(win.webContents.id)
    const bridge = createIpcBridge(pageService, ipcMain)

    // 拦截 send，手动从错误 webContents 回执
    let capturedRequestId: string | undefined
    win.webContents.send = (channel: string, ...args: unknown[]) => {
      if (channel === CHANNEL_DISPATCH) {
        const req = args[0] as { requestId: string }
        capturedRequestId = req.requestId
        // 错误来源
        ipcMain.emitFrom(99999, 'qwqnt-mcp:dispatch-result', {
          requestId: req.requestId,
          ok: true,
          value: { sent: true, evil: true },
        })
        // 稍后正确来源
        setTimeout(() => {
          ipcMain.emitFrom(win.webContents.id, 'qwqnt-mcp:dispatch-result', {
            requestId: req.requestId,
            ok: true,
            value: { sent: true, good: true },
          })
        }, 20)
      }
    }

    const result = await bridge.dispatchIpc(4, { channel: 'safe', mode: 'send' })
    expect(capturedRequestId).toBeTruthy()
    expect(result).toEqual({ sent: true, good: true })
    bridge.dispose()
  })

  it('超时拒绝', async () => {
    vi.useFakeTimers()
    const win = new FakeWindow(5)
    const registry = createWindowRegistry([win])
    const ipcMain = new FakeIpcMain()
    const pageService = createPageService({ getAllWindows: registry.getAllWindows })
    pageService.registerWindow(win)
    pageService.markIpcReady(win.webContents.id)
    const bridge = createIpcBridge(pageService, ipcMain)

    // 不回执
    win.webContents.send = () => {
      // swallow
    }

    const promise = bridge.dispatchIpc(5, { channel: 'hang', mode: 'send' })
    const assertion = expect(promise).rejects.toThrow(`操作超时（${IPC_DISPATCH_TIMEOUT_MS} ms）`)
    await vi.advanceTimersByTimeAsync(IPC_DISPATCH_TIMEOUT_MS + 10)
    await assertion
    bridge.dispose()
    vi.useRealTimers()
  })

  it('窗口销毁后 require 失败', async () => {
    const win = new FakeWindow(6)
    const registry = createWindowRegistry([win])
    const ipcMain = new FakeIpcMain()
    const pageService = createPageService({ getAllWindows: registry.getAllWindows })
    pageService.registerWindow(win)
    pageService.markIpcReady(win.webContents.id)
    const bridge = createIpcBridge(pageService, ipcMain)

    win.destroy()
    await expect(bridge.dispatchIpc(6, { channel: 'x', mode: 'send' })).rejects.toThrow(
      '未找到页面：6',
    )
    bridge.dispose()
  })
})
