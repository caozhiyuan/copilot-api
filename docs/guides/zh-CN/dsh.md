# DeepSeek Harness

[项目首页](../../../README.zh-CN.md) · [文档目录](README.md) · [English](../en/dsh.md)

<a id="using-with-deepseek-harness"></a>

## 与 DeepSeek Harness 一起使用

先启动网关，再把 [dsh-copilot-api](https://github.com/caozhiyuan/dsh-copilot-api) 安装到已有的 Harness profile：

```sh
npx @jeffreycao/copilot-api@latest start
dsh plugin --profile web add dsh-copilot-api
```

首次安装后重启 Harness。插件会插入条目 `copilot-api-provider`，profile 里不用再加配置。

默认值：

- `baseURL`：`http://localhost:4141`（可以带 `/v1`，也可以不带）
- `protocol`：`openai-responses`
- 凭据引用：`GITHUB_COPILOT_API_KEY`

桌面端的“客户端接入”页可一键配置地址、密钥并安装插件。它会更新 `$DSH_HOME/.env`（默认 `~/.dsh/.env`），保留其他变量及首次备份：

```dotenv
COPILOT_API_BASE_URL=http://localhost:4141
GITHUB_COPILOT_API_KEY=dummy
```

启用网关鉴权时将 `dummy` 换成网关 API Key，然后重启 Harness。插件以 `COPILOT_API_BASE_URL` 作为默认地址，profile 显式地址配置优先；启动环境变量和 Harness 已保存的凭据优先于 `.env`。

在模型设置卡片中点击“保存 API 密钥”，或写入 Harness 凭据、同名启动环境。配置里只填引用名，不填密钥明文。使用 Messages 时，把 `protocol` 改为 `anthropic-messages`。

只有默认值不合适时才覆盖这个条目。保留 ID `copilot-api-provider`，并写上仍然需要的全部连接字段：

```yaml
- id: copilot-api-provider
  config:
    baseURL: http://localhost:4141
    apiKey: GITHUB_COPILOT_API_KEY
    protocol: openai-responses
    modelRefreshInterval: 120000
```

`apiKey` 是凭据引用名。`apiKeyEnv` 也是引用名；两者同时填写时必须相同。`headers` 可以填写自定义请求头。`modelRefreshInterval` 单位是毫秒，默认 `120000` 表示每 2 分钟自动刷新；设为 `0` 可关闭定时刷新。

模型映射、Header 和开发说明见[插件仓库](https://github.com/caozhiyuan/dsh-copilot-api)。
