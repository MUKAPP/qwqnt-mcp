# qwqnt-mcp

QwQNT 插件：在 QQ 主进程内启动仅监听本机的 MCP Streamable HTTP 服务，给开发 Agent 提供 QQ 页面与 IPC 调试能力。

- 读取 QQ 窗口实时 HTML（含开放 Shadow DOM）
- 截取 QQ 页面当前画面（PNG）
- 查询元素、点击、输入、按键、等待条件
- 读取页面 console 与最近网络请求摘要
- 在指定页面执行 JavaScript
- 从目标渲染进程调用 `ipcRenderer.send` / `ipcRenderer.invoke`

## 能力概览

| MCP 工具 | 作用 | 只读 |
| --- | --- | --- |
| `list_pages` | 列出 `BrowserWindow`：`id/title/url/visible/focused/ipcReady` | 是 |
| `get_page_html` | 读取页面实时 DOM HTML，可选 CSS selector；超时默认 10 秒，响应最多 100 万字符 | 是 |
| `capture_page` | 截取页面当前画面，返回 PNG image content；区域和 PNG 大小有限制 | 是 |
| `query_selector` | 查询元素存在性/文本/属性/矩形/可见性；支持脚本超时 | 是 |
| `wait_for` | 等待 selector / URL / 表达式条件成立；表达式可能产生副作用 | 否 |
| `get_console_logs` | 读取缓冲的 console / 加载失败日志，内容有长度限制，支持 `after` cursor | 是 |
| `list_network` | 读取最近网络请求摘要（无 body，URL 默认移除 query/fragment，支持 `after` cursor） | 是 |
| `click` | 执行页面内合成点击，不是系统级真实鼠标输入 | 否 |
| `type_text` | 向 input/textarea/contenteditable 输入文本，使用页面内合成事件 | 否 |
| `press_key` | 发送页面内键盘合成事件，不是系统级真实键盘输入 | 否 |
| `execute_javascript` | 在页面全局上下文执行表达式并返回结果；默认不授予 user gesture | 否 |
| `send_ipc` | 从目标渲染进程发送/调用 IPC；返回结构按 mode 固定 | 否 |

服务端点：

```text
http://127.0.0.1:<port>/mcp
```

默认端口 `18765`。所有请求需要：

```http
Authorization: Bearer <token>
```

## 安装

### 从 Release 下载安装（推荐）

1. 从本项目的 Releases 页面下载最新版本的 `qwqnt-mcp.zip`
2. 解压，得到 `qwqnt-mcp/` 文件夹
3. 将整个文件夹复制到 QwQNT 插件目录
4. 重启 QQ 客户端

QwQNT 插件目录通常位于：`QwQNT 目录/qwqnt-storage/plugins`

zip 内已包含 `dist/` 构建产物、`package.json`、`README.md` 与 `LICENSE`，无需安装依赖或构建，解压即可使用。发布 Release 时在项目根执行 `pnpm zip`（先 `pnpm run build`），生成 `qwqnt-mcp.zip`（内含 `qwqnt-mcp/` 文件夹，zip 结构与安装步骤一一对应）。

### 从源码构建

本目录就是 QwQNT 扫描的插件目录，构建产物直接被 inject 加载。

```bash
pnpm install
pnpm run build
```

产物：

- `dist/main/index.js`
- `dist/preload/index.cjs`

对应 `package.json`：

```json
{
  "qwqnt": {
    "name": "MCP 开发工具",
    "inject": {
      "main": "./dist/main/index.js",
      "preload": "./dist/preload/index.cjs"
    }
  }
}
```

开发检查（先安装项目依赖）：

```bash
pnpm test
pnpm run typecheck
pnpm run lint
```

`pnpm run build` 显式加载 `vite.config.ts`，只更新 `dist/` 构建产物，不自动修复源码。需要自动修复 lint 问题时，单独执行 `pnpm run lint:fix`；此命令会修改源码，执行后应检查变更。源码重新构建后，重启 QQ 才会加载新的主进程和 preload 产物。

## 启动

1. 确保插件目录包含 `dist/`（zip 安装已自带；源码方式需先执行构建）。
2. 关闭已有 QQ。
3. 用 QwQNT 注入器启动 QQ（例如 `D:\qwqnt\qwqnt_injector.exe`）。
4. 登录并打开需要调试的窗口。
5. 主进程日志会出现类似：

