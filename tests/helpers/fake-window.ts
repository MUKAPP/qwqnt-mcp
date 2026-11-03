import type {
  CaptureRect,
  CapturedImage,
  PageWindow,
  PageWebContents,
} from '../../src/main/page-service'
import type { IpcEventLike, IpcMainLike } from '../../src/main/ipc-bridge'
import {
  CHANNEL_DISPATCH,
  CHANNEL_DISPATCH_RESULT,
  CHANNEL_PRELOAD_READY,
  type IpcDispatchRequest,
} from '../../src/shared/ipc'

type Listener = (...args: unknown[]) => void

export class FakeWebContents implements PageWebContents {
  id: number
  private destroyed = false
  private url: string
  private title: string
  listeners = new Map<string, Set<Listener>>()
  executeHandler?: (code: string) => Promise<unknown>
  captureHandler?: (rect?: CaptureRect) => Promise<CapturedImage>
  /** 模拟 preload：收到 dispatch 后自动回执 */
  autoPreload = false
  private ipcMain?: FakeIpcMain

  constructor(id: number, opts?: { url?: string; title?: string }) {
    this.id = id
    this.url = opts?.url ?? 'https://qq.example/chat'
    this.title = opts?.title ?? 'QQ'
  }

  bindIpcMain(ipcMain: FakeIpcMain): void {
    this.ipcMain = ipcMain
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
    this.emit('render-process-gone')
  }

  getURL(): string {
    return this.url
  }

  setURL(url: string): void {
    this.url = url
  }

  getTitle(): string {
    return this.title
  }

  setTitle(title: string): void {
    this.title = title
  }

  async executeJavaScript(code: string): Promise<unknown> {
    if (this.destroyed) throw new Error('webContents destroyed')
    if (this.executeHandler) return this.executeHandler(code)
    if (code.includes('document.title') || code.includes('"document.title"')) {
      return this.title
    }
    return null
  }

  async capturePage(rect?: CaptureRect): Promise<CapturedImage> {
    if (this.destroyed) throw new Error('webContents destroyed')
    if (this.captureHandler) return this.captureHandler(rect)
    // 1x1 透明 PNG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    const width = rect?.width && rect.width > 0 ? Math.floor(rect.width) : 1
    const height = rect?.height && rect.height > 0 ? Math.floor(rect.height) : 1
    return {
      toPNG: () => png,
      getSize: () => ({ width, height }),
      isEmpty: () => false,
    }
  }

  send(channel: string, ...args: unknown[]): void {
    if (this.destroyed) throw new Error('webContents destroyed')
    if (channel === CHANNEL_DISPATCH && this.autoPreload && this.ipcMain) {
      const request = args[0] as IpcDispatchRequest
      queueMicrotask(() => {
        if (request.mode === 'send') {
          this.ipcMain!.emitFrom(this.id, CHANNEL_DISPATCH_RESULT, {
            requestId: request.requestId,
            ok: true,
            value: { sent: true },
          })
        } else {
          this.ipcMain!.emitFrom(this.id, CHANNEL_DISPATCH_RESULT, {
            requestId: request.requestId,
            ok: true,
            value: { invokeEcho: request.args },
          })
        }
      })
    }
    this.emit(`send:${channel}`, ...args)
  }

  on(event: string, listener: Listener): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(listener)
  }

  emit(event: string, ...args: unknown[]): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const listener of set) listener(...args)
  }

  simulateFullLoadStart(): void {
    this.emit('did-start-loading')
  }
}

export class FakeWindow implements PageWindow {
  id: number
  webContents: FakeWebContents
  private destroyed = false
  private visible: boolean
  private focused: boolean
  private title: string
  private listeners = new Map<string, Set<Listener>>()

  constructor(
    id: number,
    opts?: {
      url?: string
      title?: string
      visible?: boolean
      focused?: boolean
      webContentsId?: number
    },
  ) {
    this.id = id
    this.title = opts?.title ?? `Window ${id}`
    this.visible = opts?.visible ?? true
    this.focused = opts?.focused ?? false
    this.webContents = new FakeWebContents(opts?.webContentsId ?? id + 1000, {
      url: opts?.url,
      title: this.title,
    })
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  destroy(): void {
    this.destroyed = true
    this.webContents.destroy()
    this.emit('closed')
  }

  isVisible(): boolean {
    return this.visible
  }

  isFocused(): boolean {
    return this.focused
  }

  getTitle(): string {
    return this.title
  }

  on(event: string, listener: Listener): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(listener)
  }

  emit(event: string, ...args: unknown[]): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const listener of set) listener(...args)
  }
}

export class FakeIpcMain implements IpcMainLike {
  private listeners = new Map<string, Set<(event: IpcEventLike, ...args: unknown[]) => void>>()

  on(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => void): void {
    if (!this.listeners.has(channel)) this.listeners.set(channel, new Set())
    this.listeners.get(channel)!.add(listener)
  }

  removeListener(channel: string, listener: (...args: unknown[]) => void): void {
    this.listeners
      .get(channel)
      ?.delete(listener as (event: IpcEventLike, ...args: unknown[]) => void)
  }

  emitFrom(webContentsId: number, channel: string, ...args: unknown[]): void {
    const event: IpcEventLike = { sender: { id: webContentsId } }
    const set = this.listeners.get(channel)
    if (!set) return
    for (const listener of set) listener(event, ...args)
  }

  simulatePreloadReady(webContentsId: number): void {
    this.emitFrom(webContentsId, CHANNEL_PRELOAD_READY)
  }
}

export function createWindowRegistry(initial: FakeWindow[] = []) {
  const windows = [...initial]
  return {
    windows,
    getAllWindows: () => windows.filter((w) => !w.isDestroyed()),
    add(win: FakeWindow) {
      windows.push(win)
    },
  }
}
