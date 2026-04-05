# 按账号隔离上游客户端标识方案

## 摘要

当前 `all` 分支在非 `opencode OAuth` 模式下，会给不同上游 GitHub Copilot 账号发送相同的全局 `machine ID`、`device ID` 和 `session ID`。这会让多个账号在 GitHub 侧表现得像同一台设备和同一上游客户端会话，存在触发安全告警、风控或限制的风险。

本方案的目标是把上游客户端标识改为“按账号隔离”：

- 每个上游 GitHub Copilot 账号拥有独立的 `device ID` 和 `machine ID`
- 每个上游 GitHub Copilot 账号拥有独立的 `session ID`
- 这两组标识保存在本地，进程重启后继续复用
- `session ID` 也按账号隔离，不再由所有账号共享同一个全局会话标识
- 删除账号时保留其本地标识，后续重新添加同一账号时可继续复用

## 设计决策

### 1. 持久化位置

标识数据写入现有 `accounts-registry.json`，不新增独立文件。  
但为了兼顾“删除账号后保留标识”，registry 结构调整为两部分：

- `accounts`：当前活跃账号列表
- `clientIdentities`：按逻辑身份键 `identityKey` 建立的持久化标识映射

`identityKey` 不能只用 GitHub login。为避免不同环境下同 login 发生错误复用，建议至少包含以下维度：

- `login`
- `oauthApp`
- `enterpriseDomain`

建议格式如下：

- 公共 GitHub + 默认 OAuth App：`public:default:octocat`
- Enterprise + 默认 OAuth App：`ghe.example.com:default:octocat`
- 公共 GitHub + opencode：`public:opencode:octocat`

建议结构如下：

```json
{
  "version": 2,
  "accounts": [
    {
      "id": "octocat",
      "accountType": "individual",
      "addedAt": 1712345678901
    }
  ],
  "clientIdentities": {
    "public:default:octocat": {
      "login": "octocat",
      "oauthApp": "default",
      "enterpriseDomain": "public",
      "deviceId": "11111111-1111-4111-8111-111111111111",
      "machineId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "createdAt": 1712345678901
    }
  }
}
```

### 2. 标识生成规则

- 格式兼容要求
  新方案生成的 `deviceId` 与 `machineId`，其外部字符串格式必须与当前代码逻辑保持一致，避免因格式变化被上游 GitHub Copilot API 拒绝。
  这里的“格式一致”指字符形状、长度、大小写、分隔符风格都保持兼容，而不是要求继续复用当前全局值。
- `deviceId`
  使用小写 UUID，格式与当前 `randomUUID().toLowerCase()` 的输出一致
  例如：`11111111-1111-4111-8111-111111111111`
- `machineId`
  不再基于全局 MAC 地址派生；改为账号首次初始化时生成一个稳定的 64 个小写十六进制字符值
  格式与当前 `createHash("sha256").digest("hex")` 的输出一致
  不允许使用大写、短位数、带分隔符或其他自定义编码形式
- `sessionId`
  改为账号级会话标识，不再使用全局 `state.vsCodeSessionId`
  保持现有“运行时生成并定时刷新”的语义，但刷新粒度改为账号级
- `createdAt`
  只用于审计和调试，不参与业务判断

### 3. 删除与复用策略

- `auth rm` 仅移除 `accounts` 中的活跃账号项和对应 token 文件
- `clientIdentities` 中该 `identityKey` 的标识不删除
- 同一逻辑身份后续重新添加时，继续复用已有 `deviceId` / `machineId`
- 账号级 `sessionId` 不要求持久化到磁盘，但必须在运行时按账号独立维护

## 运行时行为

### 1. 账号初始化

- `AccountsManager.initialize()` 加载 registry 时，同时读取每个账号对应的 `clientIdentity`
- 若某账号缺少标识，则在首次加载时补齐并写回 registry
- 每个账号初始化时，同时生成独立的 `sessionId`
- `sessionId` 的定时刷新也必须按账号独立调度，不能复用当前全局定时器
- 临时账号 `--github-token` 的运行时 `id` 仍可保留 `"(temporary)"`，以避免影响当前状态展示和选择逻辑
- 但临时账号不能再用 `"(temporary)"` 作为 identity 查找键
- 应先调用 GitHub `/user` 获取真实 login，再结合 `oauthApp` / `enterpriseDomain` 生成 `identityKey`
- 运行时建议显式区分：
  - `id`：仅用于当前进程内账号选择、状态展示、失败标记
  - `identityKey`：仅用于本地持久化 identity 的读取与复用
  - `accountLogin`：真实 GitHub login，便于调试与审计

