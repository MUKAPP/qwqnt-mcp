/**
 * 页面交互脚本构建器。
 * selector / text / key 等一律 JSON.stringify 嵌入，禁止字符串拼接。
 */

export type MouseButton = 'left' | 'middle' | 'right'

export interface ElementInfo {
  selector: string
  exists: boolean
  count: number
  tagName?: string
  id?: string
  className?: string
  text?: string
  value?: string | null
  href?: string | null
  attributes?: Record<string, string>
  boundingRect?: {
    x: number
    y: number
    width: number
    height: number
    top: number
    left: number
    bottom: number
    right: number
  }
  visible?: boolean
  enabled?: boolean
}

/** 查询元素信息（exists/text/rect/可见性等） */
export function buildQuerySelectorScript(selector: string, all: boolean): string {
  const selectorLiteral = JSON.stringify(selector)
  const allLiteral = JSON.stringify(all)
  return `(() => {
    const selector = ${selectorLiteral};
    const all = ${allLiteral};

    function isVisible(el) {
      if (!el || !(el instanceof Element)) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function describe(el) {
      const rect = el.getBoundingClientRect();
      const attrs = {};
      for (const attr of el.attributes) {
        attrs[attr.name] = attr.value;
      }
      let value = null;
      if ('value' in el) {
        value = el.value;
      }
      const disabled = el.disabled === true || el.getAttribute('disabled') !== null || el.getAttribute('aria-disabled') === 'true';
      return {
        selector,
        exists: true,
        count: 1,
        tagName: el.tagName.toLowerCase(),
        id: el.id || undefined,
        className: typeof el.className === 'string' ? el.className : undefined,
        text: (el.innerText || el.textContent || '').trim().slice(0, 500),
        value,
        href: el.href || el.getAttribute('href'),
        attributes: attrs,
        boundingRect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          top: rect.top,
          left: rect.left,
          bottom: rect.bottom,
          right: rect.right,
        },
        visible: isVisible(el),
        enabled: !disabled,
      };
    }

    const nodes = Array.from(document.querySelectorAll(selector));
    if (nodes.length === 0) {
      return { selector, exists: false, count: 0, elements: all ? [] : undefined };
    }
    if (all) {
      return {
        selector,
        exists: true,
        count: nodes.length,
        elements: nodes.slice(0, 50).map(describe),
      };
    }
    const info = describe(nodes[0]);
    info.count = nodes.length;
    return info;
  })()`
}

/** 点击元素 */
export function buildClickScript(
  selector: string,
  options: { button?: MouseButton; clickCount?: number },
): string {
  const selectorLiteral = JSON.stringify(selector)
  const buttonLiteral = JSON.stringify(options.button ?? 'left')
  const clickCountLiteral = JSON.stringify(options.clickCount ?? 1)
  return `(() => {
    const selector = ${selectorLiteral};
    const button = ${buttonLiteral};
    const clickCount = ${clickCountLiteral};
    const el = document.querySelector(selector);
    if (!el) {
      return { __qwqntMcpError: '页面中未找到选择器：' + selector };
    }
    if (typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    }
    if (typeof el.focus === 'function') {
      try { el.focus({ preventScroll: true }); } catch (_) { try { el.focus(); } catch (__) {} }
    }
    const rect = el.getBoundingClientRect();
    const clientX = rect.left + Math.min(Math.max(rect.width / 2, 1), Math.max(rect.width - 1, 1));
    const clientY = rect.top + Math.min(Math.max(rect.height / 2, 1), Math.max(rect.height - 1, 1));
    const buttonMap = { left: 0, middle: 1, right: 2 };
    const buttonId = buttonMap[button] ?? 0;
    const common = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY,
      button: buttonId,
      buttons: buttonId === 0 ? 1 : buttonId === 2 ? 2 : 4,
      detail: clickCount,
    };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...common, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mousedown', common));
    el.dispatchEvent(new PointerEvent('pointerup', { ...common, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseup', common));
    for (let i = 0; i < clickCount; i++) {
      el.dispatchEvent(new MouseEvent('click', { ...common, detail: i + 1 }));
    }
    if (clickCount === 2) {
      el.dispatchEvent(new MouseEvent('dblclick', { ...common, detail: 2 }));
    }
    if (button === 'right') {
      el.dispatchEvent(new MouseEvent('contextmenu', common));
    }
    return {
      ok: true,
      selector,
      tagName: el.tagName.toLowerCase(),
      boundingRect: {
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right,
      },
    };
  })()`
}