```text
[qwqnt-mcp] MCP 服务已启动：http://127.0.0.1:18765/mcp
[qwqnt-mcp] 配置文件：.../qwqnt-storage/configs/qwqnt-mcp/config.json
```

端口占用时插件会报错并保持 QQ 可用，不会退化为无认证或监听外网卡。修改配置后需重启 QQ。

## 配置

路径（相对 QwQNT 配置根）：

```text
<qwqnt.framework.paths.configs>/qwqnt-mcp/config.json
```

本机常见路径：

```text
D:\qwqnt\qwqnt-storage\configs\qwqnt-mcp\config.json
```

示例：

```json
{
  "port": 18765,
  "token": "64位十六进制字符串"
}
```

规则：

- 首次启动自动创建目录并写入默认配置
- `port`：`1024–65535` 整数
- `token`：至少 32 字符；首次用 `randomBytes(32)` 生成 64 位小写十六进制
- 字段缺失或非法时回写安全默认值
- 文件 mode 尽量使用 `0o600`
- **不要**把 token 写进提交、构建日志或公开文档

## AI / MCP 客户端配置

核心只有两样：本机 URL + Bearer 头。不要把 token 拼进 URL。

连接后，服务会在 MCP `initialize` 响应的 `instructions` 字段中提示：涉及 QQ 页面或 IPC 的任务优先使用这些工具，并建议先调用 `list_pages` 获取 `pageId`。这是给客户端模型的上下文提示，不是协议层的强制路由；如果客户端忽略服务端 instructions，需要在该客户端的系统提示或 MCP 配置中加入同样的工具使用规则。

### 通用 `mcpServers` 示例

```json
{
  "mcpServers": {
    "qwqnt-mcp": {
      "url": "http://127.0.0.1:18765/mcp",
      "headers": {
        "Authorization": "Bearer 你的token"
      }
    }
  }
}
```

若客户端要求 transport 类型，可试：

```json
{
  "mcpServers": {
    "qwqnt-mcp": {
      "type": "http",
      "url": "http://127.0.0.1:18765/mcp",
      "headers": {
        "Authorization": "Bearer 你的token"
      }
    }
  }
}
```

或：

```json
{
  "mcpServers": {
    "qwqnt-mcp": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:18765/mcp",
      "headers": {
        "Authorization": "Bearer 你的token"
      }
    }
  }
}
```

### 代码直连

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const transport = new StreamableHTTPClientTransport(
  new URL('http://127.0.0.1:18765/mcp'),
  {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  },
)

const client = new Client({ name: 'my-agent', version: '0.1.0' })
await client.connect(transport)

