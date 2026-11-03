import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface McpConfig {
  port: number
  token: string
}

export const DEFAULT_PORT = 18765
export const MIN_PORT = 1024
export const MAX_PORT = 65535
export const MIN_TOKEN_LENGTH = 32

export function generateToken(): string {
  return randomBytes(32).toString('hex')
}

export function getConfigDir(configsRoot: string): string {
  return join(configsRoot, 'qwqnt-mcp')
}

export function getConfigPath(configsRoot: string): string {
  return join(getConfigDir(configsRoot), 'config.json')
}

function isValidPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT
}

function isValidToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= MIN_TOKEN_LENGTH
}

export function normalizeConfig(raw: unknown): { config: McpConfig; rewritten: boolean } {
  const base: McpConfig = {
    port: DEFAULT_PORT,
    token: generateToken(),
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { config: base, rewritten: true }
  }

  const obj = raw as Record<string, unknown>
  let rewritten = false
  let port = base.port
  let token = base.token

  if (isValidPort(obj.port)) {
    port = obj.port
  } else {
    rewritten = true
  }

  if (isValidToken(obj.token)) {
    token = obj.token
  } else {
    rewritten = true
  }

  // 仅当字段本身合法时保留；否则用安全默认（token 若需重写则重新生成，不沿用非法值）
  if (!isValidPort(obj.port) && !isValidToken(obj.token)) {
    return { config: base, rewritten: true }
  }

  if (!isValidPort(obj.port)) {
    port = DEFAULT_PORT
  }
  if (!isValidToken(obj.token)) {
    token = generateToken()
  }

  return { config: { port, token }, rewritten }
}

export function writeConfigFile(configPath: string, config: McpConfig): void {
  const dir = join(configPath, '..')
  mkdirSync(dir, { recursive: true })
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  })
}

/**
 * 从配置根目录加载 MCP 配置。
 * 首次启动创建目录并写入默认配置；字段非法时回写安全默认值。
 */
export function loadConfigFromRoot(configsRoot: string): { config: McpConfig; configPath: string } {
  const configPath = getConfigPath(configsRoot)
  const dir = getConfigDir(configsRoot)

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  if (!existsSync(configPath)) {
    const config: McpConfig = {
      port: DEFAULT_PORT,
      token: generateToken(),
    }
    writeConfigFile(configPath, config)
    return { config, configPath }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf-8'))
  } catch {
    const config: McpConfig = {
      port: DEFAULT_PORT,
      token: generateToken(),
    }
    writeConfigFile(configPath, config)
    return { config, configPath }
  }

  const { config, rewritten } = normalizeConfig(parsed)
  if (rewritten) {
    writeConfigFile(configPath, config)
  }
  return { config, configPath }
}

/**
 * 运行时入口：从 qwqnt.framework.paths.configs 加载。
 */
export function loadConfig(): { config: McpConfig; configPath: string } {
  const configsRoot = qwqnt.framework.paths.configs
  return loadConfigFromRoot(configsRoot)
}
