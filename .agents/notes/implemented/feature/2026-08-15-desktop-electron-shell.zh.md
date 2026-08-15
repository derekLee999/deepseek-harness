# Agent Note: 桌面 Electron 壳监督真实的 `dsh web` 服务器，关闭窗口即收起托盘

Status: implemented

[English](2026-08-15-desktop-electron-shell.md) | 中文

## Problem

此前没有桌面交付形态：用户在浏览器标签页里跑 `dsh web`，而[分层笔记](../architecture/2026-07-19-gui-layering-and-rpc-protocol.md)只为「经 IPC fetch 载体复用 web client 包」的 Electron 客户端留了设想。IPC 载体是第二套传输——fetch、SSE、WebSocket 下行，以及 `file://` 页面上的 `window.__DSH_BOOT__` 注入——为第一个壳复制整个承载层，却没有任何第二个消费方。桌面壳还需要自己的生命周期语义：关闭窗口不能终止服务器正在进行的会话。

## Decision

`apps/desktop`（`@deepseek-ai/dsh-desktop`）即桌面壳：其 Electron 主进程把真实的 CLI Web 启动作为子进程拉起（`node <dsh>/lib/bin.js web`），把现有就绪行 `dsh web: http://127.0.0.1:<port>` 当作监督契约（该行本就是 CLI 为监督方提供的契约），并在该 URL 打开一个 BrowserWindow。因此 GUI 与浏览器得到的完全一致——同源 HTTP 载体、WebSocket 下行与启动 manifest 注入零改动；web 栈无需任何修改，壳本身从不担任 GUI 的服务方。

生命周期：单实例锁让第二次启动聚焦（并在隐藏时重新显示）已有窗口；窗口的 `close` 事件被截获并改为隐藏到托盘；托盘单击与 Open 菜单项重新显示窗口，其 Quit 菜单项调用 `app.quit()`，在 `before-quit` 中置位退出标志、放行关闭，随后停止子进程（SIGTERM，2 秒宽限后 SIGKILL）。子进程在就绪行之前退出则以错误对话框结束应用；就绪之后退出同样退出——失去服务器的壳不是产品状态。`window-all-closed` 永不退出：托盘拥有应用生命周期。

spawn 布局从 `@deepseek-ai/dsh` 包清单旁的 `lib/bin.js` 解析，并带有显式的部署缝隙：`DSH_DESKTOP_NODE`（Node 二进制，默认 `node`）、`DSH_DESKTOP_CLI_JS`（CLI 入口覆盖）、`DSH_DESKTOP_WEB_ARGS`（额外的 `dsh web` 参数，按空白拆分为词——`--port 0` 是用户或测试指定空闲端口的方式）、`DSH_DESKTOP_DEVTOOLS=1`（打开窗口 DevTools）。宿主与端口由组合而成的 web profile 决定；除非覆盖指明，壳不传端口。窗口打开策略放行同源弹窗，把外部 `http(s)` 链接交给系统浏览器，其余一律拒绝。

构建沿用 apps/cli 模式：tsconfig 位于 host 聚合面（类型产出到 `lib/types`），根 tsdown workspace 把 `lib/types/main.js` 打成 `lib/main.js`（`electron` 为外部依赖），`pnpm run desktop` 先构建再启动。装配事实（托盘图标路径、CLI 入口解析）都住在应用里；`packages/` 零改动。

## Alternatives considered

- **在 `file://` dist 之上做 IPC fetch 载体**（此前的预期设计）：首个壳不予采用——为没有第二个消费方的第二套传输重做 fetch、SSE、WebSocket 与启动 manifest 注入，是整个 GUI 栈里最昂贵的手工活；`AbstractApiClient` 的[子类席位](../architecture/2026-07-19-gui-layering-and-rpc-protocol.md)保留了这一选项而不必承担其成本。
- **进程内启动 profile**（在 Electron 主进程里跑 `runProfile`）：不予采用——CLI 的信号处理、fail-loud 进程钩子与退出语义本为 CLI 进程而写，把它们搬进 Electron 主进程风险重重；子进程让启动与 `dsh web` 逐字节一致，并限定在普通 Node 中。
- **壳自有的文件服务器**：不予采用——只有 `dsh web` 注入 `window.__DSH_BOOT__`，替代服务器会让 GUI 白屏。
- **把 Electron 作为运行时依赖**：暂不采用——已发布包里还没有启动入口（bin 与安装器打包留待后续），硬依赖会让每次 CI 安装都下载 Electron 二进制；它随打包工作一起移入 `dependencies`。
- **用 Playwright 的 `_electron` 启动器驱动冒烟测试**：不予采用——其主进程 inspector 协议序列会在 attach 时让 Electron 36+ 退出（[electron#47419](https://github.com/electron/electron/issues/47419)），而且 Electron 43 无论如何都不暴露可用的渲染器 DevTools HTTP 端点。该通道改为自行对话主进程 inspector 协议：测试内一个基于 `--inspect=0` 的极简 CDP 客户端在主进程求值，`require("electron")` 可抵达窗口状态、close/show、quit，`webContents.executeJavaScript` 可抵达渲染后的页面。

## Consequences

- 桌面 GUI 与浏览器加载的是同一组合与同一 dist，因此现有 web e2e 通道仍是 GUI 契约的权威；桌面只增加监督与窗口／托盘语义。
- 关闭窗口永远让服务器与会话存活在托盘；经托盘退出则同时清理两个进程，e2e 通道断言退出后服务器不再服务。
- 验证：单元通道覆盖就绪行解析与覆盖项解析；`pnpm run test:desktop` 先构建，再在真实构建产物上跑真实 Electron 壳与真实服务器，断言启动 manifest、完整 UI 挂载、关闭→隐藏而非退出、恢复显示、退出→服务器终止。壳的主入口经事件式 `void app.whenReady().then(...)` 链注册 `whenReady`，而非顶层 await：在 Electron 43 中，由顶层 `await app.whenReady()` 把门的 ESM 主入口永远不会就绪。通道自身的 inspector 挂接是进程最后的外部锚点，因此退出断言在投递 `app.quit()` 后主动断开它。该通道需要桌面会话，不属于默认 CI 任务。
- 成本：新应用 workspace 接入 apps/cli 的接线（constraints files 策略、knip 区块、host 聚合面引用、tsdown workspace 列表、三方声明），并安装 Electron devDependency（约 120 MB 二进制，在 `pnpm-workspace.yaml` 中显式放行）。
- webserver「只服务浏览器」的说法与分层笔记里的 Electron 行，现在都改为「受监督的同源复用」；IPC 载体仍是协议表中的假想子类。
- 遗留：独立打包（单 exe/app、安装器、自动更新）、macOS Dock 惯例（⌘Q 退出、托盘点击恢复），以及未来需要非 HTTP 传输时的 IPC 载体。