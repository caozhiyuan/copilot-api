# Copilot API 桌面应用设计文档

**日期**：2026-04-22  
**技术栈**：Electron + React + Tailwind CSS + TypeScript + Vite  
**原则**：与现有 `src/` 完全解耦，服务通过子进程启动

---

## 项目结构

```
copilot-api1/
├── src/                    # 现有服务端代码（不修改）
├── dist/                   # 现有构建产物（子进程执行体）
└── desktop/                # 新增桌面应用（独立 package.json）
    ├── electron/           # 主进程
    │   ├── main.ts         # Electron 入口：窗口管理、IPC 注册
    │   ├── auth.ts         # GitHub OAuth device flow + token 写入
    │   └── server-manager.ts  # 子进程启动/停止/状态监控
    ├── src/                # 渲染进程
    │   ├── App.tsx         # 路由：Auth / Start / Dashboard
    │   ├── pages/
    │   │   ├── AuthPage.tsx      # 授权页（OAuth + Token 两种方式）
    │   │   ├── StartPage.tsx     # 启动页（端口 + 启动按钮）
    │   │   └── DashboardPage.tsx # 看板页（订阅信息 + 模型列表）
    │   └── components/
    │       ├── SettingsModal.tsx  # 代理配置弹窗
    │       └── Header.tsx        # 顶部导航（Logo + 用户名 + 设置）
    ├── package.json
    ├── vite.config.ts
    ├── electron-builder.config.ts
    └── tsconfig.json
```

---

## 架构

### 主进程（electron/）

**main.ts**
- 创建 BrowserWindow，加载渲染进程
- 注册所有 IPC handler
- 应用生命周期管理

**auth.ts**
- `getDeviceCode()`: POST GitHub device code API，返回 user_code + verification_uri
- `pollAccessToken(deviceCode)`: 轮询直到拿到 access_token
- `saveToken(token)`: 写入 `~/.local/share/copilot-api/github_token`
- `readToken()`: 读取已保存 token
- `validateToken(token)`: 调用 GitHub `/user` API 验证并返回用户名
- GitHub API 常量与现有 `src/lib/api-config.ts` 保持一致

**server-manager.ts**
- `startServer(port, token, proxy?)`: spawn `node dist/main.js start --github-token <token> --port <port>`
- `stopServer()`: kill 子进程
- `getStatus()`: running / stopped / error
- 捕获子进程 stdout/stderr，通过 IPC 推送日志给渲染进程

### IPC 通道定义

| 通道 | 方向 | 说明 |
|------|------|------|
| `auth:get-device-code` | invoke | 触发 OAuth，返回 user_code + url |
| `auth:poll-status` | on | 主进程推送 token 获取结果 |
| `auth:save-token` | invoke | 保存手动输入的 token |
| `auth:check-saved` | invoke | 检查本地是否有已保存 token，返回用户名 |
| `auth:logout` | invoke | 清除本地 token |
| `server:start` | invoke | 启动子进程，传入端口号 |
| `server:stop` | invoke | 停止子进程 |
| `server:status` | on | 推送服务状态变更 |
| `server:log` | on | 推送子进程日志 |
| `settings:get` | invoke | 读取桌面端配置（含代理） |
| `settings:save` | invoke | 保存桌面端配置 |
| `shell:open-url` | invoke | 用系统浏览器打开 URL |

### 渲染进程页面流转

```
启动 → 检查本地 token
  ├── 无 token → AuthPage
  ├── 有 token → StartPage（右上角显示用户名）
  │   └── 点击「启动服务」→ DashboardPage
  └── DashboardPage
      ├── 展示订阅信息（GET http://localhost:{port}/usage）
      ├── 展示模型列表（GET http://localhost:{port}/models）
      └── 点击用户名 → 显示「注销」按钮 → 注销后回 AuthPage
```

---

## 授权流程

### OAuth Device Flow
1. 渲染进程点击「开始 OAuth 授权」→ invoke `auth:get-device-code`
2. 主进程调用 GitHub API 返回 `{ user_code, verification_uri }`
3. 渲染进程展示 `Please enter the code "XXXX-XXXX" in https://github.com/login/device`
4. 渲染进程点击链接 → invoke `shell:open-url` → 系统浏览器打开
5. 主进程后台轮询 access token
6. 拿到 token → 调用 `/user` API 获取用户名 → 通过 `auth:poll-status` 推送成功
7. 渲染进程跳转到 StartPage

### Token 直接输入
1. 切换到「refresh token」tab
2. 输入 token → 点击「确认添加」
3. invoke `auth:save-token` → 主进程验证 + 保存
4. 跳转 StartPage

---

## 代理支持

- 代理配置存储于 `desktop-config.json`（位置：`~/.local/share/copilot-api/desktop-config.json`）
- 主进程 fetch 调用：设置 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量（使用 `undici` + `ProxyAgent`）
- 子进程启动时：注入 `HTTP_PROXY` / `HTTPS_PROXY` 到子进程 env

---

## 构建与打包

- **开发**：`concurrently` 同时运行 `vite dev`（渲染进程）+ `electron .`（主进程）
- **打包**：`electron-builder`
  - Mac: DMG
  - Windows: NSIS installer
  - Linux: AppImage
- **资源打包**：`dist/main.js`（服务端构建产物）复制到 Electron resources 目录
- **Node 运行时**：Electron 自带 Node.js，无需系统安装 Bun/Node

---

## 桌面端独立配置

`desktop-config.json` 结构：
```json
{
  "proxy": {
    "http": "",
    "https": ""
  },
  "lastPort": 4141
}
```

---

## 非功能性要求

- 最小窗口尺寸：900×600
- 关闭窗口时自动停止服务子进程
- 子进程异常退出时，DashboardPage 显示错误状态并允许重启
