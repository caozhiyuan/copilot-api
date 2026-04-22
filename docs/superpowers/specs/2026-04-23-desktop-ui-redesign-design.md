# Desktop 应用 UI 重设计规格

**日期**：2026-04-23  
**范围**：桌面 Electron 应用（`desktop/src`）三个页面的视觉与交互重设计  
**目标**：提升界面美观度，简化用户操作流程，统一视觉风格

---

## 1. 设计决策总览

| 维度 | 决策 |
|------|------|
| 整体风格 | 简洁商务风：纯白底 `#ffffff`、深色字 `#0f172a`、蓝/绿状态点缀 |
| 用户流程 | Auth → Dashboard（取消独立 StartPage，合并为 Dashboard 空态） |
| 授权页布局 | 极简全屏：大 Logo + 两个清晰操作按钮 |
| 看板页布局 | 顶部 Tab（看板 / 日志）+ 全宽内容区 |
| 停止服务位置 | Header 右侧，运行状态徽章左边 |

---

## 2. 颜色规范

| 用途 | 色值 |
|------|------|
| 主文字 / Logo 背景 | `#0f172a` |
| 次要文字 | `#64748b` |
| 占位文字 / 标签 | `#94a3b8` |
| 边框 | `#e2e8f0` |
| 背景灰 | `#f8fafc` |
| 主按钮背景 | `#0f172a` |
| 主按钮文字 | `#ffffff` |
| 蓝色高亮 | `#3b82f6` |
| 成功绿（运行中） | `#16a34a` / 背景 `#dcfce7` / 边框 `#bbf7d0` |
| 警告黄（未启动） | `#ca8a04` / 背景 `#fef9c3` |
| 危险红（停止） | `#ef4444` / 边框 `#fecaca` |
| Premium 绿 | `#16a34a` / 背景 `#f0fdf4` |
| Anthropic 紫 | `#7c3aed` |

---

## 3. 页面规格

### 3.1 App.tsx — 流程简化

**变更**：取消 `page === 'start'` 状态，用户登录后直接进入 `dashboard`。  
`Page` 类型从 `'auth' | 'start' | 'dashboard'` 改为 `'auth' | 'dashboard'`。

```
认证成功 → setPage('dashboard')   // 不再跳 start
服务停止 → setPage('dashboard')   // 保持在 dashboard（空态）
注销     → setPage('auth')
```

---

### 3.2 AuthPage — 极简全屏

**布局**：
- macOS 交通灯占位条（可拖拽，高度 28px）
- 剩余空间垂直居中，无 Header 组件

**内容区（居中排列）**：
1. **大 Logo**：`56×56px`，`border-radius: 16px`，背景 `#0f172a`，文字 "CA"，`box-shadow: 0 4px 14px rgba(0,0,0,0.15)`
2. **标题**：`font-size: 16px`，`font-weight: 700`，"Copilot API"
3. **副标题**：`font-size: 11px`，`color: #94a3b8`，"连接你的 GitHub Copilot"
4. **按钮组**（`max-width: 220px`，全宽）：
   - 主按钮（GitHub OAuth）：黑底白字 + GitHub SVG 图标，点击触发设备码流程
   - 次按钮（手动 Token）：白底灰字边框，点击展开 Token 输入区
5. **底部说明**：`font-size: 10px`，`color: #cbd5e1`

**OAuth 授权码等待态**（主按钮点击后替换按钮组）：
- 显示设备码（`font-family: monospace`，大字号，带「复制」按钮）
- 「打开授权页面」主按钮
- 「等待 GitHub 授权中…」动画文字

**Token 输入展开态**（次按钮点击后展开）：
- `textarea` 输入框（`placeholder: gho_…`）
- 「确认添加」按钮
- 可收起回初始态

**错误显示**：底部红色提示条，`background: #fef2f2`，`border: 1px solid #fecaca`

---

### 3.3 DashboardPage — 合并空态与运行态