### 2. 请求头组装

非 `opencode OAuth` 分支：

- `vscode-machineid` 改为读取账号级 `machineId`
- `editor-device-id` 改为读取账号级 `deviceId`
- `vscode-sessionid` 改为读取账号级 `sessionId`

`opencode OAuth` 分支：

- 保持现状，不发送这些标识

### 3. 兼容性

- 旧的 `version: 1` registry 在加载时自动迁移到 `version: 2`
- 迁移时为已有账号补齐 `clientIdentities`
- 迁移不得改变账号顺序，不得影响已有 token 文件
- 迁移完成后，非 `opencode OAuth` 正常请求路径统一优先使用账号级标识
- 如需保留全局 `state` 中的旧字段，只能作为短期兼容入口，不能继续作为主要数据源

## 代码改动点

### 数据模型

- 扩展 `AccountRegistry`
  增加 `version: 2` 和 `clientIdentities`
- 扩展 `AccountRuntime` / `AccountContext`
  增加账号级 `clientDeviceId`、`clientMachineId`、`clientSessionId`
- 扩展 `AccountRuntime`
  增加 `identityKey`、`accountLogin`

### 持久化与迁移

- `accounts-registry.ts`
  负责 schema 校验、v1 -> v2 迁移、按账号读取/补齐 `clientIdentity`
- 需要新增统一入口，例如：
  - `buildIdentityKey({ login, oauthApp, enterpriseDomain })`
  - `ensureAccountClientIdentity(identityKey, metadata)`
  - `getAccountClientIdentity(identityKey)`
  - `createAccountDeviceId()`
  - `createAccountMachineId()`

### 运行时上下文

- `accounts-manager.ts`
  初始化账号、热重载账号、临时账号接入时都要把账号级标识和账号级 `sessionId` 注入运行时上下文
- `handler-utils.ts` / `accounts-manager-auth.ts`
  将新增字段透传到 `AccountContext`

### 请求头

- `api-config.ts`
  `copilotHeaders()` 停止从全局 `state.macMachineId` 直接构造上游 `vscode-machineid`，改为优先读取账号上下文中的 `clientMachineId`。
  `editor-device-id` 也改为优先读取账号上下文中的账号级 `deviceId`。
  `vscode-sessionid` 也改为优先读取账号上下文中的账号级 `sessionId`

## 测试与验收

### 单元测试

- `loadRegistry()` 可将 `version: 1` 自动迁移到 `version: 2`
- 迁移后每个已有账号都拥有 `clientIdentity`
- 同一账号重复读取 `clientIdentity` 时，值保持不变
- 不同账号得到的 `deviceId` / `machineId` 不同
- 不同账号在同一进程内得到不同的 `sessionId`
- 删除账号后重新添加同一逻辑身份，仍可复用原标识
- 新生成的 `deviceId` 必须匹配当前实现的 UUID 格式
- 新生成的 `machineId` 必须匹配当前实现的 64 个小写十六进制字符格式
- `toAccountContext()` 和快照上下文会正确透传账号级标识和账号级 `sessionId`
- 非 `opencode OAuth` 下 `copilotHeaders()` 使用账号级 `machineId`
- 非 `opencode OAuth` 下 `copilotHeaders()` 使用账号级 `editor-device-id`
- 非 `opencode OAuth` 下 `copilotHeaders()` 使用账号级 `sessionId`
- `opencode OAuth` 下这些标识不发送
- 同一 login 在不同 `enterpriseDomain` 或不同 `oauthApp` 下不会错误复用同一 identity
- 临时账号与已注册同 login 账号并存时，不会因为共用运行时 `id` 而相互覆盖

### 集成场景

- 配置多个账号后，轮流发上游请求时，不同账号的 `vscode-machineid`、`editor-device-id` 和 `vscode-sessionid` 都不同
- 重启进程后，同一逻辑身份继续发送相同的 `vscode-machineid` 和 `editor-device-id`
- 同一进程内等待会话刷新时，仅对应账号的 `vscode-sessionid` 发生轮换，不影响其他账号
- registry 热重载后，新增账号或补齐过的标识会被后续请求使用

## 当前实现

以下内容描述当前分支已经落地的实际逻辑，用于避免方案与代码继续漂移。

### 1. identityKey 的构成

