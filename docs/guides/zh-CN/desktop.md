# 桌面应用

[项目首页](../../../README.zh-CN.md) · [文档目录](README.md) · [English](../en/desktop.md)

## 图片与视频创作

启动本地服务后，打开 **创作** 标签页，可以输入提示词生成图片、上传图片进行修改，或生成视频。图片可选择网关默认路由、Codex 或 xAI，设置模型、尺寸、质量和数量（1–4 张）。网关默认路由沿用 `imageGenerationModel`、`imageEditModel` 和模型映射；指定 Codex 或 xAI 时直接使用对应提供商，需先启用该提供商。图片修改支持最多 5 张 PNG、JPEG 或 WebP，每张不超过 20 MiB，总计不超过 40 MiB。

视频使用 `xai/grok-imagine-video-1.5`，需启用 xAI 提供商。可填写提示词、添加一张首帧图片，或同时使用两者；时长 1–15 秒，分辨率 480p、720p 或 1080p，以及音频开关。提交后每 5 秒查询一次任务状态；可暂停、继续查询或结束跟踪。切换标签页会保留草稿、结果和任务，关闭或刷新应用会清除这些临时内容。**停止等待**和**结束跟踪**仅停止本地等待或查询，不会撤销已提交到上游的生成任务。

生成结果可在页面预览，并通过系统保存对话框保存到本地。视频链接有有效期，请及时保存。

<a id="electron-desktop-app"></a>

## Electron 桌面应用

打开**订阅额度**标签页，可集中查看 GitHub Copilot、Codex、xAI 和 OpenCode Go 订阅。卡片展示内置的 models.dev 品牌标识、套餐、剩余额度、额度窗口、重置时间和可用余额，支持单独刷新或**全部刷新**。Copilot 包含 Premium、Chat 和 Completions；Codex 包含个人 / 模型额度窗口和 Business 工作区 Credits、成员上限；xAI 包含 Grok Build 每周 / 每月额度、旧版月度额度、按量付费用量及预付余额。OpenCode Go 使用已配置的 API key，展示滚动 5 小时、每周及每月的用量百分比和重置时间。首次打开时通过 CLI server 加载，之后切换到其他标签页再返回会保留现有结果，直到手动刷新。网页看板也提供相同的订阅额度标签页，Token 用量页专注请求历史和性能统计。

如果你更喜欢图形界面，仓库里还提供了位于 `desktop/` 的 Electron 桌面应用。它支持 GitHub Copilot 登录、OpenAI Codex OAuth 与最多 3 个 Codex 账号的手动切换、移除未在使用的账号，以及 Kimi、DeepSeek、DashScope、OpenRouter 或自定义 provider 的 API Key 配置。Dashboard 顶部会用用量概览汇总所选统计周期的请求数、总 Token、缓存命中率、预估费用和请求量最高的模型。Provider 配置、服务 API Key 和账号修改后，会自动刷新运行中的服务，新请求使用更新后的配置。授权或配置 provider 后，可以一键启动或停止本地代理，并在界面里直接查看本地端点、鉴权 Header、可用模型、额度和日志。

监听地址、代理、详细日志和 Token 日志属于服务启动选项，保存后会自动重启正在运行的服务，进行中的请求可能中断。OAuth App、API Home、SQLite DB Path 和 Enterprise URL 仍需重启桌面应用。服务未运行时只保存设置，不会自动启动。

再次发起 GitHub 登录会取代之前的尝试，包括 token 保存阶段。被取代的尝试不会报告成功，也不会覆盖后续已完成登录的凭据与账号设置。

设置页还可以配置 `OAuth App`、`API Home`、`SQLite DB Path`、`Enterprise URL`、详细日志以及最小化到托盘。Windows x64（`.exe`）、macOS Apple Silicon（`.dmg`）和 Linux x64（`.AppImage`）安装包发布在 GitHub Releases：

https://github.com/caozhiyuan/copilot-api/releases

Linux 用户需要先为下载的 AppImage 添加执行权限：

```sh
chmod +x Copilot-API-*-linux-x86_64.AppImage
./Copilot-API-*-linux-x86_64.AppImage
```

