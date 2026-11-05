/** 保留通道：preload 就绪通知 */
export const CHANNEL_PRELOAD_READY = 'qwqnt-mcp:preload-ready' as const

/** 保留通道：主进程 → preload 请求重新报告就绪（页面加载结束后仍未就绪时） */
export const CHANNEL_PING_READY = 'qwqnt-mcp:ping-ready' as const

/** 保留通道：主进程 → preload 调度 IPC */
export const CHANNEL_DISPATCH = 'qwqnt-mcp:dispatch' as const

/** 保留通道：preload → 主进程 调度结果 */
export const CHANNEL_DISPATCH_RESULT = 'qwqnt-mcp:dispatch-result' as const

export const RESERVED_CHANNEL_PREFIX = 'qwqnt-mcp:' as const

export type IpcDispatchMode = 'send' | 'invoke'

export interface SerializedError {
  name: string
  message: string
  stack?: string
}

export interface IpcDispatchRequest {
  requestId: string
  mode: IpcDispatchMode
  channel: string
  args: unknown[]
}

export interface IpcDispatchResult {
  requestId: string
  ok: boolean
  value?: unknown
  error?: SerializedError
}

export function isReservedChannel(channel: string): boolean {
  return channel.startsWith(RESERVED_CHANNEL_PREFIX)
}
