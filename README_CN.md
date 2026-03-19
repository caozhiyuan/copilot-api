# Copilot API Proxy（中文说明）

[English](./README.md) | 中文

> [!WARNING]
> 本项目是对 GitHub Copilot API 的逆向代理实现，并非 GitHub 官方支持产品。接口行为可能随上游变化而失效，请自行评估风险。

> [!WARNING]
> **GitHub 安全与合规提醒**  
> 过度自动化、批量或高频调用 Copilot 可能触发 GitHub 风控，导致告警或访问受限。请遵守：
>
> - GitHub Acceptable Use Policies
> - GitHub Copilot Terms

---

## 项目定位

该项目将 GitHub Copilot 能力封装为：

- OpenAI 兼容接口（`/v1/responses`、`/v1/chat/completions`、`/v1/models`、`/v1/embeddings`）
- Anthropic 兼容接口（`/v1/messages`、`/v1/messages/count_tokens`）
- 内置运维能力（`/usage`、`/admin`、`/api/admin/*`）

适用于需要将 Copilot 接入现有 AI 工具链（如 Claude Code、自建网关、脚本客户端）的场景。

## 代码已实现能力（当前版本）

- 支持多账号运行与自动路由（含临时账号优先级）
- 支持免费模型轮询负载均衡（可关闭）
- 支持付费模型按顺序选账号 + 配额预留机制
- 支持模型别名与原名访问控制（阻止直接使用目标模型名）
- 支持请求级限速（`--rate-limit`）与等待模式（`--wait`）
- 支持手动审批请求（`--manual`）
- 支持 API Key 鉴权中间件（`auth.apiKeys`，兼容旧字段）
- 支持 opencode OAuth（环境变量 `COPILOT_API_OAUTH_APP=opencode` 或全局参数 `--oauth-app=opencode`）
- 支持 GitHub Enterprise（环境变量 `COPILOT_API_ENTERPRISE_URL=company.ghe.com` 或全局参数 `--enterprise-url=company.ghe.com`）
- 支持自定义数据目录（环境变量 `COPILOT_API_HOME=/path/to/dir` 或全局参数 `--api-home=/path/to/dir`）
- 支持多 Provider Anthropic 上游代理路由（`/:provider/v1/messages`、`/:provider/v1/models`），支持按模型配置默认参数（temperature/topP/topK），并可选修正上游 usage 中的 `input_tokens`
- 内置 Admin UI 与 Admin API（账户状态、请求日志、配置管理）
- 请求历史落库 SQLite（默认 14 天保留、上限 200000 行）
- 支持 `--claude-code` 一键生成 Claude Code 环境变量命令
- 支持从环境变量初始化 HTTP 代理（`--proxy-env`，仅 Node 运行时生效）
- 支持 Responses 工具兼容处理：
  - 自动移除 `web_search`
  - 可选将 `custom/apply_patch` 转换为 `function` 工具

## 运行前准备

- Bun `>= 1.2.x`
- Node.js `>= 20`（用于 `npx` 分发场景）
- 拥有 GitHub Copilot 订阅的账号（individual/business/enterprise）

安装依赖：

```sh
bun install
```

## 快速开始

### 1) 源码启动

开发模式：

```sh
bun run dev
```

生产模式：

```sh
bun run start
```

### 2) npx 启动

```sh
npx @nick3/copilot-api@latest start
```

首次启动如果没有任何账号，服务会自动进入 GitHub Device Code 登录流程。

## Docker 部署（运维重点）

### 1) 构建镜像

```sh
docker build -t copilot-api .
```

### 2) 使用 DockerHub 镜像（推荐）

镜像名：`nick3/copilot-api`

拉取镜像：

```sh
docker pull nick3/copilot-api:latest
```

运行并持久化数据（推荐）：

```sh
mkdir -p ./copilot-data

docker run -d --name copilot-api \
  -p 4141:4141 \
  -e GH_TOKEN=your_github_token \
  -v "$(pwd)/copilot-data:/root/.local/share/copilot-api" \
  nick3/copilot-api:latest
```

说明：

- 入口默认执行 `start -g "$GH_TOKEN"`，建议首启就提供 `GH_TOKEN`
- 若不传 `GH_TOKEN`，也可复用已持久化的历史账号数据

### 3) 本地构建镜像运行并持久化数据

```sh
mkdir -p ./copilot-data

docker run -p 4141:4141 \
  -v "$(pwd)/copilot-data:/root/.local/share/copilot-api" \
  copilot-api
```

