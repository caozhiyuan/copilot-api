# Copilot API (Embedded)

Runs `copilot-api` inside VS Code as an extension, so you can start/stop the local server without installing Bun separately.

## Commands

- `Copilot API: Start Server`
- `Copilot API: Stop Server`
- `Copilot API: Restart Server`
- `Copilot API: Copy Endpoint`
- `Copilot API: Open Usage Viewer`

## Settings

- `copilotApi.port` (number, default `4141`): Port to listen on (localhost only)
- `copilotApi.verbose` (boolean): Verbose logging
- `copilotApi.accountType` (`individual` | `business` | `enterprise`)
- `copilotApi.rateLimitSeconds` (number | null): Minimum seconds between requests
- `copilotApi.rateLimitWait` (boolean): Wait instead of error when rate limit is hit
- `copilotApi.proxyEnv` (boolean): Initialize proxy from `HTTP(S)_PROXY`, etc
- `copilotApi.showToken` (boolean): Log tokens (debug only)

## Usage

1. Run `Copilot API: Start Server`
2. Use the endpoint (e.g. `http://localhost:4141`) with your client
3. Use `Copilot API: Open Usage Viewer` to open the usage dashboard

## Development

- Build: `bun run build`
- Debug (Extension Host): `bun run build:debug`, then press `F5` (uses `.vscode/launch.json`)
- Package VSIX: `bun run package`
