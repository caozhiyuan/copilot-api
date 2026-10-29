import { app } from 'electron'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { MacDmgUpdater } from '../../desktop/electron/mac-dmg-updater'

async function main() {
  const directory = process.env.EXPERIMENT_DIR!
  const userData = path.join(directory, 'download-client')
  await mkdir(userData, { recursive: true })
  app.setPath('userData', userData)
  await app.whenReady()
  const packages = new Map<string, { file: string; size: number; sha512: string }>()
  for (const [version, source] of [['999.0.1', 'old'], ['999.0.2', 'new']]) {
    const file = path.join(directory, `${source}.dmg`)
    const bytes = await readFile(file)
    packages.set(version, { file, size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64') })
  }
  let version = '999.0.1'
  let rangeBytes = 0
  let fullBytes = 0
  const filename = (v: string) => `Copilot.API-${v}-${process.arch}.dmg`
  const server = http.createServer((request, response) => {
    void (async () => {
      const current = packages.get(version)!
      const url = decodeURIComponent(new URL(request.url!, 'http://localhost').pathname)
      if (url === '/latest-mac.yml' || url === '/latest-linux.yml' || url === '/latest.yml') {
        response.end(`version: ${version}\nfiles:\n  - url: ${filename(version)}\n    sha512: ${current.sha512}\n    size: ${current.size}\npath: ${filename(version)}\nsha512: ${current.sha512}\n`)
        return
      }
      const selected = [...packages].find(([v]) => url === `/${filename(v)}` || url === `/${filename(v)}.blockmap`)
      if (!selected) { response.writeHead(404).end(); return }
      const file = selected[1].file + (url.endsWith('.blockmap') ? '.blockmap' : '')
      const size = (await stat(file)).size
      const range = request.headers.range?.match(/^bytes=(\d+)-(\d+)$/)
      if (request.headers.range && !range) { response.writeHead(400).end(); return }
      if (range) {
        const start = Number(range[1]), end = Math.min(Number(range[2]), size - 1)
        rangeBytes += end - start + 1
        response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
        createReadStream(file, { start, end }).pipe(response)
      } else {
        if (!url.endsWith('.blockmap')) fullBytes += size
        response.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes' })
        createReadStream(file).pipe(response)
      }
    })().catch(error => { console.error(error); response.destroy(error) })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const updater = new MacDmgUpdater(path.join(directory, 'Downloads'))
  updater.forceDevUpdateConfig = true
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  const config = path.join(directory, 'app-update.yml')
  await writeFile(config, `updaterCacheDirName: copilot-api-ci-${process.env.GITHUB_RUN_ID}\n`)
  updater.updateConfigPath = config
  updater.setFeedURL({ provider: 'generic', url: `http://127.0.0.1:${address.port}`, useMultipleRangeRequest: false })
  updater.on('error', error => console.error('updater error', error))
  const downloaded: string[] = []
  updater.on('update-downloaded', event => downloaded.push(event.downloadedFile))
  await updater.checkForUpdates()
  await updater.downloadUpdate()
  assert.equal(downloaded.length, 1)
  await updater.verifyPackage(downloaded[0])
  assert.equal(fullBytes, packages.get('999.0.1')!.size)
  version = '999.0.2'
  rangeBytes = 0; fullBytes = 0
  await updater.checkForUpdates()
  await updater.downloadUpdate()
  assert.equal(downloaded.length, 2)
  await updater.verifyPackage(downloaded[1])
  const result = {
    arch: process.arch, fullSize: packages.get(version)!.size, rangeBytes, fullBytes,
    savedFraction: 1 - (rangeBytes + fullBytes) / packages.get(version)!.size,
    installedAppWasNotTheCacheVersion: true,
    exportedPackage: downloaded[1],
  }
  await writeFile(path.join(directory, 'download-result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
  assert(rangeBytes > 0, 'Second update must issue HTTP range requests')
  assert.equal(fullBytes, 0, 'Valid baseline must not require a full second download')
  assert(rangeBytes < result.fullSize, 'The experiment should save network bytes')
  await new Promise<void>(resolve => server.close(() => resolve()))
  app.exit(0)
}
void main().catch(error => { console.error(error); app.exit(1) })