说明：

- 容器数据目录为 `/root/.local/share/copilot-api`
- 必须挂载卷，否则重启后账号与配置会丢失

### 4) 本地构建镜像：使用环境变量注入 GitHub Token

```sh
docker run -p 4141:4141 \
  -e GH_TOKEN=your_github_token \
  -v "$(pwd)/copilot-data:/root/.local/share/copilot-api" \
  copilot-api
```

说明：

- 镜像入口默认执行 `start -g "$GH_TOKEN"`
- 未提供 `GH_TOKEN` 时，会走已有账号或交互登录流程

### 5) 在 Docker 中管理多账号

镜像入口支持 `--auth` 前缀转发到 `auth` 子命令：

```sh
docker run -it \
  -v "$(pwd)/copilot-data:/root/.local/share/copilot-api" \
  nick3/copilot-api:latest --auth add

docker run -it \
  -v "$(pwd)/copilot-data:/root/.local/share/copilot-api" \
  nick3/copilot-api:latest --auth ls -q
```

### 6) Docker Compose 示例（DockerHub）

```yaml
version: "3.8"
services:
  copilot-api:
    image: nick3/copilot-api:latest
    ports:
      - "4141:4141"
    environment:
      - GH_TOKEN=your_github_token
      - ADMIN_TOKEN=your_admin_token
    volumes:
      - ./copilot-data:/root/.local/share/copilot-api
    restart: unless-stopped
```

## CLI 命令

入口命令：`copilot-api [global-options] <subcommand>`

- `start`: 启动 API 服务（无账号时自动触发登录）
- `auth`: 账号管理（`add`/`ls`/`rm`）
- `check-usage`: 终端查看 Copilot 配额（单账号 token 视角）
- `debug`: 打印运行时与路径诊断信息

### 全局参数（可用于所有子命令）

在子命令前传参时，建议使用 `--key=value` 形式：

| 参数 | 含义 | 默认值 |
| --- | --- | --- |
| `--api-home` | API home 目录路径（设置 `COPILOT_API_HOME`） | 未设置 |
| `--oauth-app` | OAuth app 标识（设置 `COPILOT_API_OAUTH_APP`） | 未设置 |
| `--enterprise-url` | GitHub Enterprise 域名（设置 `COPILOT_API_ENTERPRISE_URL`） | 未设置 |

### start 常用参数

| 参数 | 含义 | 默认值 |
| --- | --- | --- |
| `--port`, `-p` | 监听端口 | `4141` |
| `--verbose`, `-v` | 详细日志 | `false` |
| `--account-type`, `-a` | 账号类型：`individual/business/enterprise` | `individual` |
| `--manual` | 每个请求手动确认放行 | `false` |
| `--rate-limit`, `-r` | 请求间隔秒数限制 | 未设置 |
| `--wait`, `-w` | 命中限速后等待而非报错 | `false` |
| `--github-token`, `-g` | 以临时账号方式注入 GitHub Token | 未设置 |
| `--claude-code`, `-c` | 交互式生成 Claude Code 启动环境变量脚本 | `false` |
| `--show-token` | 输出 GitHub/Copilot token（敏感） | `false` |
| `--proxy-env` | 从 `HTTP_PROXY/HTTPS_PROXY` 初始化代理（Node 生效） | `false` |

### auth 子命令

- `auth add`: 添加账号（支持 `--account-type`、`--show-token`）
- `auth ls`: 列出账号（`-q` 可查询配额）
- `auth rm <id|index>`: 删除账号（`index` 为 1-based）

兼容行为：`auth` 不带子命令时等价于 `auth add`。

## 数据目录与持久化

默认数据目录：`~/.local/share/copilot-api`

可通过环境变量 `COPILOT_API_HOME` 或全局参数 `--api-home=/path/to/dir` 修改数据目录（影响 token、配置与 Admin DB 等文件落盘位置）。

| 路径 | 用途 |
| --- | --- |
| `config.json` | 运行配置 |
| `accounts-registry.json` | 多账号注册信息 |
| `tokens/github_<accountId>` | 各账号 GitHub token |
| `github_token` | 旧版单账号 token（兼容） |
| `admin.sqlite` | Admin 请求历史数据库 |

> Windows 对应目录通常为 `%USERPROFILE%\\.local\\share\\copilot-api`。

## 鉴权与访问控制

### 1) 业务 API 鉴权（请求中间件）

当有效 API Key 存在时，除以下路径外都需要鉴权：

