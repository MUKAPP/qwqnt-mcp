export type ValueType =
  | 'undefined'
  | 'null'
  | 'boolean'
  | 'number'
  | 'string'
  | 'bigint'
  | 'array'
  | 'object'
  | 'function'
  | 'symbol'

export interface NormalizedValue {
  valueType: ValueType
  value: unknown
}
const MAX_NORMALIZE_DEPTH = 32
const MAX_NORMALIZE_ENTRIES = 10_000
const MAX_NORMALIZE_STRING_CHARS = 200_000

export interface SerializedError {
  name: string
  message: string
  stack?: string
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name || 'Error',
      message: error.message || String(error),
      stack: error.stack,
    }
  }
  return {
    name: 'Error',
    message: String(error),
  }
}

/**
 * 将任意值归一化为可 JSON 传输的结构。
 * 循环引用 → "[Circular]"；Error → {name,message,stack}；
 * DOM Node（有 nodeName/outerHTML）→ {nodeName,outerHTML}。
 */
export function normalizeValue(input: unknown): NormalizedValue {
  if (input === undefined) {
    return { valueType: 'undefined', value: null }
  }
  if (input === null) {
    return { valueType: 'null', value: null }
  }

  if (typeof input === 'string') {
    return {
      valueType: 'string',
      value: input.length > MAX_NORMALIZE_STRING_CHARS ? `${input.slice(0, MAX_NORMALIZE_STRING_CHARS)}…` : input,
    }
  }
  const t = typeof input
  if (t === 'number' || t === 'boolean') return { valueType: t, value: input }
  if (t === 'bigint') return { valueType: 'bigint', value: String(input) }
  if (t === 'function') return { valueType: 'function', value: String(input) }
  if (t === 'symbol') return { valueType: 'symbol', value: String(input) }

  if (input instanceof Error) {
    const serialized = serializeError(input)
    return {
      valueType: 'object',
      value: { name: serialized.name, message: serialized.message },
    }
  }

  // 可能是 DOM Node（主进程侧不会出现，但 IPC 回传/页面结果会）
  if (isDomNodeLike(input)) {
    const html = safeOuterHtml(input)
    return {
      valueType: 'object',
      value: {
        nodeName: (input as { nodeName: string }).nodeName,
        outerHTML:
          html && html.length > MAX_NORMALIZE_STRING_CHARS
            ? `${html.slice(0, MAX_NORMALIZE_STRING_CHARS)}…`
            : html,
      },
    }
  }

  const seen = new WeakSet<object>()
  const valueType: ValueType = Array.isArray(input) ? 'array' : 'object'
  return {
    valueType,
    value: deepNormalize(input, seen, 0),
  }
}

function isDomNodeLike(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return typeof obj.nodeName === 'string' && 'outerHTML' in obj
}

function safeOuterHtml(value: unknown): string | null {
  try {
    const html = (value as { outerHTML?: unknown }).outerHTML
    return typeof html === 'string' ? html : null
  } catch {
    return null
  }
}

function deepNormalize(input: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (input === undefined || input === null) return input
  if (depth > MAX_NORMALIZE_DEPTH) return '[DepthLimit]'
  const t = typeof input
  if (typeof input === 'string') {
    return input.length > MAX_NORMALIZE_STRING_CHARS ? `${input.slice(0, MAX_NORMALIZE_STRING_CHARS)}…` : input
  }
  if (t === 'bigint' || t === 'function' || t === 'symbol') return String(input)
  if (t !== 'object') return input

  if (input instanceof Error) {
    const serialized = serializeError(input)
    return { name: serialized.name, message: serialized.message }
  }

  if (isDomNodeLike(input)) {
    const html = safeOuterHtml(input)
    return {
      nodeName: (input as { nodeName: string }).nodeName,
      outerHTML:
        html && html.length > MAX_NORMALIZE_STRING_CHARS
          ? `${html.slice(0, MAX_NORMALIZE_STRING_CHARS)}…`
          : html,
    }
  }

  const obj = input as object
  if (seen.has(obj)) return '[Circular]'
  seen.add(obj)

  if (Array.isArray(input)) {
    const out = input
      .slice(0, MAX_NORMALIZE_ENTRIES)
      .map((item) => deepNormalize(item, seen, depth + 1))
    if (input.length > MAX_NORMALIZE_ENTRIES) out.push('[EntryLimit]')
    return out
  }

  const out: Record<string, unknown> = {}
  let count = 0
  for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
    if (count >= MAX_NORMALIZE_ENTRIES) {
      out.__truncated = true
      break
    }
    out[key] = deepNormalize(val, seen, depth + 1)
    count += 1
  }
  return out
}
