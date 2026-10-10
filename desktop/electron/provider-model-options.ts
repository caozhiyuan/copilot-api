import { builtinProviderModelRegistry } from '../../src/lib/builtin-provider-models'
import {
  readEditableConfigFromDisk,
  type AppConfig,
} from '../../src/lib/config-store'
import {
  getModelsDevProviderModelIds,
  loadCachedModelsDevCatalog,
} from '../../src/lib/models-dev-cache'
import type { ProviderModelOptions } from '../../src/lib/types/provider-management'
import {
  isProviderModelVisible,
  resolveProviderModelsDevId,
} from '../../src/lib/provider-model-catalog'

export function buildProviderModelOptions(
  config: AppConfig,
  sources = {
    builtin: (name: string) => builtinProviderModelRegistry.getModelIds(name),
    catalog: getModelsDevProviderModelIds,
  },
): ProviderModelOptions {
  const providers: NonNullable<AppConfig['providers']> = {
    'github-copilot': {},
    ...config.providers,
  }
  return Object.fromEntries(
    Object.entries(providers)
      .filter(([name]) => name !== 'copilot')
      .map(([name, provider]) => [
        name,
        [
          ...new Set([
            ...Object.keys(provider.models ?? {}),
            ...(provider.agentsModels ?? []),
            ...sources.builtin(name),
            ...sources.catalog(resolveProviderModelsDevId(name, provider)),
          ]),
        ]
          .filter((id) => isProviderModelVisible(name, id, provider))
          .sort(),
      ]),
  )
}

export async function loadProviderModelOptions(): Promise<ProviderModelOptions> {
  await loadCachedModelsDevCatalog()
  return buildProviderModelOptions(readEditableConfigFromDisk())
}