新安装时，**设置 → 启动参数 → 服务运行时** 默认选择 **Bun（推荐）**。升级时，未包含运行时选项的已有配置继续使用内置 Node.js，以保留系统代理和 PAC 行为；可在设置中主动切换到 Bun。应用会检测本地 `PATH`、`BUN_INSTALL`、用户 Bun 安装目录及常见桌面安装位置，仅使用稳定版 Bun >= 1.4.0；未安装、版本过低或无法执行时会回退到 Electron 内置的 Node.js。设置页显示检测结果，服务日志显示实际运行时；选择 **Node.js（内置）** 可以始终使用内置 Node，无需额外安装 Node.js。

Windows、macOS 和 Linux 均支持通过 nvm 下的 `npm install -g bun` 安装 Bun。检测会检查当前 `NVM_BIN` 或 `NVM_SYMLINK`、显式配置的 npm 全局安装前缀，以及 `NVM_DIR`/`NVM_HOME` 或常见默认 nvm 目录（含 XDG 路径）下的各 Node 版本。桌面环境没有当前版本信息时，按 Node 版本从新到旧查找可用的 Bun；Windows 会直接运行 npm 包内的原生 `bun.exe`。

Bun 直接运行桌面应用随包发布的 JavaScript（`bun --no-orphans --no-install <resources>/server/main.js start ...`），不会调用 `bunx`、安装 npm 包或执行 TypeScript 源码。桌面服务 bundle 已包含依赖，应用继续管理子进程日志、就绪检测、重启及退出。请自行安装或升级 Bun，之后启动或重启服务即可重新检测。

Bun 模式下，**网络 → 自定义代理** 会向子进程传递 HTTP/HTTPS 代理与绕过规则。Bun 不使用 Electron 的系统代理或 PAC 配置；需要代理时请配置自定义代理，或选择 Node.js 保持 Electron 的系统网络行为。桌面界面与更新仍使用 Electron 中选择的代理模式。修改服务运行时并保存会自动重启运行中的服务。

下载对应平台的安装包后，在应用内授权或配置 provider，选择端口并启动服务，再把你的客户端指向应用里显示的本地端点即可。推荐安装 Bun >= 1.4.0；未安装时可使用内置 Node.js。token usage 历史记录使用所选运行时的 SQLite。

打包后的应用会在启动 15 秒后，以及每 6 小时检查 GitHub 最新稳定版。也可以通过 **设置 → 应用更新 → 检查更新** 手动触发。Windows NSIS 和 Linux AppImage 会自动下载更新，并使用 release 元数据中的 SHA-512 校验安装包。下载完成后点击 **重启并安装**；安装前会停止本地 API 服务，中断进行中的请求。正常关闭应用不会安装待更新版本。

macOS 会将经过 SHA-512 校验的完整 DMG 保存到系统下载目录。首次完整下载建立缓存后，后续更新可复用旧 DMG，只下载变化的数据块；缓存缺失、损坏或差分请求失败时回退完整下载。即使下载后尚未安装该版本，也可以使用其缓存准备后续更新。

安装位置和父目录允许替换时，点击 **重启并安装** 会先准备新版应用，再停止服务，由独立辅助进程替换并重启。辅助进程会保留旧版，直到新版确认启动；启动失败时尝试恢复旧版。用户配置和数据库不会被替换。同时保留 **在文件夹中显示** 和 **打开安装包**，方便手动安装。直接从 DMG、App Translocation 或不可写位置运行时使用手动安装；自动安装准备失败后，也会保留已下载的 DMG。

当前构建没有 Developer ID 签名和 Apple 公证。自定义安装流程不调用 Squirrel.Mac，也不关闭系统安全检查；macOS 仍可能要求用户允许打开新版本。在 AppImage 之外启动的 Linux 应用，以及缺少更新元数据的旧 release，会提供 release 页面下载入口。开发模式不检查更新。更新请求使用应用中配置的代理。

桌面发布流程会一并上传 `latest.yml`、Windows `.blockmap`、`latest-linux.yml`、macOS `.dmg.blockmap` 和 `latest-mac.yml`，先上传安装包，再上传更新元数据。缺少这些文件的旧版本需要先手动安装一次新版本；macOS 尚无 DMG 缓存时，第一次下载也可能是完整包。

桌面应用里的**高级配置**通过分组表单与共用的完整 JSON 草稿编辑 `config.json`，包括模型映射。文件读写通过 Electron IPC 完成，服务停止时也可以使用；运行中的服务通过 `/admin/config/reload` 刷新，使用 `auth.adminApiKey` 认证。校验、外部修改冲突、密钥脱敏和应用重试的说明见[桌面端配置编辑器](configuration.md#桌面端配置编辑器)。