const pages = await client.callTool({ name: 'list_pages', arguments: {} })
```

### 冒烟脚本

```bash
node scripts/smoke.mjs --url http://127.0.0.1:18765/mcp --token <token>
```

脚本会检查：

1. 无 token → HTTP 401
2. 十二个工具齐全
3. 至少有一个 `visible && ipcReady` 页面
4. `get_page_html` 返回含 `<html` 的文档
5. `capture_page` 返回 PNG image content
6. `execute_javascript` 的 `document.title` 与页面 title 一致
7. `send_ipc` 到 `qwqnt_mcp_smoke` 返回 `result.sent === true`
8. 不存在 `pageId` → `isError` + `未找到页面：...`
9. 错误 token → HTTP 401

## 工具说明

### `list_pages`

无输入。返回：

```json
{
  "pages": [
    {
      "id": 1,
      "title": "",
      "url": "app://./renderer/...",
      "visible": true,
      "focused": false,
      "ipcReady": true
    }
  ]
}
```

- `id` 即后续工具的 `pageId`（Electron `BrowserWindow.id`）
- `ipcReady=false` 时仍可读写 HTML/JS，但 `send_ipc` 会失败
- `title` 与页面 `document.title` 对齐；空标题不会用 URL 冒充

### `get_page_html`

输入：

```json
{
  "pageId": 1,
  "selector": "optional CSS",
  "includeShadowDom": true,
  "timeoutMs": 10000
}
```

- 默认序列化完整 document，并尽量保留 doctype
- `includeShadowDom` 默认 `true`：开放 ShadowRoot 写成 `<template shadowrootmode="open">...</template>`
- 关闭 ShadowRoot 读不到，按普通宿主元素输出
- `timeoutMs` 默认 `10000`，范围 `100–30000`
- 响应最多返回 100 万字符；超出时返回 `truncated: true` 和 `totalLength`
- selector 未命中：`页面中未找到选择器：...`

### `capture_page`

输入：

```json
{
  "pageId": 1,
  "rect": {
    "x": 0,
    "y": 0,
    "width": 800,
    "height": 600
  },
  "timeoutMs": 10000
}
```

- 基于 Electron `webContents.capturePage`
- 省略 `rect` 时截取整个页面
- `rect` 使用页面 CSS 像素，宽高最多 `4096`，总像素最多 `16777216`
- `timeoutMs` 默认 `10000`，范围 `100–30000`
- PNG 结果最多 `4000000` bytes
- 返回内容同时包含：
  - MCP `image` content（`mimeType: image/png`，base64）
  - `structuredContent`：`{ pageId, url, mimeType, width, height, byteLength }`
- 页面不存在：`未找到页面：...`；空图：`截图结果为空`

### `execute_javascript`

输入：

```json
{
  "pageId": 1,
  "expression": "document.title",
  "timeoutMs": 10000
}
```

- `timeoutMs` 默认 `10000`，范围 `100–30000`
- 表达式最多 100000 个字符，经 `JSON.stringify` 嵌入固定包装器，再用间接 `eval` 执行
- 默认不授予 Electron `userGesture`
- **禁止无限循环**；超时只能停止 MCP 等待，无法中断已进入页面的脚本
- 支持返回 Promise，等待其结果
- 结果在页面内归一化：DOM 节点 → `{ nodeName, outerHTML }`，`Date` → ISO 字符串，`Map` → 键值对数组，`Set`/`NodeList` → 数组，函数、`bigint`、`symbol` → 字符串，循环引用 → `"[Circular]"`
- 结果限制最大深度、条目数和字符串长度；超出响应大小时返回 `OUTPUT_LIMIT`
- 表达式抛错或有语法错误时返回 `SCRIPT_ERROR`，消息包含原始错误名称和内容
- 返回 `{ pageId, valueType, value }`

### `send_ipc`

输入：

```json
{
  "pageId": 1,
  "channel": "some-channel",
  "args": [],
  "mode": "send"
}
```

- 语义是「从目标 QQ 渲染进程调用 ipcRenderer」，不是主进程广播
- `mode`：`send`（默认）或 `invoke`
- channel 最多 256 个字符，args 最多 64 项且总大小最多 1000000 bytes
- 拒绝空 channel，以及任何 `qwqnt-mcp:` 保留通道
- `send` 返回 `result: { ok: true, sent: true }`
- `invoke` 返回 `result: { ok: true, valueType, value }`
- 渲染进程侧 `send`/`invoke` 失败（如通道没有 handler）返回 `IPC_ERROR`，消息包含 Electron 的原始错误
- 目标未加载 preload：`目标页面尚未加载 QwQNT MCP preload，无法发送 IPC`

失败工具会同时返回 `isError: true`、文本说明和 `structuredContent.error`：

```json
{
  "code": "TIMEOUT",
  "message": "操作超时（1000 ms）",
  "retryable": true
}
```

常见 code：`PAGE_NOT_FOUND`、`ELEMENT_NOT_FOUND`、`TIMEOUT`、`PAGE_NOT_READY`、`INVALID_ARGUMENT`、`OUTPUT_LIMIT`、`SCRIPT_ERROR`、`IPC_ERROR`、`INTERNAL_ERROR`。`TIMEOUT` 与 `PAGE_NOT_READY` 的 `retryable` 为 `true`；`INTERNAL_ERROR` 的消息附带原始错误内容。

### 页面操作限制

- `click`、`type_text`、`press_key` 使用页面内合成事件，`event.isTrusted` 不为 true，不等同系统级鼠标或键盘输入。
- `type_text` 仅支持 `input`、`textarea` 和 `contenteditable`。contenteditable 通过浏览器编辑命令（`execCommand('insertText')`）输入，QQ 的 ProseMirror 输入框可保留多行文本的换行。
- QQ 发送快捷键按用户设置而定：设为 Ctrl+Enter 时用 `press_key`（`key: "Enter"`, `modifiers: ["ctrl"]`）发送，单独 Enter 只换行；也可以点击发送按钮。
- `wait_for.expression` 返回 Promise 时等待其结果再判断真值。
- 同一页面的写操作（`click`、`type_text`、`press_key`、`execute_javascript`、`send_ipc`）在所有 MCP 请求之间串行执行，避免并发点击、输入和按键互相覆盖。
- `wait_for.expression` 和 `execute_javascript` 可以修改页面状态，不应当视为只读操作。

推荐调用顺序：

1. `list_pages`
2. 选择目标 `pageId`（发 IPC 时优先 `visible && ipcReady`）
3. `get_page_html` / `capture_page` / `query_selector` / `wait_for`
4. `click` / `type_text` / `press_key` / `execute_javascript`
5. 需要时再 `send_ipc`；失败时看 `get_console_logs` / `list_network`

## 安全边界

- 只监听 `127.0.0.1`
- Bearer token 是唯一信任边界；持有 token 的本机进程可完全控制 QQ 会话
- 带 `Origin` 的请求返回 403，降低浏览器跨站滥用风险
- 标准本地 Agent 请求无需 `Origin`
- `execute_javascript` 默认不授予 Electron `userGesture`，但仍可执行页面任意代码
- `send_ipc` 可调用目标渲染进程的非保留 IPC 通道，请只给受信任的本机 Agent
- 网络摘要默认移除 URL query/fragment，console、URL、脚本结果和 IPC 参数均有大小限制
- 单个 MCP 服务最多同时处理 32 个请求；繁忙时返回 HTTP 503
- 请求体最多 4 MiB，超出返回 HTTP 413 与 JSON-RPC 错误
- 不提供关闭认证或绑定 `0.0.0.0` 的配置

## 目录结构

```text
src/
  main/        配置、页面服务、IPC bridge、MCP 工具、HTTP 服务、入口
  preload/     隐藏 IPC 调度器
  shared/      通道名与结果序列化
