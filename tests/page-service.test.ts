import { describe, expect, it } from 'vitest'
import { createPageService, buildSerializeHtmlScript, buildEvalScript } from '../src/main/page-service'
import { createPageObservability } from '../src/main/page-observability'
import { createWindowRegistry, FakeWindow } from './helpers/fake-window'

describe('PageService', () => {
  it('listPages 返回空列表为成功', () => {
    const registry = createWindowRegistry()
    const service = createPageService({ getAllWindows: registry.getAllWindows })
    expect(service.listPages()).toEqual([])
  })

  it('listPages 反映窗口状态与 ipcReady', () => {
    const win = new FakeWindow(1, { title: '主窗口', url: 'https://qq.test/', visible: true })
    // FakeWebContents title 与 window title 同步；与 URL 不同，应保留
    const registry = createWindowRegistry([win])
    const service = createPageService({ getAllWindows: registry.getAllWindows })
    service.registerWindow(win)

    let pages = service.listPages()
    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({
      id: 1,
      title: '主窗口',
      url: 'https://qq.test/',
      visible: true,
      ipcReady: false,
    })

    service.markIpcReady(win.webContents.id)
    pages = service.listPages()
    expect(pages[0]?.ipcReady).toBe(true)
  })

  it('requirePage 找不到时抛出中文错误', () => {
    const service = createPageService({ getAllWindows: () => [] })
    expect(() => service.requirePage(99)).toThrow('未找到页面：99')
  })

  it('窗口销毁后清除 ipcReady 和观测数据', () => {
    const win = new FakeWindow(2)
    const registry = createWindowRegistry([win])
    const observability = createPageObservability()
    const service = createPageService({ getAllWindows: registry.getAllWindows, observability })
    service.registerWindow(win)
    service.markIpcReady(win.webContents.id)
    observability.noteConsole({
      pageId: 2,
      webContentsId: win.webContents.id,
      level: 'info',
      message: 'before-close',
    })
    expect(service.isIpcReady(2)).toBe(true)
    win.destroy()
    expect(service.listPages()).toEqual([])
    expect(observability.getConsoleLogs({ pageId: 2 })).toHaveLength(0)
    expect(() => service.requirePage(2)).toThrow('未找到页面：2')
  })

  it('完整加载开始后清除 ipcReady', () => {
    const win = new FakeWindow(3)
    const registry = createWindowRegistry([win])
    const service = createPageService({ getAllWindows: registry.getAllWindows })
    service.registerWindow(win)
    service.markIpcReady(win.webContents.id)
    expect(service.isIpcReady(3)).toBe(true)
    win.webContents.emit('did-start-loading')
    expect(service.isIpcReady(3)).toBe(false)
  })
})

describe('脚本构建', () => {
  it('buildSerializeHtmlScript 使用 JSON.stringify 嵌入 selector', () => {
    const script = buildSerializeHtmlScript('div.foo"bar', true)
    expect(script).toContain(JSON.stringify('div.foo"bar'))
    expect(script).toContain('includeShadowDom = true')
  })

  it('buildEvalScript 使用 JSON.stringify 嵌入 expression', () => {
    const expr = '1 + 1; alert("x")'
    const script = buildEvalScript(expr)
    expect(script).toContain(JSON.stringify(expr))
    expect(script).toContain('__indirectEval')
  })
})