- `/`
- `/admin`
- `/api/admin/*`

支持两种请求头：

- `x-api-key: <key>`
- `Authorization: Bearer <key>`

有效 Key 来源优先级：

1. `config.json` 的 `auth.apiKeys`
2. 环境变量 `COPILOT_API_KEY`（兼容）
3. `config.json` 的 `apiKey`（已弃用，仅兼容）

说明：

- `OPTIONS` 预检请求默认放行
- 如果没有配置任何 key，则业务 API 默认不鉴权

### 2) Admin API 访问控制

Admin API 规则独立于业务 API：

- `localhost`/`127.0.0.1`/`::1` 默认允许访问
- 非本机访问必须配置 `ADMIN_TOKEN`
- 携带 token 方式：
  - `x-admin-token: <token>`
  - `Authorization: Bearer <token>`
- URL query 不支持 token 传递
- 存在 `Origin` 且跨源时，会触发额外拒绝策略（除非 token 校验通过）

### 3) 敏感接口说明

- `GET /token` 会返回当前运行中的 Copilot token，建议仅在受控环境使用
- `--show-token` 会在日志打印 token，仅建议临时排障时开启

## 配置文件（config.json）

路径：`~/.local/share/copilot-api/config.json`（Linux/macOS）或 `%USERPROFILE%\\.local\\share\\copilot-api\\config.json`（Windows）

默认值（按当前代码）：

```json
{
  "auth": {
    "apiKeys": []
  },
  "providers": {},
  "extraPrompts": {
    "gpt-5-mini": "<built-in prompt>",
    "gpt-5.3-codex": "<built-in prompt>",
    "gpt-5.4-mini": "<built-in prompt>",
    "gpt-5.4": "<built-in prompt>"
  },
  "smallModel": "gpt-5-mini",
  "freeModelLoadBalancing": true,
  "responsesApiContextManagementModels": [],
  "modelReasoningEfforts": {
    "gpt-5-mini": "low",
    "gpt-5.3-codex": "xhigh",
    "gpt-5.4-mini": "xhigh",
    "gpt-5.4": "xhigh"
  },
  "allowOriginalModelNamesForAliases": false,
  "useFunctionApplyPatch": true,
  "compactUseSmallModel": true,
  "messageStartInputTokensFallback": false,
  "modelRefreshIntervalHours": 24,
  "useMessagesApi": true
}
```

关键字段说明：

| 字段 | 说明 |
| --- | --- |
| `auth.apiKeys` | 业务 API 鉴权 key 列表（推荐） |
| `apiKey` | 旧版单 key（弃用兼容） |
| `providers` | 上游 provider 映射（Anthropic 兼容代理路由）：每个 key 会生成 `/:provider/v1/messages`、`/:provider/v1/models` 等路由前缀；目前仅支持 `type: "anthropic"`；可选 `models` 定义 `temperature/topP/topK` 默认值；可选 `adjustInputTokens` 用于从 usage 的 `input_tokens` 中扣除缓存读写 token。 |
| `extraPrompts` | 按模型附加 system prompt（在 Anthropic 请求翻译时注入；内置默认项包含 `gpt-5.3-codex`、`gpt-5.4-mini`、`gpt-5.4`） |
| `smallModel` | 小模型（预热/compact 场景回落） |
| `freeModelLoadBalancing` | 免费模型是否轮询分发 |
| `responsesApiContextManagementModels` | 需要注入 Responses API `context_management` 压缩指令的模型 ID 列表（用于支持服务端 context management 的模型）。 |
| `modelReasoningEfforts` | Responses API 的模型推理强度配置 |
| `modelAliases` | 模型别名映射（支持 `allowOriginal`） |
| `allowOriginalModelNamesForAliases` | 别名目标模型原名是否全局可用 |
| `useFunctionApplyPatch` | 是否将 `custom/apply_patch` 转换为 function tool |
| `forceAgent` | Responses 中 assistant 角色判定策略 |
| `compactUseSmallModel` | compact 请求自动使用 smallModel |
| `useMessagesApi` | 是否允许 `/v1/messages` 优先尝试 Copilot 原生 Messages API；关闭时将跳过该候选并从 `/responses`（如支持）或 `/chat/completions` 回退。 |
| `messageStartInputTokensFallback` | Anthropic 流式首包 token 估算回退 |
| `modelRefreshIntervalHours` | 模型刷新周期（小时，`0` 关闭） |

### providers 示例（Anthropic 上游代理）