**移除** `StartPage.tsx` 文件，其功能合并到 `DashboardPage`。

#### Header（所有状态共用）

```
[Logo CA] [Copilot API]        [停止按钮*] [状态徽章] [用户头像]
```

- **Logo**：`22×22px`，`border-radius: 6px`，背景 `#0f172a`
- **停止按钮**（仅运行时显示）：`border: 1px solid #fecaca`，`color: #ef4444`，文字「■ 停止」，`border-radius: 6px`，`padding: 4px 10px`
- **状态徽章**：
  - 运行中：绿色圆点 + 端口号（如 `:4141`），背景 `#dcfce7`
  - 未启动：黄色圆点 + 「未启动」，背景 `#fef9c3`
- **用户头像**：`24×24px` 圆形，背景 `#3b82f6`，用户名首字母（点击弹出注销菜单）

#### Tab 栏

两个 Tab：**看板** / **日志**  
激活 Tab：`font-weight: 600`，`color: #0f172a`，底部 `2px solid #0f172a`

#### 看板 Tab — 未启动态

垂直居中展示：

1. **图标**：`44×44px`，`border-radius: 12px`，`background: #f1f5f9`，🚀 emoji
2. **标题**："服务未运行" / 副标题："配置端口后一键启动"
3. **启动表单卡片**（`max-width: 190px`，`background: #f8fafc`，`border-radius: 10px`）：
   - 端口输入行：Label「端口」+ 数字输入框（默认 4141，居中显示，上次使用端口从 settings 读取）
   - 「▶ 启动服务」全宽黑底按钮
   - 启动中：按钮变为加载动画 + 「启动中…」文字
   - 端口冲突错误：橙色提示条显示在表单下方

#### 看板 Tab — 运行态

从上到下依次：

1. **指标卡片行**（三列）：
   - Copilot Plan（白色卡片）
   - Premium 已用/总量（绿色背景，格式：`已用 / 总量`，数值绿色高亮）
   - 配额重置日期（白色卡片）

2. **服务地址卡片**：
   - OpenAI：`badge #64748b` + URL + 复制按钮
   - Anthropic：`badge #7c3aed` + URL + 复制按钮
   - 复制后 1.5s 变为「✓」

3. **配额使用卡片**：
   - 右上角「🔄 刷新」按钮
   - 三行进度条：Premium（深色）/ Chat（蓝色）/ Completions（绿色）
   - Premium 格式：`已用数 / 总量`（进度条表示已用比例）
   - Chat / Completions 格式：`剩余数 / 总量` 或 `∞`（unlimited）

4. **可用模型卡片**：
   - 列表展示模型 ID，`background: #f8fafc`，`border-radius: 5px`
   - 超过 5 个时显示「+N 个模型…」收起

#### 日志 Tab

- 深色背景终端面板（`background: #0f172a`，`border-radius: 9px`）
- 右上角「清空」按钮
- `font-family: monospace`，`font-size: 12px`，`color: #4ade80`（绿色文字）
- 自动滚动到最新一条
- 空日志时显示「暂无日志…」占位文字

---

## 4. 组件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/App.tsx` | **修改** | 移除 `start` 状态，`handleAuthSuccess` 直接跳 `dashboard` |
| `src/pages/AuthPage.tsx` | **重写** | 极简全屏布局，移除 Header 组件，Token 展开式替代 Tab |
| `src/pages/DashboardPage.tsx` | **重写** | 合并空态启动逻辑，Tab 改为看板/日志，模型列表并入看板 |
| `src/pages/StartPage.tsx` | **删除** | 功能已合并到 DashboardPage |
| `src/components/Header.tsx` | **修改** | 新增停止按钮插槽，调整右侧布局顺序 |

---

## 5. 不在本次范围内

- SettingsModal 样式（单独迭代）
- 窗口尺寸调整
- 暗色主题支持
- 动画/过渡效果细节（维持现有 Tailwind transition）
