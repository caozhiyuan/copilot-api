import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { installMacUpdate } from '../../desktop/electron/mac-update-install'

const execute = promisify(execFile)
const directory = process.env.EXPERIMENT_DIR!
const appPath = path.join(directory, 'install/Copilot API.app')
const userData = path.join(os.homedir(), 'Library/Application Support/copilot-api-desktop')
const rollback = process.argv.includes('--expect-rollback')
const desiredVersion = rollback ? '2.7.45' : '2.7.44'
if (process.argv.includes('--install-child')) {
  await installMacUpdate({
    appPath, dmgPath: path.join(directory, rollback ? 'failed.dmg' : 'new.dmg'), version: desiredVersion, userData,
    beforeQuit: async () => {
      const processes = (await execute('/bin/ps', ['-axo', 'pid=,comm='])).stdout.split('\n')
      for (const line of processes) {
        const match = line.trim().match(/^(\d+)\s+(.*)$/)
        if (match?.[2] === path.join(appPath, 'Contents/MacOS/Copilot API')) {
          const pid = Number(match[1])
          process.kill(pid, 'SIGTERM')
          for (let i = 0; i < 30; i++) {
            try { process.kill(pid, 0) } catch { break }
            await new Promise(resolve => setTimeout(resolve, 100))
          }
        }
      }
    }, quit: () => process.exit(0),
  })
} else {
  await mkdir(path.dirname(appPath), { recursive: true })
  if (!rollback) await cp(path.join(directory, 'old/Copilot API.app'), appPath, { recursive: true, verbatimSymlinks: true })
  const previousStates = await readdir(path.join(userData, 'updates')).catch(() => [])
  const child = spawn(process.execPath, [import.meta.filename, '--install-child', ...(rollback ? ['--expect-rollback'] : [])], { stdio: 'inherit' })
  assert.equal(await new Promise(resolve => child.once('exit', resolve)), 0)
  const updates = path.join(userData, 'updates')
  const state = path.join(updates, (await readdir(updates)).find(name => name.startsWith('mac-install-') && !previousStates.includes(name))!)
  let result = ''
  for (let attempt = 0; attempt < 75; attempt++) {
    result = await readFile(path.join(state, 'result'), 'utf8').catch(() => '')
    if (result || await readFile(path.join(state, 'failed'), 'utf8').catch(() => '')) break
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  await cp(state, path.join(directory, rollback ? 'rollback-result' : 'install-result'), { recursive: true })
  console.log('INSTALLER LOG:', await readFile(path.join(state, 'install.log'), 'utf8').catch(() => ''))
  if (rollback) {
    for (let attempt = 0; attempt < 15; attempt++) {
      const current = await execute('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(appPath, 'Contents/Info.plist')]).then(result => result.stdout.trim()).catch(() => '')
      if (current === '2.7.44') break
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
  const version = (await execute('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(appPath, 'Contents/Info.plist')])).stdout.trim()
  await writeFile(path.join(directory, rollback ? 'rollback-result.json' : 'install-result.json'), JSON.stringify({ result, version, userData }, null, 2))
  if (rollback) assert.equal((await readFile(path.join(state, 'failed'), 'utf8')).trim(), 'startup-failed')
  else assert.equal(result.trim(), 'installed', 'New unsigned app must acknowledge startup')
  assert.equal(version, '2.7.44')
}