`providers` 用于将本服务作为“Anthropic 兼容代理”，转发请求到你自定义的 Anthropic-compatible 上游。

- provider key 会作为路由前缀（例如 `custom` -> `http://localhost:4141/custom/v1/messages`）
- `baseUrl` 为上游 API base URL（不要带尾部 `/v1/messages`）
- `enabled` 省略时默认 `true`
- `adjustInputTokens=true` 时，会将 usage 中的 `input_tokens` 扣除 `cache_read_input_tokens` 与 `cache_creation_input_tokens`
- `models` 为可选的按模型默认参数配置（仅在请求未显式指定时生效）

```json
{
  "providers": {
    "custom": {
      "type": "anthropic",
      "enabled": true,
      "baseUrl": "https://api.anthropic.com",
      "apiKey": "sk-your-provider-key",
      "adjustInputTokens": false,
      "models": {
        "kimi-k2.5": {
          "temperature": 1,
          "topP": 0.95,
          "topK": 50
        }
      }
    }
  }
}
```

### 配置热更新

可通过 Admin UI 或 Admin API 修改配置：

- Admin UI：`/admin#/settings`
- Admin API：
  - `GET /api/admin/config`
  - `POST /api/admin/config`

`POST` 支持部分字段 patch，包含类型校验与安全键过滤（如 `__proto__` 会被拒绝）。更新成功后会立即应用关键运行参数（如免费模型负载均衡、模型刷新间隔）。

## API 端点清单

### 基础与兼容路由

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/` | `GET` | 健康响应（`Server running`） |
| `/chat/completions` | `POST` | OpenAI Chat Completions（兼容） |
| `/models` | `GET` | 模型列表（兼容） |
| `/embeddings` | `POST` | Embeddings（兼容） |
| `/responses` | `POST` | OpenAI Responses（兼容） |

### OpenAI 兼容

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/v1/chat/completions` | `POST` | 聊天补全 |
| `/v1/models` | `GET` | 模型列表 |
| `/v1/embeddings` | `POST` | 向量生成 |
| `/v1/responses` | `POST` | Responses 接口 |

### Anthropic 兼容

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/v1/messages` | `POST` | Messages 接口 |
| `/v1/messages/count_tokens` | `POST` | Token 计数 |
| `/:provider/v1/messages` | `POST` | 代理转发 Anthropic Messages API 到配置的 provider |
| `/:provider/v1/models` | `GET` | 代理转发 Anthropic Models API 到配置的 provider |
| `/:provider/v1/messages/count_tokens` | `POST` | provider 路由的 token 计数（本地计算） |

### 使用与状态

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/usage` | `GET` | 账号运行状态列表 |
| `/usage/:accountIndex` | `GET` | 按索引查询账号配额详情（0-based） |
| `/token` | `GET` | 当前 Copilot token |

