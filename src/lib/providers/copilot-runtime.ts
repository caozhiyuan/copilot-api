import { state } from "~/lib/state"
import { logUser, setupCopilotToken } from "~/lib/auth/token"
import { cacheModels } from "~/services/copilot/models-cache"
import {
  cacheMacMachineId,
  cacheVSCodeVersion,
  cacheVsCodeSessionId,
  cacheVsCodeDeviceId,
} from "~/services/vscode-env"

export async function setupCopilotRuntime(githubToken: string): Promise<void> {
  state.githubToken = githubToken
  await logUser()
  await cacheVSCodeVersion()
  cacheMacMachineId()
  cacheVsCodeSessionId()
  await cacheVsCodeDeviceId()
  await setupCopilotToken()
  await cacheModels()
}
