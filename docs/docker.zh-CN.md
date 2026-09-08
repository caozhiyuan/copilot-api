# Docker 部署

镜像以非特权 `bun` 用户运行，持久化数据放在 `/data`，应用代码保持 root 所有。Compose 默认只向宿主机 `127.0.0.1` 发布端口。容器内仍监听 `0.0.0.0`，启动前必须配置网关 API Key；GitHub Token 不能替代网关 Key。

## 首次安装

在仓库根目录执行：

```sh
cp .env.example .env
docker compose build
docker compose run --rm copilot-api auth keys --add YOUR_GATEWAY_API_KEY
docker compose run --rm copilot-api auth login
docker compose up -d --no-build
docker compose ps
```

使用强网关 Key。CLI 的 Key 参数可能出现在 shell 历史和进程列表中，只在可信主机上初始化，不要将真实 Key 粘贴到 issue 或日志。登录命令需要交互；也可以在未跟踪的 `.env` 中设置 `COPILOT_API_GITHUB_TOKEN`，它优先于旧变量 `GH_TOKEN`。不要把 Token 放到命令行，并限制环境文件的宿主机访问权限。

默认镜像 `copilot-api:local` 从当前源码构建。使用支持本部署约定的已发布镜像时，将 `COPILOT_API_IMAGE` 设置为版本标签或摘要，再执行 `docker compose pull` 和 `docker compose up -d --no-build`。不要假定旧镜像支持 `/data` 或新版入口脚本。本改动不调整仓库的镜像发布及标签策略。

项目级命名卷 `copilot-api-data` 在容器重建和 `docker compose down` 后仍保留。**除非明确要删除数据，不要执行 `docker compose down -v`。** 升级时保持 Compose 项目名一致。Compose 使用只读根文件系统、可写临时文件系统、移除 capabilities、禁止提权和日志轮转；认证命令与服务使用相同的数据卷和限制。

## 已有 bind mount 部署

**不要把已有 bind mount 部署直接换成基础 Compose：这会选择另一个初始为空的命名卷。** 完成下方备份及权限准备后，通过显式覆盖配置保留原宿主机目录：

```sh
export COPILOT_API_DATA_DIR=/absolute/path/to/existing/data
docker compose -f docker-compose.yaml -f docker-compose.bind.yaml config --quiet
docker compose -f docker-compose.yaml -f docker-compose.bind.yaml run --rm copilot-api auth keys --list
docker compose -f docker-compose.yaml -f docker-compose.bind.yaml up -d --no-build
```

先构建新镜像，或显式拉取兼容的仓库镜像。后续所有命令（包括认证）都使用相同覆盖配置和 Compose 项目名。`auth keys --list` 会显示 Key，请私下执行。覆盖配置默认使用 `./copilot-data`，拒绝自动创建不存在的目录，避免路径拼错后用空数据启动。保留已有 Token、代理及端口绑定设置，不要覆盖现有环境文件。

## 旧 root 镜像或旧路径迁移

旧镜像使用 `/root/.local/share/copilot-api`。替换镜像或挂载目标不会迁移所有权，Dockerfile 中的 `chown /data` 也不会修改宿主机 bind mount。不要通过让网关以 root 运行来绕过权限问题。

1. 使用 `docker inspect` 记录旧镜像摘要、Compose 项目名和挂载来源。先停止旧服务再备份，尤其是存在 SQLite 数据库及附属文件时。
2. 将**整个**旧数据目录备份到构建上下文之外的受保护位置，包括配置、GitHub Token、provider 凭据、数据库和 OAuth 应用子目录，不输出文件内容。
3. 保持宿主机来源不变，仅将容器内目标改为 `/data`。检查目标镜像实际 UID/GID，不要假定数字 ID。
4. 修正所选目录及其全部文件的所有权，而不只是父目录。只修改父目录后，root 所有的 `0600` 文件仍不可读。
5. 使用新镜像和相同挂载，私下执行 `auth keys --list`，确认 provider 配置保留，再启动服务并检查健康状态及带认证请求。保留备份用于回滚。

以下示例适用于 Linux 宿主机的 rootful Docker，必须**先停止并备份旧服务**，且已构建新镜像：

```sh
IMAGE=copilot-api:local
DATA_DIR=/absolute/path/to/existing/data
test -d "$DATA_DIR" || exit 1
test "$DATA_DIR" != / || exit 1
APP_UID=$(docker run --rm --entrypoint id "$IMAGE" -u bun)
APP_GID=$(docker run --rm --entrypoint id "$IMAGE" -g bun)
sudo chown -R "$APP_UID:$APP_GID" "$DATA_DIR"
sudo chmod 700 "$DATA_DIR"
```

递归修改所有权前检查解析后的实际路径。不要使用 `chmod 777`、修改无关目录或递归重写文件内容。Rootless Docker 和 user namespace remapping 需要对应的宿主机 UID 映射，不能照搬 rootful 示例。Docker Desktop 和 SELinux 主机也有不同的共享或标签要求。启动前使用预期的运行身份测试挂载。

回滚时停止新服务，恢复受保护的备份、旧镜像和旧挂载定义。排障时不要删除当前状态。上游已有配置保护逻辑：除真正缺少配置文件外，其他错误向上传递而不是覆盖原配置；入口脚本额外在启动前提供明确的权限诊断。

## 端口、代理和健康检查

- 宿主机端口发布使用 `COPILOT_API_BIND` 和 `COPILOT_API_PORT`；Compose 容器内固定为 4141。不要只修改内部 CLI 端口而不更新端口映射。
- 使用 `docker run` 时，CLI 的 `--port` / `-p` 优先于 `PORT`，未设置时默认 4141。健康检查通过 `/tmp` 下的 `COPILOT_API_HEALTHCHECK_FILE` 读取实际监听地址，支持 IPv6 和动态端口，不写入持久化目录。
- 服务启动默认启用代理环境变量处理，可用 `--no-proxy-env` 关闭。Compose 转发大小写 HTTP/HTTPS/ALL/NO 代理变量，优先使用非空大写值。支持 HTTP 代理不等于支持所有 SOCKS 配置。
- 代理地址中的 `127.0.0.1` 指容器自身，不是宿主机。使用容器可达地址；Linux 上访问宿主机代理可能需要显式配置 `host-gateway` 映射。
- 健康检查绕过代理并限制连接及总耗时，仅检查本地存活，不验证 GitHub 凭据、provider 可用性或额度。Docker 健康状态本身不会重启不健康容器；`restart: unless-stopped` 针对进程退出生效。
- 企业 CA 应以只读方式挂载可信证书包，并配置运行时 CA 输入。不要通过关闭证书验证来解决代理问题。

## 测试

独立 Docker 测试流程验证两种 Compose 配置、运行应用测试，并在 Linux AMD64 与 ARM64 原生构建和运行镜像，不发布镜像，也不请求 package 写权限。容器测试使用一次性测试卷、合成 Key、禁用容器外网，并采用与 Compose 相同的文件系统和权限限制。

```sh
bun test tests/docker-entrypoint.test.ts tests/docker-healthcheck.test.ts tests/server-health.test.ts tests/server-startup-health.test.ts
docker build -t copilot-api:test .
COPILOT_API_DOCKER_TEST_IMAGE=copilot-api:test bun test tests/docker-smoke.test.ts
```

未设置环境变量时 smoke 测试跳过，不接触已部署容器或已有数据卷。