/** 在元素上输入文本 */
export function buildTypeTextScript(
  selector: string,
  text: string,
  options: { clear?: boolean; submit?: boolean },
): string {
  const selectorLiteral = JSON.stringify(selector)
  const textLiteral = JSON.stringify(text)
  const clearLiteral = JSON.stringify(options.clear !== false)
  const submitLiteral = JSON.stringify(options.submit === true)
  return `(() => {
    const selector = ${selectorLiteral};
    const text = ${textLiteral};
    const clear = ${clearLiteral};
    const submit = ${submitLiteral};
    const el = document.querySelector(selector);
    if (!el) {
      return { __qwqntMcpError: '页面中未找到选择器：' + selector };
    }
    if (typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    }
    if (typeof el.focus === 'function') {
      try { el.focus({ preventScroll: true }); } catch (_) { try { el.focus(); } catch (__) {} }
    }

    const isTextInput = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
    const isEditable = isTextInput || el.isContentEditable;
    if (!isEditable) {
      return { __qwqntMcpError: '目标元素不可编辑：仅支持 input、textarea 或 contenteditable' };
    }
    const proto = el instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const valueSetter = isTextInput ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : undefined;

    if (clear) {
      if (valueSetter) valueSetter.call(el, '');
      else el.textContent = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    if (el.isContentEditable) {
      if (clear) el.textContent = '';
      el.textContent = (el.textContent || '') + text;
    } else if (valueSetter) {
      valueSetter.call(el, clear ? text : String(el.value || '') + text);
    } else {
      return { __qwqntMcpError: '目标元素不可编辑' };
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));


    if (submit) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      const form = typeof el.form !== 'undefined' ? el.form : el.closest && el.closest('form');
      if (form && typeof form.requestSubmit === 'function') {
        try { form.requestSubmit(); } catch (_) {}
      }
    }

    return {
      ok: true,
      selector,
      value: 'value' in el ? el.value : (el.textContent || ''),
    };
  })()`
}

/** 按键；可选先 focus selector */
export function buildPressKeyScript(
  key: string,
  options: { selector?: string; modifiers?: string[] },
): string {
  const keyLiteral = JSON.stringify(key)
  const selectorLiteral = JSON.stringify(options.selector ?? null)
  const modifiersLiteral = JSON.stringify(options.modifiers ?? [])
  return `(() => {
    const key = ${keyLiteral};
    const selector = ${selectorLiteral};
    const modifiers = ${modifiersLiteral};
    let el = selector ? document.querySelector(selector) : document.activeElement;
    if (selector && !el) {
      return { __qwqntMcpError: '页面中未找到选择器：' + selector };
    }
    if (!el) el = document.body;
    if (typeof el.focus === 'function') {
      try { el.focus({ preventScroll: true }); } catch (_) { try { el.focus(); } catch (__) {} }
    }
    const codeMap = {
      Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace',
      Delete: 'Delete', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
      ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Home: 'Home', End: 'End',
      PageUp: 'PageUp', PageDown: 'PageDown', Space: 'Space',
    };
    const code = codeMap[key] || (key.length === 1 && /[a-z]/i.test(key)
      ? 'Key' + key.toUpperCase()
      : key.length === 1 && /[0-9]/.test(key)
        ? 'Digit' + key
        : key);
    const init = {
      key,
      code,
      bubbles: true,
      cancelable: true,
      ctrlKey: modifiers.includes('ctrl') || modifiers.includes('control'),
      altKey: modifiers.includes('alt'),
      shiftKey: modifiers.includes('shift'),
      metaKey: modifiers.includes('meta') || modifiers.includes('metaKey'),
    };
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keypress', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    return { ok: true, key, selector: selector || null };
  })()`
}

/**
 * 等待条件脚本：返回 true/false。
 * 支持 selector 出现、URL 包含、自定义 expression（间接 eval 为真）。
 */
export function buildWaitConditionScript(options: {
  selector?: string
  urlIncludes?: string
  expression?: string
  visible?: boolean
}): string {
  const selectorLiteral = JSON.stringify(options.selector ?? null)
  const urlIncludesLiteral = JSON.stringify(options.urlIncludes ?? null)
  const expressionLiteral = JSON.stringify(options.expression ?? null)
  const visibleLiteral = JSON.stringify(options.visible === true)
  return `(() => {
    const selector = ${selectorLiteral};
    const urlIncludes = ${urlIncludesLiteral};
    const expression = ${expressionLiteral};
    const requireVisible = ${visibleLiteral};

    if (urlIncludes != null) {
      if (!String(location.href).includes(urlIncludes)) return false;
    }
    if (selector != null) {
      const el = document.querySelector(selector);
      if (!el) return false;
      if (requireVisible) {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
      }
    }
    if (expression != null && expression !== '') {
      const __indirectEval = eval;
      const result = __indirectEval(expression);
      if (!result) return false;
    }
    return true;
  })()`
}