### 管理端

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/admin` | `GET` | 内置管理界面 |
| `/api/admin/meta` | `GET` | Admin DB 元信息 |
| `/api/admin/config` | `GET/POST` | 配置读取与更新 |
| `/api/admin/models` | `GET` | 模型与别名列表 |
| `/api/admin/models/details` | `GET` | 模型能力详情 |
| `/api/admin/accounts` | `GET` | 账号状态与可选统计 |
| `/api/admin/requests` | `GET` | 请求日志查询（分页/过滤） |
| `/api/admin/requests/:requestId` | `GET` | 单条请求明细 |

## 多账号与路由策略

### 0) Messages 上游回退链路

`POST /v1/messages` 在选择可用上游时，会按候选顺序尝试（候选集受 `useMessagesApi` 影响）：

- 当 `useMessagesApi=true`（默认）：
  1. `"/v1/messages"`
  2. `"/responses"`
  3. `"/chat/completions"`
- 当 `useMessagesApi=false`：
  1. `"/responses"`
  2. `"/chat/completions"`

系统会结合模型可用性、账号状态与配额结果选择最终路径。

### 1) 账号顺序与临时账号

- `--github-token` 注入的临时账号优先级最高
- 之后按 `auth add` 的注册顺序依次选择

### 2) 免费模型策略

- 默认开启轮询（Round-Robin）：`freeModelLoadBalancing=true`
- 关闭后改为顺序路由

### 3) 付费模型策略

- 按账号顺序尝试
- 配额缓存过期（45 秒）时会刷新配额
- 采用“预留 + 完成后结算”机制避免并发超配额
- 若账号允许 overage，会作为最后回退候选

### 4) 模型别名策略

- 请求模型不可用时，会尝试将模型名按别名映射后重试选择
- 可配置为“仅允许别名，不允许目标模型原名”

### 5) 自动刷新

- token 自动刷新（按上游返回 `refresh_in` 提前刷新）
- 模型列表按 `modelRefreshIntervalHours` 定时刷新
- 账号注册表文件变更会触发热重载

## Admin UI / Admin API 运维要点

### Admin UI

- 入口：`/admin`
- 支持账户视图与请求视图
- Admin token 存储在浏览器 `sessionStorage`

### 账号状态查询（`/api/admin/accounts`）

- `include_stats`：是否包含聚合统计（默认开启，`0` 可关闭）
- `since_ms`：统计起始时间戳（毫秒，默认近 24 小时）

### 请求日志查询参数（`/api/admin/requests`）

- 分页：
  - `limit`（默认 50，最大 200）
  - `cursor_id`
- 过滤：
  - `account_id`
  - `upstream_model`
  - `client_model`
  - `upstream_endpoint`
  - `path`
  - `status`
  - `has_error`（`1`/`0`）
  - `from_ms`
  - `to_ms`

响应字段：

- `items`
- `next_cursor_id`
- `has_more`

### 存储与保留策略

- DB 文件：`admin.sqlite`
- 默认保留：14 天
- 最大行数：200000
- 仅存请求元数据，不存 GitHub/Copilot token，也不存完整请求/响应正文

## Claude Code 与 Agent 相关能力

- `start --claude-code`：交互选择主模型与小模型，并生成可直接运行的环境变量命令（尝试复制到剪贴板）
- `/v1/messages` 支持从首条 user 消息解析子代理 marker（`__SUBAGENT_MARKER__`）
- Messages 路由支持 compact/warmup 识别并回退到 `smallModel`（由配置控制）
- Responses 路由会去除 `web_search` 工具；可选将 `apply_patch` 自定义工具改写为 function tool

## 常见问题与排障

| 现象 | 常见原因 | 处理建议 |
| --- | --- | --- |
| 业务接口 `401 Unauthorized` | 已配置 API key 但请求未带 key 或 key 错误 | 校验 `auth.apiKeys` 与请求头 |
| Admin 接口 `403 Forbidden` | 非 localhost 且未配置 `ADMIN_TOKEN`，或跨源被拒 | 设置 `ADMIN_TOKEN` 并用请求头传递 |
| Admin 接口 `401 Unauthorized` | 已配置 `ADMIN_TOKEN` 但请求未带或错误 | 使用 `x-admin-token` 或 `Authorization: Bearer` |
| `429 Rate limit exceeded` | 触发 `--rate-limit` 且未启用 `--wait` | 增加间隔或启用 `--wait` |
| `429` 且提示账号配额耗尽 | 全部账号 premium 配额不足 | 等待刷新、增加账号、切换免费模型 |
| `400 MODEL_NOT_SUPPORTED` | 模型在当前账号不可用，或目标模型名被别名策略阻止 | 改用可用模型或使用配置的别名名 |
| `/usage/:index` 查错账号 | 索引是 0-based，且临时账号占用 `0` | 先看 `/usage` 返回顺序再查询 |

排障命令建议：

```sh
npx @nick3/copilot-api@latest debug --json
npx @nick3/copilot-api@latest auth ls -q
curl "http://localhost:4141/api/admin/meta"
```

## 常用命令速查

```sh
# 启动
npx @nick3/copilot-api@latest start --port 4141

# 启动（限速+等待）
npx @nick3/copilot-api@latest start --rate-limit 30 --wait

# 添加账号
npx @nick3/copilot-api@latest auth add

# 列出账号与配额
npx @nick3/copilot-api@latest auth ls -q

# 删除账号（1-based index 或 id）
npx @nick3/copilot-api@latest auth rm 2

# 终端查看当前 token 配额
npx @nick3/copilot-api@latest check-usage

# 使用全局参数（需在子命令前传入，推荐 `--key=value` 形式）
npx @nick3/copilot-api@latest --api-home=/path/to/custom/dir start
npx @nick3/copilot-api@latest --enterprise-url=company.ghe.com start
npx @nick3/copilot-api@latest --oauth-app=opencode start
npx @nick3/copilot-api@latest --api-home=/custom/path --oauth-app=opencode --enterprise-url=company.ghe.com start
```

---

如需英文说明，请参考 `README.md`。
