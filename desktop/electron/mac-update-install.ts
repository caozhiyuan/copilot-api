import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { constants } from 'node:fs'
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const APP_ID = 'com.copilot-api.desktop'
const STATE_ARG = '--copilot-api-update-state='

export const macInstallScript = `#!/bin/sh
set -eu
parent_pid="$1"
app="$2"
staged="$3"
backup="$4"
state="$5"
exec >>"$state/install.log" 2>&1
staging=$(/usr/bin/dirname "$staged")
cleanup() {
  # A remaining backup may be the only recoverable app after a failed restore.
  if [ ! -e "$backup" ]; then /bin/rm -rf "$staging" || true; fi
}
trap cleanup EXIT
trap 'echo interrupted >"$state/failed"; exit 1' HUP INT TERM
echo $$ >"$state/installer-ready"
i=0
while kill -0 "$parent_pid" 2>/dev/null; do
  if [ -f "$state/cancelled" ]; then exit 1; fi
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then echo parent-did-not-exit >"$state/failed"; exit 1; fi
  sleep 1
done
if [ -f "$state/cancelled" ]; then exit 1; fi
relaunch() {
  /usr/bin/open -n "$app" --args --copilot-api-update-failed || true
}
restore() {
  if [ -d "$backup" ]; then
    if [ -e "$app" ]; then /bin/mv "$app" "$staging/failed.app" || return 1; fi
    /bin/mv "$backup" "$app" || return 1
    relaunch
  fi
}
trap 'echo interrupted >"$state/failed"; restore; exit 1' HUP INT TERM
if ! /bin/mv "$app" "$backup"; then echo backup-failed >"$state/failed"; relaunch; exit 1; fi
if ! /bin/mv "$staged" "$app"; then echo replace-failed >"$state/failed"; restore; exit 1; fi
if ! /usr/bin/open -n "$app" --args "--copilot-api-update-state=$state"; then
  echo launch-failed >"$state/failed"; restore; exit 1
fi
i=0
while [ ! -f "$state/ready" ]; do
  i=$((i + 1))
  if [ "$i" -ge 45 ]; then
    if [ -f "$state/started" ]; then
      pid=$(/bin/cat "$state/started")
      case "$pid" in ''|*[!0-9]*) echo invalid-pid >"$state/failed"; exit 1;; esac
      if [ "$pid" -le 1 ]; then echo invalid-pid >"$state/failed"; exit 1; fi
      command=$(/bin/ps -p "$pid" -o comm= 2>/dev/null || true)
      case "$command" in "$app/Contents/MacOS/"*) kill -TERM "$pid" 2>/dev/null || true;; esac
      j=0
      while kill -0 "$pid" 2>/dev/null; do
        j=$((j + 1))
        if [ "$j" -ge 10 ]; then echo new-app-still-running >"$state/failed"; exit 1; fi
        sleep 1
      done
    fi
    echo startup-failed >"$state/failed"; restore; exit 1
  fi
  sleep 1
done
echo installed >"$state/result"
/bin/rm -rf "$backup"
`

export function getMacApplicationPath(executable: string): string {
  const root = path.resolve(executable, '../../..')
  if (
    !path.basename(root).endsWith('.app')
    || path.relative(root, executable) !== 'Contents/MacOS/Copilot API'
  )
    throw new Error('The running application is not a packaged Copilot API app')
  return root
}

export async function canInstallMacUpdate(appPath: string): Promise<boolean> {
  try {
    const resolved = await realpath(appPath)
    if (
      resolved.startsWith('/Volumes/')
      || resolved.includes('/AppTranslocation/')
      || !(await lstat(appPath)).isDirectory()
      || (await lstat(appPath)).isSymbolicLink()
    )
      return false
    if (path.basename(appPath) !== 'Copilot API.app') return false
    await access(appPath, constants.W_OK)
    await access(path.dirname(appPath), constants.W_OK)
    return true
  } catch {
    return false
  }
}

type Execute = (file: string, args: string[]) => Promise<{ stdout: string }>

interface InstallOptions {
  appPath: string
  dmgPath: string
  version: string
  userData: string
  beforeQuit: () => Promise<void>
  quit: () => void
  execute?: Execute
  launchInstaller?: (script: string, args: string[]) => Promise<void>
}

