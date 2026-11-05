export type ToolErrorCode =
  | 'PAGE_NOT_FOUND'
  | 'ELEMENT_NOT_FOUND'
  | 'TIMEOUT'
  | 'PAGE_NOT_READY'
  | 'INVALID_ARGUMENT'
  | 'OUTPUT_LIMIT'
  | 'SCRIPT_ERROR'
  | 'IPC_ERROR'
  | 'INTERNAL_ERROR'

export const TOOL_ERROR_CODES: readonly ToolErrorCode[] = [
  'PAGE_NOT_FOUND',
  'ELEMENT_NOT_FOUND',
  'TIMEOUT',
  'PAGE_NOT_READY',
  'INVALID_ARGUMENT',
  'OUTPUT_LIMIT',
  'SCRIPT_ERROR',
  'IPC_ERROR',
  'INTERNAL_ERROR',
]

const RETRYABLE_CODES = new Set<ToolErrorCode>(['TIMEOUT', 'PAGE_NOT_READY'])

/** 带机器可读错误码的工具错误；message 原样返回给 MCP 客户端 */
export class ToolError extends Error {
  readonly code: ToolErrorCode
  readonly retryable: boolean

  constructor(code: ToolErrorCode, message: string, retryable = RETRYABLE_CODES.has(code)) {
    super(message)
    this.name = 'ToolError'
    this.code = code
    this.retryable = retryable
  }
}

export function isToolErrorCode(value: unknown): value is ToolErrorCode {
  return typeof value === 'string' && (TOOL_ERROR_CODES as readonly string[]).includes(value)
}
