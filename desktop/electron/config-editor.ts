import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { z } from 'zod'

import { defaultConfig, writeConfigToDisk } from '../../src/lib/config-store'
import { PATHS } from '../../src/lib/paths'
import { validateConfigContent } from '../src/lib/config-editor'
import {
  ConfigEditorError,
  type ConfigEditorErrorCode,
  type ConfigEditorReply,
} from '../src/lib/config-editor-errors'
import type { AppConfigDocument, AppConfigSaveResult } from '../src/types/ipc'
import type { createConfigRefresher } from './config-refresh'

const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/)
const updateSchema = z
  .object({
    content: z.string(),
    revision: revisionSchema,
  })
  .strict()

function readSource(): { raw: string; exists: boolean } {
  try {
    return { raw: fs.readFileSync(PATHS.CONFIG_PATH, 'utf8'), exists: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { raw: '', exists: false }
    throw error
  }
}

export function readAppConfigDocument(): AppConfigDocument {
  const { raw, exists } = readSource()
  return {
    configPath: PATHS.CONFIG_PATH,
    content: raw.trim() ? raw : '{}\n',
    revision: createHash('sha256')
      .update(PATHS.CONFIG_PATH)
      .update(exists ? '\0file\0' : '\0missing\0')
      .update(raw)
      .digest('hex'),
    // This getter fallback is not part of defaultConfig's persisted defaults.
    defaultContent: JSON.stringify({
      ...defaultConfig,
      claudeTokenMultiplier: 1.15,
    }),
  }
}

function readAtRevision(revision: string): AppConfigDocument {
  const document = readAppConfigDocument()
  if (document.revision !== revision) {
    throw new ConfigEditorError(
      'conflict',
      'Config changed on disk. Reload the file before saving or applying it.',
    )
  }
  return document
}

export function writeAppConfigDocument(input: unknown): void {
  const parsed = updateSchema.safeParse(input)
  if (!parsed.success)
    throw new ConfigEditorError('validation', 'Invalid config update.')
  // Check within the shared save queue, immediately before the atomic write.
  const current = readAtRevision(parsed.data.revision)
  const config = validateConfigContent(parsed.data.content, current.content)
  writeConfigToDisk(config)
}

export function createAppConfigEditor(dependencies: {
  saveAndRefresh: ReturnType<typeof createConfigRefresher>['saveAndRefresh']
}) {
  const run = async (operation: () => void): Promise<AppConfigSaveResult> => {
    let applied = false
    let refreshError: string | undefined
    await dependencies.saveAndRefresh(operation, {
      ignoreRefreshFailure: true,
      onRefreshSuccess: () => {
        applied = true
      },
      onRefreshError: (error) => {
        refreshError = error.message
      },
    })
    // Reload can regenerate the admin key or persist migrated/default fields.
    // Return that final disk version so the next save uses the correct lease.
    return {
      ...readAppConfigDocument(),
      saved: true,
      applied,
      ...(refreshError ? { refreshError } : {}),
    }
  }
  return {
    read: readAppConfigDocument,
    save: (input: unknown) => run(() => writeAppConfigDocument(input)),
    apply: (input: unknown) => {
      const parsed = revisionSchema.safeParse(input)
      if (!parsed.success)
        return Promise.reject(
          new ConfigEditorError('validation', 'Invalid config revision.'),
        )
      return run(() => {
        const { content } = readAtRevision(parsed.data)
        validateConfigContent(content, content)
      })
    },
  }
}

// Electron serializes thrown errors with an IPC prefix and drops custom fields.
// Return a typed failure through both IPC and contextBridge. Only the renderer
// reconstructs an Error, so custom codes are never lost across either bridge.
export async function configEditorReply<T>(
  operation: () => T | Promise<T>,
  fallback: ConfigEditorErrorCode,
): Promise<ConfigEditorReply<T>> {
  try {
    return await operation()
  } catch (error) {
    return {
      error: {
        code: error instanceof ConfigEditorError ? error.code : fallback,
        ...(error instanceof ConfigEditorError && error.code === 'validation' ?
          { message: error.message }
        : {}),
      },
    }
  }
}