async function launchInstaller(script: string, args: string[]): Promise<void> {
  const child = spawn('/bin/sh', [script, ...args], {
    detached: true,
    stdio: 'ignore',
  })
  await once(child, 'spawn')
  child.unref()
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await access(path.join(args[4], 'installer-ready'))
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
  }
  child.kill()
  throw new Error('The macOS update installer did not start')
}

export async function installMacUpdate(options: InstallOptions): Promise<void> {
  if (!(await canInstallMacUpdate(options.appPath)))
    throw new Error(
      'This application location requires manual DMG installation',
    )
  const execute =
    options.execute ?? ((file, args) => exec(file, args, { encoding: 'utf8' }))
  const updates = path.join(options.userData, 'updates')
  await mkdir(updates, { recursive: true })
  const state = await mkdtemp(path.join(updates, 'mac-install-'))
  const staging = await mkdtemp(
    path.join(path.dirname(options.appPath), '.copilot-api-update-'),
  )
  const staged = path.join(staging, 'Copilot API.app')
  const backup = path.join(staging, 'previous.app')
  const mount = await mkdtemp(path.join(os.tmpdir(), 'copilot-api-dmg-'))
  let mounted = false
  let launched = false
  try {
    await execute('/usr/bin/hdiutil', [
      'attach',
      '-readonly',
      '-nobrowse',
      '-mountpoint',
      mount,
      options.dmgPath,
    ])
    mounted = true
    const source = path.join(mount, 'Copilot API.app')
    if (
      !(await lstat(source)).isDirectory()
      || (await lstat(source)).isSymbolicLink()
    )
      throw new Error('Update DMG does not contain a Copilot API application')
    const plist = path.join(source, 'Contents/Info.plist')
    for (const [key, expected] of [
      ['CFBundleIdentifier', APP_ID],
      ['CFBundleShortVersionString', options.version],
    ]) {
      const value = await execute('/usr/bin/plutil', [
        '-extract',
        key,
        'raw',
        '-o',
        '-',
        plist,
      ])
      if (value.stdout.trim() !== expected)
        throw new Error(`Update application ${key} does not match`)
    }
    await execute('/usr/bin/ditto', [source, staged])
    await execute('/usr/bin/hdiutil', ['detach', mount])
    mounted = false
    const script = path.join(state, 'install.sh')
    await writeFile(script, macInstallScript, { mode: 0o700 })
    await writeFile(
      path.join(state, 'attempt.json'),
      JSON.stringify({
        appPath: options.appPath,
        version: options.version,
      }),
      { mode: 0o600 },
    )
    await (options.launchInstaller ?? launchInstaller)(script, [
      String(process.pid),
      options.appPath,
      staged,
      backup,
      state,
    ])
    launched = true
    // Extraction and installer startup must succeed before stopping a healthy
    // gateway. The helper only replaces files after this process has exited.
    try {
      await options.beforeQuit()
      options.quit()
    } catch (error) {
      await writeFile(path.join(state, 'cancelled'), 'cancelled')
      throw error
    }
  } finally {
    if (mounted)
      await execute('/usr/bin/hdiutil', ['detach', mount]).catch(() => {})
    await rmdir(mount).catch(() => {})
    if (!launched) {
      await rm(staging, { recursive: true, force: true })
      await rm(state, { recursive: true, force: true })
    }
  }
}

export async function beginMacUpdateStartup(
  argv: string[],
  userData: string,
  appPath: string,
  version: string,
): Promise<string | null> {
  const arg = argv.find((value) => value.startsWith(STATE_ARG))
  if (!arg) return null
  const state = path.resolve(arg.slice(STATE_ARG.length))
  if (
    path.dirname(state) !== path.join(userData, 'updates')
    || !/^mac-install-[a-zA-Z0-9]+$/.test(path.basename(state))
  )
    return null
  try {
    const attempt: unknown = JSON.parse(
      await readFile(path.join(state, 'attempt.json'), 'utf8'),
    )
    if (
      !attempt
      || typeof attempt !== 'object'
      || !('appPath' in attempt)
      || !('version' in attempt)
      || attempt.appPath !== appPath
      || attempt.version !== version
    )
      return null
    await writeFile(path.join(state, 'started'), String(process.pid), {
      mode: 0o600,
    })
    return state
  } catch {
    return null
  }
}

export async function markMacUpdateReady(state: string | null): Promise<void> {
  if (state)
    await writeFile(path.join(state, 'ready'), 'ready', { mode: 0o600 })
}
