# Capturing from the live gateway

Use this workflow when the session cannot capture the existing Desktop window. It renders the version of the app that is running with data from that instance.

## Find the instance

- Identify the Desktop process and the gateway it launched. Match the listening port to the gateway's process ID so a second local gateway cannot supply the wrong data. Use saved `lastPort` as a candidate and confirm it against the listener. On macOS, `ps` and `lsof` can verify the process and listener.
- Read the current settings through `desktop/electron/settings-store.ts`. The settings file is `~/.local/share/copilot-api/desktop-config.json`. Resolve the effective API home using the running app's options and the behavior in `desktop/electron/settings-env.ts` and `src/lib/storage/paths.ts`.
- Confirm the Desktop version from the running executable or matching app bundle. For a packaged macOS build, resolve the running `Copilot API.app` bundle, read its version from `Contents/Info.plist`, and use `Contents/Resources/app.asar`. For a packaged Windows build, use `resources/app.asar` beside the executable. For a development run, use the renderer and preload from the running build.

## Read the current data

Use GET requests against the verified local gateway. Keep authentication headers in memory and disallow redirects on credential-bearing requests. Read the config JSON directly for the preview because the app's editable-config reader can persist migrations.

| View | Source |
| --- | --- |
| Dashboard | The running listener, `GET /models`, token usage totals, and the provider configuration. Use the first active client key for the model request when authentication is enabled. |
| Token usage | `GET /admin/token-usage` and its `/daily` endpoint with the selected `period`. The desktop IPC handlers also define the `/events` and `/sessions` queries for those sections. |
| API Keys | Normalize `auth.apiKeyConfigs` using `src/lib/config/api-key-config.ts`. Join the records to `GET /admin/api-keys/usage` by ID. Read the usage isolation setting from `auth.isolateApiKeyUsage`. |
| Providers | Use `getProviderManagementConfig` with the current config and apply `getDesktopProviderManagementConfig` for the Desktop view. Derive model options with `buildProviderModelOptions` and the existing cached catalog. |
| Client integrations | Use the read-only `getState` and `getModels` methods of `createClientIntegrations` in `desktop/electron/client-integrations.ts`. Use the real gateway address and resolve the live app's client data path following `desktop/electron/ipc/clients-media.ts`. |
| Advanced configuration | Use the displayed fields from the current gateway config and the corresponding defaults from `src/lib/config/config-store.ts`. |
| Server runtime and Create | Use the Desktop settings and running runtime version. Use the default Create form when there is no captured live form state. |

For admin requests use `auth.adminApiKey` as the `x-api-key` header, matching the Desktop handlers in `desktop/electron/ipc/server-usage.ts` and `desktop/electron/ipc/auth.ts`. If a request fails, check the listener identity, applicable scope, and effective API home. Preserve missing states and report a blocked view if its data remains unavailable.

## Render and capture

1. Use the running build's `out/renderer` and `out/preload/index.js`. For a packaged Electron app these can be extracted from its `app.asar` into a temporary directory, for example with the desktop dependencies' `@electron/asar`.
2. Open the renderer in a separate Electron `BrowserWindow` with temporary user data. Set the content size and scale to match the screenshot set. A hidden window with `offscreen: true` and `backgroundThrottling: false` supports predictable captures at a device scale factor of 1.
3. Serve the read-only data through the preload's IPC channels. Use `desktop/electron/preload.ts` and `desktop/src/types/ipc.ts` to match response shapes. Pass only fields needed by the captured views. Replace raw key values with masks before passing them to the renderer. Exclude private paths, request and session IDs, and account identifiers from the render input wherever they are unnecessary.
4. Open each tab in the preview. Wait for the expected live value or page state and for fonts and layout to settle. Save the renderer content as a PNG with `webContents.capturePage()` and verify the pixel dimensions on the capture host. A conflict capture can use the current config as its baseline and return a conflict for a temporary draft in the preview IPC handler.
5. Verify the images against the collected live state before replacing repository files. Describe the result as a render of the running app's data in an isolated window.
