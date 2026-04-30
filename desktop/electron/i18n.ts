import { app } from 'electron'

import { translate, type LocaleKey, type LocaleVars } from '../src/locales'
import { readSettings } from './settings-store'

function getSystemLocale(): string {
  if (app.isReady()) return app.getLocale()
  return Intl.DateTimeFormat().resolvedOptions().locale
}

export async function tMain(key: LocaleKey, vars?: LocaleVars): Promise<string> {
  try {
    const settings = await readSettings()
    return translate(key, settings.language, vars, getSystemLocale())
  } catch {
    return translate(key, 'auto', vars, getSystemLocale())
  }
}