tests/         Vitest 伪窗口与 HTTP 测试
scripts/       smoke.mjs
dist/          构建产物（QwQNT inject）
```

## 开发说明

- 构建目标 `node20`，产物 CommonJS
- main 打包 `@modelcontextprotocol/sdk`、`express`、`zod`；只 externalize `electron` 与 Node 内置模块
- 不依赖 `qwqnt-ipc-interceptor`（AGPL）；主动发包由本插件 preload 完成
- 窗口来源：`BrowserWindow.getAllWindows()` + `qwqnt.main.hooks.whenBrowserWindowCreated.peek`
- SPA / hash 导航不会卸载 preload，因此不会误清 `ipcReady`；加载开始（`did-start-loading`）时清除 ready，加载结束后若仍未就绪，主进程通过保留通道请求 preload 重新报告，子帧加载不会让 `ipcReady` 长期为 false
- `tsc -b` 输出到 `.tsbuild/`，不要在 `src/` 旁生成 `.js`

## 故障排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 连不上 MCP | QQ 未注入启动 / 插件未构建 | 构建后用 injector 重启 QQ |
| HTTP 401 | token 缺失或错误 | 读配置文件核对 Bearer |
| HTTP 403 | 请求带了 `Origin` | 用非浏览器本机客户端，去掉 Origin |
| 端口启动失败 | 端口被占用 | 改 `config.json` 的 `port` 后重启 QQ |
| `ipcReady=false` | 页面无 preload（如部分特殊窗口） | HTML/JS 仍可用；换主界面或已注入 preload 的窗口再发 IPC |
| `未找到页面：id` | 窗口已关或 id 错误 | 重新 `list_pages` |
| JS/页面操作超时 | 页面脚本过慢或 renderer 无响应 | `timeoutMs` 只能停止 MCP 等待，不能中断已进入页面的脚本；不要运行无限循环 |
| `OUTPUT_LIMIT` | HTML、脚本结果、截图或 IPC 参数过大 | 缩小 selector/结果/截图区域或拆分调用 |
| HTTP 503 | MCP 并发请求达到 32 个 | 等待已有请求完成后重试 |
| HTTP 413 | 请求体超过 4 MiB | 缩短表达式、文本或 IPC 参数 |

## License

MIT
