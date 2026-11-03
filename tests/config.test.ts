import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_PORT,
  generateToken,
  loadConfigFromRoot,
  MIN_TOKEN_LENGTH,
  normalizeConfig,
} from '../src/main/config'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qwqnt-mcp-config-'))
  tempDirs.push(dir)
  return dir
}

describe('normalizeConfig', () => {
  it('非法对象回写默认端口与新 token', () => {
    const { config, rewritten } = normalizeConfig(null)
    expect(rewritten).toBe(true)
    expect(config.port).toBe(DEFAULT_PORT)
    expect(config.token.length).toBeGreaterThanOrEqual(MIN_TOKEN_LENGTH)
  })

  it('端口越界时回写默认端口并保留合法 token', () => {
    const token = generateToken()
    const { config, rewritten } = normalizeConfig({ port: 80, token })
    expect(rewritten).toBe(true)
    expect(config.port).toBe(DEFAULT_PORT)
    expect(config.token).toBe(token)
  })

  it('token 过短时重新生成并保留合法端口', () => {
    const { config, rewritten } = normalizeConfig({ port: 19000, token: 'short' })
    expect(rewritten).toBe(true)
    expect(config.port).toBe(19000)
    expect(config.token.length).toBeGreaterThanOrEqual(MIN_TOKEN_LENGTH)
    expect(config.token).not.toBe('short')
  })

  it('合法配置不改写', () => {
    const token = generateToken()
    const { config, rewritten } = normalizeConfig({ port: 20000, token })
    expect(rewritten).toBe(false)
    expect(config).toEqual({ port: 20000, token })
  })
})

describe('loadConfigFromRoot', () => {
  it('首次启动创建默认配置文件', () => {
    const root = tempRoot()
    const { config, configPath } = loadConfigFromRoot(root)
    expect(config.port).toBe(DEFAULT_PORT)
    expect(config.token.length).toBe(64)
    const disk = JSON.parse(readFileSync(configPath, 'utf-8')) as { port: number; token: string }
    expect(disk.port).toBe(config.port)
    expect(disk.token).toBe(config.token)
  })

  it('非法已有配置会被安全归一化并回写', () => {
    const root = tempRoot()
    const first = loadConfigFromRoot(root)
    writeFileSync(first.configPath, JSON.stringify({ port: 1, token: 'x' }), 'utf-8')
    const second = loadConfigFromRoot(root)
    expect(second.config.port).toBe(DEFAULT_PORT)
    expect(second.config.token.length).toBeGreaterThanOrEqual(MIN_TOKEN_LENGTH)
    const disk = JSON.parse(readFileSync(second.configPath, 'utf-8')) as {
      port: number
      token: string
    }
    expect(disk.port).toBe(DEFAULT_PORT)
    expect(disk.token).toBe(second.config.token)
  })
})
