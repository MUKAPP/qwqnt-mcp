import { describe, expect, it } from 'vitest'
import {
  buildClickScript,
  buildPressKeyScript,
  buildQuerySelectorScript,
  buildTypeTextScript,
  buildWaitConditionScript,
} from '../src/main/page-actions'

describe('page-actions scripts', () => {
  it('query/click/type/press/wait 使用 JSON.stringify 嵌入参数', () => {
    const selector = 'button.foo"bar'
    expect(buildQuerySelectorScript(selector, true)).toContain(JSON.stringify(selector))
    expect(buildClickScript(selector, { button: 'right', clickCount: 2 })).toContain(
      JSON.stringify(selector),
    )
    expect(buildTypeTextScript(selector, 'hello"world', { clear: true })).toContain(
      JSON.stringify('hello"world'),
    )
    expect(buildPressKeyScript('Enter', { selector })).toContain(JSON.stringify('Enter'))
    expect(
      buildWaitConditionScript({ selector, urlIncludes: '/main', expression: 'true' }),
    ).toContain(JSON.stringify('/main'))
  })

  it('点击包含双击事件，按键区分字母和数字 code', () => {
    expect(buildClickScript('#ok', { clickCount: 2 })).toContain("new MouseEvent('dblclick'")
    const keyScript = buildPressKeyScript('1', {})
    expect(keyScript).toContain("'Digit' + key")
  })

  it('文本输入拒绝不可编辑元素', () => {
    expect(buildTypeTextScript('#label', 'text', {})).toContain('目标元素不可编辑')
  })
})
