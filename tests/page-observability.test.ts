import { describe, expect, it } from 'vitest'
import {
  createPageObservability,
  mapConsoleLevel,
  parseConsoleMessageArgs,
} from '../src/main/page-observability'

describe('page-observability', () => {
  it('缓冲并按 pageId/level 过滤 console', () => {
    const obs = createPageObservability()
    obs.noteConsole({ pageId: 1, webContentsId: 10, level: 'info', message: 'a' })
    obs.noteConsole({ pageId: 1, webContentsId: 10, level: 'error', message: 'b' })
    obs.noteConsole({ pageId: 2, webContentsId: 20, level: 'error', message: 'c' })

    const errors = obs.getConsoleLogs({ pageId: 1, level: 'error', limit: 10 })
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toBe('b')

    const page1 = obs.getConsoleLogs({ pageId: 1, clear: true })
    expect(page1).toHaveLength(2)
    expect(obs.getConsoleLogs({ pageId: 1 })).toHaveLength(0)
    expect(obs.getConsoleLogs({ pageId: 2 })).toHaveLength(1)
  })

  it('缓冲网络摘要', () => {
    const obs = createPageObservability()
    obs.noteNetwork({
      pageId: 1,
      webContentsId: 10,
      requestId: '1',
      url: 'https://example.test/a',
      method: 'GET',
      statusCode: 200,
    })
    obs.noteNetwork({
      pageId: 1,
      webContentsId: 10,
      requestId: '2',
      url: 'https://example.test/b',
      method: 'POST',
      error: 'net::ERR',
    })
    const all = obs.getNetworkLogs({ pageId: 1, limit: 10 })
    expect(all).toHaveLength(2)
    expect(all[1]?.error).toBe('net::ERR')
    expect(all[1]?.sequence).toBeGreaterThan(all[0]?.sequence ?? 0)
    expect(obs.getNetworkLogs({ pageId: 1, after: all[1]!.sequence })).toHaveLength(0)
  })

  it('截断日志并移除网络 URL 的 query/fragment', () => {
    const obs = createPageObservability()
    obs.noteConsole({
      pageId: 1,
      webContentsId: 10,
      level: 'info',
      message: 'x'.repeat(9_000),
    })
    obs.noteNetwork({
      pageId: 1,
      webContentsId: 10,
      requestId: 'secret',
      url: 'https://example.test/api?token=secret#fragment',
      method: 'GET',
    })
    expect(obs.getConsoleLogs({ pageId: 1 })[0]?.message.length).toBe(8_193)
    expect(obs.getNetworkLogs({ pageId: 1 })[0]?.url).toBe('https://example.test/api')
  })

  it('解析 console-message 新旧签名', () => {
    expect(mapConsoleLevel(2)).toBe('warning')
    expect(mapConsoleLevel('error')).toBe('error')
    const modern = parseConsoleMessageArgs([{ level: 3, message: 'boom', lineNumber: 12 }])
    expect(modern).toMatchObject({ level: 'error', message: 'boom', line: 12 })
    const legacy = parseConsoleMessageArgs([{}, 1, 'hi', 3, 'file.js'])
    expect(legacy).toMatchObject({ level: 'info', message: 'hi', line: 3, sourceId: 'file.js' })
  })
})
