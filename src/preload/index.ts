import { ipcRenderer } from 'electron'
import {
  CHANNEL_DISPATCH,
  CHANNEL_DISPATCH_RESULT,
  CHANNEL_PING_READY,
  CHANNEL_PRELOAD_READY,
  type IpcDispatchRequest,
  type IpcDispatchResult,
} from '../shared/ipc'

function serializeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name || 'Error',
      message: error.message || String(error),
      stack: error.stack,
    }
  }
  return { name: 'Error', message: String(error) }
}

const MAX_IPC_RESULT_DEPTH = 32
const MAX_IPC_RESULT_ENTRIES = 10_000
const MAX_IPC_RESULT_STRING = 200_000

/**
 * 与主进程 execute_javascript 相同的 JSON 归一化（精简版，运行在 preload/renderer 侧）。
 */
function normalizeForIpc(input: unknown): unknown {
  if (input === undefined || input === null) return null
  if (typeof input === 'string') {
    return input.length > MAX_IPC_RESULT_STRING ? `${input.slice(0, MAX_IPC_RESULT_STRING)}…` : input
  }
  const t = typeof input
  if (t !== 'object') return input

  if (input instanceof Error) {
    return { name: input.name || 'Error', message: input.message || String(input) }
  }

  // DOM Node
  if (typeof (input as Node).nodeName === 'string' && 'outerHTML' in (input as object)) {
    try {
      const outerHTML = (input as Element).outerHTML ?? null
      return {
        nodeName: (input as Node).nodeName,
        outerHTML:
          typeof outerHTML === 'string' && outerHTML.length > MAX_IPC_RESULT_STRING
            ? `${outerHTML.slice(0, MAX_IPC_RESULT_STRING)}…`
            : outerHTML,
      }
    } catch {
      return { nodeName: (input as Node).nodeName, outerHTML: null }
    }
  }

  const seen = new WeakSet<object>()
  const walk = (v: unknown, depth: number): unknown => {
    if (v === undefined || v === null) return v
    if (depth > MAX_IPC_RESULT_DEPTH) return '[DepthLimit]'
    const tt = typeof v
    if (typeof v === 'string') return v.length > MAX_IPC_RESULT_STRING ? `${v.slice(0, MAX_IPC_RESULT_STRING)}…` : v
    if (tt !== 'object') return v
    if (v instanceof Error) return { name: v.name || 'Error', message: v.message || String(v) }
    const obj = v as object
    if (seen.has(obj)) return '[Circular]'
    seen.add(obj)
    if (Array.isArray(v)) {
      const out = v.slice(0, MAX_IPC_RESULT_ENTRIES).map((item) => walk(item, depth + 1))
      if (v.length > MAX_IPC_RESULT_ENTRIES) out.push('[EntryLimit]')
      return out
    }
    const out: Record<string, unknown> = {}
    let count = 0
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (count >= MAX_IPC_RESULT_ENTRIES) {
        out.__truncated = true
        break
      }
      out[k] = walk(val, depth + 1)
      count += 1
    }
    return out
  }
  return walk(input, 0)
}

function reply(result: IpcDispatchResult): void {
  ipcRenderer.send(CHANNEL_DISPATCH_RESULT, result)
}

ipcRenderer.on(CHANNEL_DISPATCH, async (_event, raw: IpcDispatchRequest) => {
  const request = raw
  if (!request || typeof request.requestId !== 'string') return

  try {
    if (request.mode === 'send') {
      ipcRenderer.send(request.channel, ...(request.args ?? []))
      reply({ requestId: request.requestId, ok: true, value: { sent: true } })
      return
    }

    if (request.mode === 'invoke') {
      const value = await ipcRenderer.invoke(request.channel, ...(request.args ?? []))
      reply({
        requestId: request.requestId,
        ok: true,
        value: normalizeForIpc(value),
      })
      return
    }

    reply({
      requestId: request.requestId,
      ok: false,
      error: { name: 'Error', message: `未知 mode：${String((request as IpcDispatchRequest).mode)}` },
    })
  } catch (error) {
    reply({
      requestId: request.requestId,
      ok: false,
      error: serializeError(error),
    })
  }
})

// 立即通知；并短时重试，覆盖主进程晚于 preload 启动的竞态
function announceReady(): void {
  ipcRenderer.send(CHANNEL_PRELOAD_READY)
}

announceReady()
ipcRenderer.on(CHANNEL_PING_READY, () => {
  announceReady()
})
let readyRetries = 0
const readyTimer = setInterval(() => {
  readyRetries += 1
  announceReady()
  if (readyRetries >= 20) {
    clearInterval(readyTimer)
  }
}, 1500)