- 当前实现位于 `src/lib/account-client-identity.ts`
- `identityKey` 的格式为：`{enterpriseDomain}:{oauthApp}:{login}`
- `enterpriseDomain`
  - 公共 GitHub 固定为 `public`
  - 企业环境使用 `COPILOT_API_ENTERPRISE_URL` 经过 `normalizeDomain()` 后的小写域名
- `oauthApp`
  - 未设置时固定为 `default`
  - 已设置时取 `COPILOT_API_OAUTH_APP.trim().toLowerCase()`

### 2. 持久化行为

- `accounts-registry.json` 当前 schema 为 `version: 2`
- `loadRegistry()` 在读取 `version: 1` 数据时，会自动迁移到 `version: 2`
- 迁移时会为当前 `accounts` 列表中的每个账号自动补齐 `clientIdentities`
- `auth add` 在新增账号时会同步创建对应 identity
- `auth rm` 仍只删除活跃账号记录与 token 文件，不删除 `clientIdentities`

### 3. 标识生成的实际格式

- `deviceId`
  - 由 `createAccountDeviceId()` 生成
  - 实现为 `randomUUID().toLowerCase()`
  - 与当前代码旧逻辑输出格式一致
- `machineId`
  - 由 `createAccountMachineId()` 生成
  - 实现为 `createHash("sha256").update(randomUUID(), "utf8").digest("hex")`
  - 输出为 64 个小写十六进制字符
  - 与旧逻辑保持同样的外部格式，但不再基于本机 MAC 地址派生
- `sessionId`
  - 由 `createAccountSessionId()` 生成
  - 实现为 `randomUUID() + Date.now().toString()`
  - 不持久化到磁盘，只保存在账号运行时上下文中

### 4. 账号运行时注入

- `AccountRuntime` 当前新增字段：
  - `accountLogin`
  - `identityKey`
  - `clientDeviceId`
  - `clientMachineId`
  - `clientSessionId`
  - `sessionRefreshTimer`
- `AccountContext` 当前新增字段：
  - `accountLogin`
  - `clientDeviceId`
  - `clientMachineId`
  - `clientSessionId`
- `AccountsManager.initializeAccount()` 在拉取 Copilot token 前就会先调用账号级 identity 注入逻辑
- `handler-utils.ts` 和 `accounts-manager-auth.ts` 会把这些字段继续透传到服务调用层

### 5. sessionId 刷新机制

- 当前实现不再使用全局 `state.vsCodeSessionId` 作为多账号主路径
- 每个账号拥有独立的 `sessionRefreshTimer`
- 刷新策略保持与旧逻辑一致：
  - 基础间隔 `60min`
  - 抖动窗口 `20min`
- 每次刷新仅轮换对应账号的 `clientSessionId`

### 6. 临时账号的实际处理

- `--github-token` 临时账号的运行时 `id` 仍为 `"(temporary)"`
- 但 `setTemporaryAccount()` 会先调用 GitHub `/user` 获取真实 login
- identity 读取与复用使用真实 login 参与构造的 `identityKey`
- 这避免了与已注册账号共用错误的持久化键，同时不破坏当前运行时选择和状态展示逻辑

### 7. 上游请求头的当前行为

非 `opencode OAuth` 路径下：

- `editor-device-id` 优先取 `AccountContext.clientDeviceId`
- `vscode-machineid` 优先取 `AccountContext.clientMachineId`
- `vscode-sessionid` 优先取 `AccountContext.clientSessionId`

兼容兜底：

- 若调用链仍走旧单账号入口，则会回退到全局 `state.vsCodeDeviceId`、`state.macMachineId`、`state.vsCodeSessionId`
- 当前这条兜底路径仅用于兼容旧调用，不应再作为多账号主路径

### 8. 已完成的测试覆盖

当前实现已经新增或更新以下测试：

- `tests/account-client-identity.test.ts`
  - 校验 `deviceId` / `machineId` / `sessionId` 的输出格式
  - 校验 `identityKey` 和环境归一化逻辑
- `tests/accounts-registry.test.ts`
  - 校验 `version: 1 -> 2` 自动迁移
  - 校验 identity 回填
  - 校验同一 `identityKey` 的复用行为
- `tests/accounts-manager-auth.test.ts`
  - 校验快照上下文透传账号级 identity
  - 校验仅轮换 `sessionId` 不会导致 auth snapshot 失效
- `tests/api-config.test.ts`
  - 校验请求头优先使用账号级 `deviceId` / `machineId` / `sessionId`
- `tests/handler-utils.test.ts`
  - 校验 `AccountRuntime -> AccountContext` 的 identity 透传
