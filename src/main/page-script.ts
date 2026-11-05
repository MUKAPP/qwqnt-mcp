import type { ToolErrorCode } from './tool-error'

/**
 * 页面脚本统一包装：异步执行函数体，捕获异常并返回结构化错误。
 * Electron 的 executeJavaScript 在脚本抛错时只给出笼统的拒绝消息，
 * 因此在页面内捕获后以 __qwqntMcpError 回传原始错误名称和消息。
 */
export function buildPageScript(body: string): string {
  return `(async () => {
    function __qwqntMcpDescribeError(error) {
      let text;
      try {
        if (error && typeof error === 'object' && 'message' in error) {
          const name = typeof error.name === 'string' && error.name ? error.name : 'Error';
          text = name + ': ' + String(error.message);
        } else {
          text = String(error);
        }
      } catch (_) {
        text = '无法读取的异常';
      }
      return text.length > 4000 ? text.slice(0, 4000) + '…' : text;
    }
    try {
${body}
    } catch (__qwqntMcpCaught) {
      return {
        __qwqntMcpError: '页面脚本执行出错：' + __qwqntMcpDescribeError(__qwqntMcpCaught),
        __qwqntMcpErrorCode: 'SCRIPT_ERROR',
        __qwqntMcpErrorName: __qwqntMcpCaught && typeof __qwqntMcpCaught.name === 'string' ? __qwqntMcpCaught.name : 'Error',
      };
    }
  })()`
}

/** 生成页面内返回结构化错误的语句；message 为页面内 JS 表达式 */
export function pageErrorReturn(code: ToolErrorCode, messageExpression: string): string {
  return `return { __qwqntMcpError: ${messageExpression}, __qwqntMcpErrorCode: ${JSON.stringify(code)} };`
}

/**
 * 页面内结果归一化函数源码：在 renderer 内把任意值转换成可结构化克隆的 JSON 值，
 * 再交给 Electron 回传。返回 { __qwqntMcpValueType, __qwqntMcpValue }。
 * DOM 元素 → { nodeName, outerHTML }；Date → ISO 字符串；Map → 键值对数组；
 * Set / NodeList / HTMLCollection → 数组；函数 / symbol / bigint → 字符串。
 */
export const PAGE_NORMALIZE_SOURCE = `
    function __qwqntMcpNormalize(input) {
      const MAX_DEPTH = 32;
      const MAX_ENTRIES = 10000;
      const MAX_STRING = 200000;
      const seen = new WeakSet();
      const clip = (s) => (s.length > MAX_STRING ? s.slice(0, MAX_STRING) + '…' : s);
      const isNode = (v) => typeof Node !== 'undefined' && v instanceof Node;
      const isNodeCollection = (v) =>
        (typeof NodeList !== 'undefined' && v instanceof NodeList) ||
        (typeof HTMLCollection !== 'undefined' && v instanceof HTMLCollection);

      function convertList(items, depth) {
        const out = [];
        let count = 0;
        for (const item of items) {
          if (count >= MAX_ENTRIES) {
            out.push('[EntryLimit]');
            break;
          }
          out.push(convert(item, depth + 1));
          count += 1;
        }
        return out;
      }

      function convert(v, depth) {
        if (v === null || v === undefined) return v;
        const t = typeof v;
        if (t === 'string') return clip(v);
        if (t === 'number') return Number.isFinite(v) ? v : String(v);
        if (t === 'boolean') return v;
        if (t === 'bigint' || t === 'symbol') return String(v);
        if (t === 'function') return clip(String(v));
        if (depth > MAX_DEPTH) return '[DepthLimit]';
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
        if (v instanceof Error) {
          return { name: v.name || 'Error', message: String(v.message) };
        }
        if (v instanceof Date) {
          return Number.isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString();
        }
        if (v instanceof RegExp) return String(v);
        if (isNode(v)) {
          if (typeof v.outerHTML === 'string') {
            return { nodeName: v.nodeName, outerHTML: clip(v.outerHTML) };
          }
          const text = v.textContent;
          return typeof text === 'string'
            ? { nodeName: v.nodeName, textContent: clip(text) }
            : { nodeName: v.nodeName };
        }
        if (v instanceof Map) {
          return convertList(Array.from(v.entries()), depth);
        }
        if (v instanceof Set || isNodeCollection(v) || Array.isArray(v)) {
          return convertList(Array.from(v), depth);
        }
        const out = {};
        let keys;
        try {
          keys = Object.keys(v);
        } catch (_) {
          return String(v);
        }
        for (let i = 0; i < keys.length; i++) {
          if (i >= MAX_ENTRIES) {
            out.__truncated = true;
            break;
          }
          const key = keys[i];
          try {
            out[key] = convert(v[key], depth + 1);
          } catch (_) {
            out[key] = '[Unreadable]';
          }
        }
        return out;
      }

      function rootType(v) {
        if (v === undefined) return 'undefined';
        if (v === null) return 'null';
        const t = typeof v;
        if (t !== 'object') return t;
        if (v instanceof Date || v instanceof RegExp) return 'string';
        if (Array.isArray(v) || v instanceof Map || v instanceof Set || isNodeCollection(v)) return 'array';
        return 'object';
      }

      const value = convert(input, 0);
      return {
        __qwqntMcpValueType: rootType(input),
        __qwqntMcpValue: value === undefined ? null : value,
      };
    }
`
