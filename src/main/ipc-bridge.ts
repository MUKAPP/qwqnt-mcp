import { randomUUID } from 'node:crypto'
import {
  CHANNEL_DISPATCH,
  CHANNEL_DISPATCH_RESULT,
  CHANNEL_PRELOAD_READY,
  isReservedChannel,
  type IpcDispatchMode,
  type IpcDispatchRequest,
  type IpcDispatchResult,
} from '../shared/ipc'
import { normalizeValue } from '../shared/serialize'
import type { PageService } from './page-service'
import { ToolError } from './tool-error'
export const IPC_DISPATCH_TIMEOUT_MS = 10_000
export const MAX_IPC_ARGS = 64
export const MAX_IPC_ARGS_BYTES = 1_000_000

function estimateStructuredCloneSize(value: unknown): number {
  const seen = new WeakSet<object>()
  function visit(input: unknown, depth: number): number {
    if (depth > 32) return MAX_IPC_ARGS_BYTES + 1
    if (input === null || input === undefined) return 8
    if (typeof input === 'string') return Buffer.byteLength(input, 'utf8')
    if (typeof input === 'number' || typeof input === 'boolean' || typeof input === 'bigint') return 16
    if (typeof input !== 'object') return 32
    if (seen.has(input)) return 8
    seen.add(input)
    if (Array.isArray(input)) {
      return input.reduce((size, item) => size + visit(item, depth + 1), 16)
    }
    return Object.entries(input).reduce(
      (size, [key, item]) => size + Buffer.byteLength(key, 'utf8') + visit(item, depth + 1),
      32,
    )
  }
  return visit(value, 0)
}

export interface IpcMainLike {
  on(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => void): void
  removeListener?(channel: string, listener: (...args: unknown[]) => void): void
}

export interface IpcEventLike {
  sender: { id: number }
}

export interface IpcBridge {
  dispatchIpc(
    pageId: number,
    options: { channel: string; args?: unknown[]; mode?: IpcDispatchMode },
  ): Promise<unknown>
  dispose(): void
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  webContentsId: number
  timer: ReturnType<typeof setTimeout>
}

export function createIpcBridge(pageService: PageService, ipcMain: IpcMainLike): IpcBridge {
  const pending = new Map<string, Pending>()

  const onReady = (event: IpcEventLike): void => {
    if (pageService.findWindowIdByWebContentsId(event.sender.id) === undefined) return
    pageService.markIpcReady(event.sender.id)
  }

  const onResult = (event: IpcEventLike, payload: unknown): void => {
    if (!payload || typeof payload !== 'object') return
    const result = payload as IpcDispatchResult
    if (typeof result.requestId !== 'string') return

    const entry = pending.get(result.requestId)
    if (!entry) return

    // 只接受同一 webContents 的回执
    if (event.sender.id !== entry.webContentsId) {
      return
    }

    clearTimeout(entry.timer)
    pending.delete(result.requestId)

    if (result.ok) {
      entry.resolve(result.value)
      return
    }

    const err = result.error
    const error = new ToolError('IPC_ERROR', `IPC 调用失败：${err?.message || '未知错误'}`)
    if (err?.stack) error.stack = err.stack
    entry.reject(error)
  }

  ipcMain.on(CHANNEL_PRELOAD_READY, onReady as (event: IpcEventLike, ...args: unknown[]) => void)
  ipcMain.on(CHANNEL_DISPATCH_RESULT, onResult as (event: IpcEventLike, ...args: unknown[]) => void)

  async function dispatchIpc(
    pageId: number,
    options: { channel: string; args?: unknown[]; mode?: IpcDispatchMode },
  ): Promise<unknown> {
    const channel = options.channel
    if (!channel || typeof channel !== 'string' || channel.trim() === '') {
      throw new ToolError('INVALID_ARGUMENT', 'channel 不能为空')
    }
    if (channel.length > 256) {
      throw new ToolError('INVALID_ARGUMENT', 'channel 超过长度限制')
    }
    if (isReservedChannel(channel)) {
      throw new ToolError('INVALID_ARGUMENT', `拒绝使用保留通道：${channel}`)
    }

    const win = pageService.requirePage(pageId)

    if (!pageService.isIpcReady(pageId)) {
      throw new ToolError('PAGE_NOT_READY', '目标页面尚未加载 QwQNT MCP preload，无法发送 IPC')
    }

    const mode: IpcDispatchMode = options.mode === 'invoke' ? 'invoke' : 'send'
    const args = options.args ?? []
    if (args.length > MAX_IPC_ARGS) {
      throw new ToolError('INVALID_ARGUMENT', `IPC 参数不能超过 ${MAX_IPC_ARGS} 项`)
    }

    try {
      structuredClone(args)
    } catch {
      throw new ToolError('INVALID_ARGUMENT', 'IPC 参数无法进行 structured clone')
    }
    if (estimateStructuredCloneSize(args) > MAX_IPC_ARGS_BYTES) {
      throw new ToolError('INVALID_ARGUMENT', `IPC 参数超过大小限制：${MAX_IPC_ARGS_BYTES} bytes`)
    }

    const requestId = randomUUID()
    const request: IpcDispatchRequest = {
      requestId,
      mode,
      channel,
      args,
    }

    const webContentsId = win.webContents.id

    const value = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new ToolError('TIMEOUT', `操作超时（${IPC_DISPATCH_TIMEOUT_MS} ms）`))
      }, IPC_DISPATCH_TIMEOUT_MS)

      pending.set(requestId, {
        resolve,
        reject,
        webContentsId,
        timer,
      })

      try {
        if (win.isDestroyed() || win.webContents.isDestroyed()) {
          clearTimeout(timer)
          pending.delete(requestId)
          reject(new ToolError('PAGE_NOT_FOUND', `未找到页面：${pageId}`))
          return
        }
        win.webContents.send(CHANNEL_DISPATCH, request)
      } catch (err) {
        clearTimeout(timer)
        pending.delete(requestId)
        reject(new ToolError('IPC_ERROR', `IPC 调用失败：${err instanceof Error ? err.message : String(err)}`))
      }
    })

    if (mode === 'invoke') {
      return normalizeValue(value)
    }
    return value
  }

  return {
    dispatchIpc,
    dispose(): void {
      for (const [, entry] of pending) {
        clearTimeout(entry.timer)
        entry.reject(new ToolError('IPC_ERROR', 'IPC bridge 已关闭'))
      }
      pending.clear()
      ipcMain.removeListener?.(CHANNEL_PRELOAD_READY, onReady as (...args: unknown[]) => void)
      ipcMain.removeListener?.(CHANNEL_DISPATCH_RESULT, onResult as (...args: unknown[]) => void)
    },
  }
}
