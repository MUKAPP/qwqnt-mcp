# qwqnt-mcp

QwQNT 插件：在 QQ 主进程内启动本机 MCP Streamable HTTP 服务，供开发 Agent 读取页面 HTML、执行 JS、从渲染进程发送 IPC。

## 目录

- `src/main/` — 主进程：配置、页面服务、IPC bridge、MCP 工具、HTTP 服务
- `src/preload/` — 隐藏 IPC 调度器（不向页面暴露任意 IPC）
- `src/shared/` — main/preload 共享通道与序列化
- `tests/` — Vitest 伪窗口/HTTP 测试
- `scripts/smoke.mjs` — 真实 QQ 冒烟客户端
- `dist/main/index.js`、`dist/preload/index.cjs` — QwQNT inject 入口

## 常用命令

```bash
pnpm install
pnpm test
pnpm run typecheck
pnpm run build
node scripts/smoke.mjs --url http://127.0.0.1:<port>/mcp --token <token>
```

配置文件：`qwqnt.framework.paths.configs/qwqnt-mcp/config.json`（默认端口 `18765`，token 首次生成）。

## 约定

- 构建产物 CJS；main 打包 MCP SDK/express/zod，只 externalize `electron` 与 Node 内置模块。
- 注释、日志、用户可见错误使用中文；代码标识符使用英文。
- 不要依赖 `qwqnt-ipc-interceptor`（AGPL）；主动 IPC 由本插件 preload 完成。
- 服务只监听 `127.0.0.1`，Bearer token 认证；带 `Origin` 的请求返回 403。
- `tsc -b` 输出到 `.tsbuild/`，勿在 `src/` 旁生成 `.js`。
