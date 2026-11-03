export type ConsoleLevel = 'debug' | 'info' | 'warning' | 'error' | 'unknown'

export interface ConsoleLogEntry {
  sequence: number
  pageId: number
  webContentsId: number
  level: ConsoleLevel
  message: string
  line?: number
  sourceId?: string
  timestamp: number
}

export interface NetworkEntry {
  sequence: number
  pageId: number
  webContentsId: number
  requestId: string
  url: string
  method: string
  statusCode?: number
  resourceType?: string
  fromCache?: boolean
  error?: string
  timestamp: number
}

export interface PageObservability {
  noteConsole(entry: Omit<ConsoleLogEntry, 'timestamp' | 'sequence'> & { timestamp?: number }): void
  noteNetwork(entry: Omit<NetworkEntry, 'timestamp' | 'sequence'> & { timestamp?: number }): void
  getConsoleLogs(options: {
    pageId?: number
    level?: ConsoleLevel
    after?: number
    limit?: number
    clear?: boolean
  }): ConsoleLogEntry[]
  getNetworkLogs(options: {
    pageId?: number
    after?: number
    limit?: number
    clear?: boolean
  }): NetworkEntry[]
  clearPage(pageId: number): void
  dispose(): void
}

const DEFAULT_LIMIT = 100
const MAX_BUFFER = 500
const MAX_BUFFER_BYTES = 2_000_000
const MAX_MESSAGE_CHARS = 8_192
const MAX_SOURCE_CHARS = 2_048
const MAX_URL_CHARS = 4_096
const MAX_ERROR_CHARS = 1_024

function clipText(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value)
    url.search = ''
    url.hash = ''
    return clipText(url.toString(), MAX_URL_CHARS)
  } catch {
    return clipText(value.split(/[?#]/, 1)[0] ?? value, MAX_URL_CHARS)
  }
}
function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_LIMIT
  return Math.min(Math.max(Math.floor(limit), 1), MAX_BUFFER)
}

function createLogBuffer<T extends { pageId: number }>() {
  const entries: Array<{ value: T; bytes: number }> = []
  let contentBytes = 0

  function removeWhere(matches: (value: T) => boolean): void {
    let kept = 0
    for (const entry of entries) {
      if (matches(entry.value)) {
        contentBytes -= entry.bytes
      } else {
        entries[kept++] = entry
      }
    }
    entries.length = kept
  }

  return {
    push(value: T): void {
      const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
      entries.push({ value, bytes })
      contentBytes += bytes
      // 数组编码还包含方括号及条目之间的逗号。
      while (
        entries.length > MAX_BUFFER ||
        contentBytes + Math.max(0, entries.length - 1) + 2 > MAX_BUFFER_BYTES
      ) {
        contentBytes -= entries.shift()!.bytes
      }
    },

    read(matches: (value: T) => boolean, limit: number, clear: boolean): T[] {
      const out = entries
        .filter((entry) => matches(entry.value))
        .slice(-limit)
        .map((entry) => entry.value)
      if (clear) {
        const consumed = new Set(out)
        removeWhere((value) => consumed.has(value))
      }
      return out
    },

    clearPage(pageId: number): void {
      removeWhere((value) => value.pageId === pageId)
    },

    clear(): void {
      entries.length = 0
      contentBytes = 0
    },
  }
}

export function createPageObservability(): PageObservability {
  const consoleLogs = createLogBuffer<ConsoleLogEntry>()
  const networkLogs = createLogBuffer<NetworkEntry>()
  let nextSequence = 0

  return {
    noteConsole(entry): void {
      consoleLogs.push({
        sequence: ++nextSequence,
        ...entry,
        message: clipText(entry.message, MAX_MESSAGE_CHARS),
        sourceId: entry.sourceId ? clipText(entry.sourceId, MAX_SOURCE_CHARS) : undefined,
        timestamp: entry.timestamp ?? Date.now(),
      })
    },

    noteNetwork(entry): void {
      networkLogs.push({
        sequence: ++nextSequence,
        ...entry,
        url: redactUrl(entry.url),
        method: clipText(entry.method, 32),
        resourceType: entry.resourceType ? clipText(entry.resourceType, 64) : undefined,
        error: entry.error ? clipText(entry.error, MAX_ERROR_CHARS) : undefined,
        timestamp: entry.timestamp ?? Date.now(),
      })
    },

    getConsoleLogs(options): ConsoleLogEntry[] {
      return consoleLogs.read(
        (entry) =>
          (options.pageId === undefined || entry.pageId === options.pageId) &&
          (options.level === undefined || entry.level === options.level) &&
          (options.after === undefined || entry.sequence > options.after),
        clampLimit(options.limit),
        options.clear === true,
      )
    },

    getNetworkLogs(options): NetworkEntry[] {
      return networkLogs.read(
        (entry) =>
          (options.pageId === undefined || entry.pageId === options.pageId) &&
          (options.after === undefined || entry.sequence > options.after),
        clampLimit(options.limit),
        options.clear === true,
      )
    },

    clearPage(pageId: number): void {
      consoleLogs.clearPage(pageId)
      networkLogs.clearPage(pageId)
    },

    dispose(): void {
      consoleLogs.clear()
      networkLogs.clear()
    },
  }
}

/** Electron console-message level 数字 → 名称（兼容旧签名） */
export function mapConsoleLevel(level: unknown): ConsoleLevel {
  if (typeof level === 'string') {
    const s = level.toLowerCase()
    if (s === 'debug' || s === 'info' || s === 'warning' || s === 'error') return s
    if (s === 'warn') return 'warning'
    if (s === 'log' || s === 'verbose') return 'info'
    return 'unknown'
  }
  if (typeof level === 'number') {
    // Electron: 0=debug/verbose, 1=info, 2=warning, 3=error
    if (level <= 0) return 'debug'
    if (level === 1) return 'info'
    if (level === 2) return 'warning'
    if (level >= 3) return 'error'
  }
  return 'unknown'
}

/**
 * 解析 console-message 回调参数（兼容 event 对象签名与位置参数签名）。
 */
export function parseConsoleMessageArgs(args: unknown[]): {
  level: ConsoleLevel
  message: string
  line?: number
  sourceId?: string
} {
  // 新签名：event 上带 level/message 或 details 对象
  const first = args[0]
  if (first && typeof first === 'object') {
    const obj = first as Record<string, unknown>
    if (typeof obj.message === 'string' || typeof obj.level === 'number' || typeof obj.level === 'string') {
      return {
        level: mapConsoleLevel(obj.level),
        message: String(obj.message ?? ''),
        line: typeof obj.lineNumber === 'number' ? obj.lineNumber : typeof obj.line === 'number' ? obj.line : undefined,
        sourceId:
          typeof obj.sourceId === 'string'
            ? obj.sourceId
            : typeof obj.sourceURL === 'string'
              ? obj.sourceURL
              : undefined,
      }
    }
  }

  // 旧签名：(event, level, message, line, sourceId)
  return {
    level: mapConsoleLevel(args[1]),
    message: String(args[2] ?? ''),
    line: typeof args[3] === 'number' ? args[3] : undefined,
    sourceId: typeof args[4] === 'string' ? args[4] : undefined,
  }
}
