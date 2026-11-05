import { GITHUB_COPILOT_PROVIDER } from '../../src/lib/github-copilot-provider'
import {
  getProviderManagementConfig,
  type ProviderManagementConfig,
} from '../../src/lib/provider-management'
import { readToken } from './auth'

export async function getDesktopProviderManagementConfig(
  config: ProviderManagementConfig = getProviderManagementConfig(),
): Promise<ProviderManagementConfig> {
  // List saved providers without making availability depend on a network check.
  if (await readToken()) return config

  return {
    ...config,
    providers: config.providers.filter(
      (provider) => provider.name !== GITHUB_COPILOT_PROVIDER,
    ),
  }
}
