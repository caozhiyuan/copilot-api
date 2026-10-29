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
if (process.argv.includes('--install-child')) {
  await installMacUpdate({
    appPath, dmgPath: path.join(directory, 'new.dmg'), version: '2.7.44', userData,
    beforeQuit: async () => {}, quit: () => process.exit(0),
  })
} else {
  await mkdir(path.dirname(appPath), { recursive: true })
  await cp(path.join(directory, 'old/Copilot API.app'), appPath, { recursive: true, verbatimSymlinks: true })
  const child = spawn(process.execPath, [import.meta.filename, '--install-child'], { stdio: 'inherit' })
  assert.equal(await new Promise(resolve => child.once('exit', resolve)), 0)
  const updates = path.join(userData, 'updates')
  const state = path.join(updates, (await readdir(updates)).filter(name => name.startsWith('mac-install-')).sort().at(-1)!)
  let result = ''
  for (let attempt = 0; attempt < 75; attempt++) {
    result = await readFile(path.join(state, 'result'), 'utf8').catch(() => '')
    if (result || await readFile(path.join(state, 'failed'), 'utf8').catch(() => '')) break
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  await cp(state, path.join(directory, 'install-result'), { recursive: true })
  console.log('INSTALLER LOG:', await readFile(path.join(state, 'install.log'), 'utf8').catch(() => ''))
  const version = (await execute('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(appPath, 'Contents/Info.plist')])).stdout.trim()
  await writeFile(path.join(directory, 'install-result.json'), JSON.stringify({ result, version, userData }, null, 2))
  assert.equal(result.trim(), 'installed', 'New unsigned app must acknowledge startup')
  assert.equal(version, '2.7.44')
}
