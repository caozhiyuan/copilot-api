# Docker deployment

The image runs as the unprivileged `bun` user, keeps persistent state in `/data`, and keeps application code root-owned. Compose publishes the host port on `127.0.0.1` by default. A gateway API key is still required because the server listens on `0.0.0.0` inside the container; a GitHub token does not replace it.

## New installation

From the repository root:

```sh
cp .env.example .env
docker compose build
docker compose run --rm copilot-api auth keys --add YOUR_GATEWAY_API_KEY
docker compose run --rm copilot-api auth login
docker compose up -d --no-build
docker compose ps
```

Choose a strong gateway key. The CLI key argument can appear in shell history and the process list: initialize it only on a trusted host. Never paste real keys into issues or logs. Login is interactive; alternatively set `COPILOT_API_GITHUB_TOKEN` in your untracked `.env`. It takes precedence over legacy `GH_TOKEN`. Avoid putting tokens on the command line and protect environment files with appropriate host permissions.

The default `copilot-api:local` image is built from this checkout. To use a published image that supports this deployment contract, set `COPILOT_API_IMAGE` to its version tag or digest, then run `docker compose pull` and `docker compose up -d --no-build`. Do not assume older images support `/data` or this entrypoint. This change does not alter the repository's image publishing or tag policy.

The project-scoped `copilot-api-data` named volume survives container recreation and `docker compose down`. **Do not use `docker compose down -v` unless intentionally deleting your data.** Keep the same Compose project name when upgrading. Compose uses a read-only root filesystem, a writable temporary filesystem, dropped capabilities, no-new-privileges, and bounded logs. Authentication commands use the same volume and restrictions as the server. `XDG_CACHE_HOME` points at `/data/cache` so the VSCode device ID persists on the writable volume; without it, the read-only root filesystem forces an ephemeral device ID on every container recreation.

## Existing bind mounts

**Do not switch an existing bind mount to the base Compose file alone:** that selects a different, initially empty named volume. After the backup and ownership preparation below, preserve the original host directory with the explicit bind-mount override:

```sh
export COPILOT_API_DATA_DIR=/absolute/path/to/existing/data
docker compose -f docker-compose.yaml -f docker-compose.bind.yaml config --quiet
docker compose -f docker-compose.yaml -f docker-compose.bind.yaml run --rm copilot-api auth keys --list
docker compose -f docker-compose.yaml -f docker-compose.bind.yaml up -d --no-build
```

Build the new image first, or explicitly pull a compatible registry image. Use the same override and Compose project name for all subsequent commands, including authentication. `auth keys --list` displays keys: run it privately. The override defaults to `./copilot-data` and refuses to auto-create a missing directory, catching path typos instead of silently starting with empty state. Preserve your existing token, proxy and host-binding settings; do not overwrite an existing environment file.

## Root-image or old-path migration

The former image used `/root/.local/share/copilot-api`. Changing the image or mount target does not migrate ownership, and the Dockerfile's `chown /data` does not change a host bind mount. Do not run the gateway as root to work around this.

1. Record the current image digest, Compose project name and mount source using `docker inspect`. Stop the old service before backing up, especially because state can include SQLite databases and sidecar files.
2. Back up the **whole** existing data directory to a protected location outside the build context. Include configuration, GitHub tokens, provider credentials, databases and OAuth-app subdirectories without printing their contents.
3. Keep the original host source and change only the mount target to `/data`. Inspect the target image's UID/GID rather than assuming numeric IDs.
4. Correct ownership of the selected directory and all its files, not just the directory. Root-owned `0600` files remain unreadable after changing only their parent.
5. Run `auth keys --list` privately with the new image and the same mount. Confirm provider configuration is preserved, start the service, and check health and an authenticated request. Retain the backup for rollback.

Example on a Linux host with a rootful Docker daemon, **after stopping and backing up the old service** and building the new image:

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

Verify the resolved path before recursive ownership commands. Do not use `chmod 777`, change unrelated directories, or recursively rewrite file contents. Rootless Docker and user-namespace remapping require the corresponding host UID mapping; this rootful example does not apply unchanged. Docker Desktop and SELinux hosts have different sharing/label requirements. Test the mount with the intended runtime identity before starting.

For rollback, stop the new service and restore the protected backup plus the old image and mount definition. Do not delete current state while investigating a failure. The existing upstream config-preservation behavior propagates errors other than a genuinely missing config rather than replacing existing configuration; the entrypoint adds a clear permission diagnostic before startup.

## Ports, proxies and health

- Host publication uses `COPILOT_API_BIND` and `COPILOT_API_PORT`. The Compose container port stays 4141. Do not change only the internal CLI port without updating the port mapping.
- With `docker run`, CLI `--port` / `-p` overrides `PORT`, which otherwise defaults to 4141. The health probe reads the actual bound address, including IPv6 and dynamically allocated ports, from `COPILOT_API_HEALTHCHECK_FILE` under `/tmp`, not persistent data.
- Server startup enables proxy environment handling; `--no-proxy-env` disables it. Compose forwards upper- or lower-case HTTP/HTTPS/ALL/NO proxy variables, preferring nonempty uppercase values. HTTP proxy support does not imply every SOCKS configuration is supported.
- `127.0.0.1` in a proxy URL means the container, not the host. Use a reachable address. On Linux, an explicitly configured `host-gateway` mapping may be needed for a host proxy.
- Health checks bypass proxies and use bounded timeouts. This checks local liveness, not GitHub credentials, provider availability or quota. Docker health status alone does not restart an unhealthy container; `restart: unless-stopped` responds to process exit.
- For a corporate CA, mount the trusted bundle read-only and configure the runtime's CA input. Never disable certificate verification to make a proxy work.

## Tests

The separate Docker test workflow validates both Compose configurations, runs application tests, and builds and runs the image natively on Linux AMD64 and ARM64. It does not publish images or request package-write permission. Integration tests use disposable test volumes, synthetic keys, no outbound container network, and the same filesystem/capability restrictions as Compose.

```sh
bun test tests/docker-entrypoint.test.ts tests/docker-healthcheck.test.ts tests/server-health.test.ts tests/server-startup-health.test.ts
docker build -t copilot-api:test .
COPILOT_API_DOCKER_TEST_IMAGE=copilot-api:test bun test tests/docker-smoke.test.ts
```

Without the environment variable, smoke tests are skipped. They do not touch deployed containers or existing data volumes.
