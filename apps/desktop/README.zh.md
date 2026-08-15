# `@deepseek-ai/dsh-desktop`

[English](README.md) | 中文

DeepSeek Harness Web GUI 的桌面壳：在真实的 `dsh web` 服务器之上加一个 Electron 窗口，并由系统托盘图标掌管应用生命周期。壳本身从不担任 GUI 的服务方——它监督的是浏览器标签页同样会连接的 CLI Web 启动，因此它展示的 GUI 与浏览器产品逐字节一致。

## 运行

在仓库根目录构建后执行：

```sh
pnpm run desktop
```

该命令会先构建（与 `pnpm run test:web` 一致），再启动 Electron 窗口。若构建产物已就绪，可直接 `pnpm --filter @deepseek-ai/dsh-desktop run start`。

## 行为

- 宿主与端口来自组合后的 web profile，与 `dsh web` 的解析完全一致；端口被占用时 Web 启动会带着绑定诊断信息大声失败。
- 关闭窗口会把它隐藏到托盘；服务器及其会话继续运行。托盘单击或托盘 Open 菜单项恢复窗口；托盘 Quit 菜单项停止服务器并退出。
- 只允许单实例：再次启动应用会聚焦（并在隐藏时重新显示）已有窗口。
- 同源弹窗在本应用中打开；外部 `http(s)` 链接交给系统浏览器。

## 环境缝隙

| 变量 | 默认值 | 用途 |
|---|---|---|
| `DSH_DESKTOP_NODE` | `node` | 运行受监督 `dsh web` 宿主的 Node 二进制。 |
| `DSH_DESKTOP_CLI_JS` | 从 `@deepseek-ai/dsh` 包旁解析 | 要 spawn 的已构建 CLI 入口（`lib/bin.js`）。 |
| `DSH_DESKTOP_WEB_ARGS` | （无） | 额外的 `dsh web` 参数，按空白拆分为词——`--port 0` 用于指定空闲端口。 |
| `DSH_DESKTOP_DEVTOOLS` | （无） | 为 `1` 时在加载完成后打开窗口 DevTools。 |

## 开发

单元通道（`apps/desktop/tests/web-host.spec.ts`）覆盖就绪行解析与覆盖项解析；`pnpm run test:desktop` 构建仓库后在真实服务器与 dist 上运行真实 Electron 壳，断言启动 manifest 送达、完整 UI 挂载、关闭→隐藏而非退出、恢复显示、退出→服务器停止。

## 已知限制与延期工作

- **分发留待后续**：本应用是 workspace 装配体，尚无 bin 或安装器，Electron 也仅是 devDependency，因此已发布的 npm 包尚不可启动；单 exe 打包时 Electron 会转为运行时依赖。
- **原生惯例最简**：macOS 同时保留 Dock 图标与托盘；Windows/Linux 移除应用菜单（DevTools 用 `DSH_DESKTOP_DEVTOOLS=1` 打开）。
- 测试通道需要桌面会话与完整构建，因此不在默认 CI 任务之列。