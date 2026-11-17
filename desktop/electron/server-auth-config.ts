import {
  isApiKeyActive,
  normalizeApiKeyRecord,
  normalizeApiKeyRecords,
} from '../../src/lib/api-key-config'

import {
  readEditableConfigFromDisk,
  writeConfigToDisk,
  type AppConfig,
} from '../../src/lib/config'
import { normalizeApiKeys } from '../../src/lib/request-auth'
import type { ServerKeysConfig, ServerKeysConfigUpdate } from '../src/types/ipc'

export function normalizeAdminApiKey(adminApiKey: unknown): string {
  if (typeof adminApiKey !== 'string') return ''
  return adminApiKey.trim()
}

function serverKeysFromConfig(auth: AppConfig['auth']): ServerKeysConfig {
  return {
    apiKeys: normalizeApiKeyRecords(auth?.apiKeyConfigs)
      .filter((key) => isApiKeyActive(key))
      .map((key) => key.key),
    adminApiKey: normalizeAdminApiKey(auth?.adminApiKey),
    ...(auth?.isolateApiKeyUsage === undefined ?
      {}
    : { isolateApiKeyUsage: auth.isolateApiKeyUsage === true }),
  }
}

export function readServerKeysConfig(): Promise<ServerKeysConfig> {
  return Promise.resolve(
    serverKeysFromConfig(readEditableConfigFromDisk().auth),
  )
}

// Merges only the provided auth fields into the latest config on disk, so a
// save does not clobber external updates (CLI auth keys, or a server startup
// regenerating a cleared admin key).
export function writeServerKeysConfig(
  keys: ServerKeysConfigUpdate,
): ServerKeysConfig {
  const editableConfig = readEditableConfigFromDisk()
  const auth = { ...editableConfig.auth }

  if (keys.isolateApiKeyUsage !== undefined) {
    if (typeof keys.isolateApiKeyUsage !== 'boolean')
      throw new Error('Usage isolation must be a boolean')
    auth.isolateApiKeyUsage = keys.isolateApiKeyUsage
  }

  if (keys.apiKeys !== undefined) {
    auth.apiKeyConfigs = normalizeApiKeys(keys.apiKeys).map(
      (key) =>
        normalizeApiKeyRecords(auth.apiKeyConfigs).find(
          (entry) => entry.key === key,
        ) ?? normalizeApiKeyRecord(key),
    )
  }
  if (keys.adminApiKey !== undefined) {
    const adminApiKey = normalizeAdminApiKey(keys.adminApiKey)
    if (adminApiKey) {
      auth.adminApiKey = adminApiKey
    } else {
      delete auth.adminApiKey
    }
  }

  writeConfigToDisk({ ...editableConfig, auth })
  return serverKeysFromConfig(auth)
}

export function readManagedApiKeys() {
  return normalizeApiKeyRecords(
    readEditableConfigFromDisk().auth?.apiKeyConfigs,
  )
}
