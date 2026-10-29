import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  exportUpdatePackage,
  hasDmgBaseline,
  hashUpdateFile,
  normalizeUpdateHash,
  saveDmgBaseline,
  verifyUpdateFile,
} from '../electron/update-files'

let directory: string
const bytes = Buffer.from('complete official update package')
const digest = createHash('sha512').update(bytes).digest('base64')
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'copilot-update-test-'))
  await writeFile(path.join(directory, 'new.dmg'), bytes)
  await writeFile(path.join(directory, 'new.blockmap'), 'new mapping')
})
afterEach(async () => rm(directory, { recursive: true, force: true }))

describe('update package integrity and cache', () => {
  test('verifies base64 and hexadecimal SHA-512 without accepting links or directories', async () => {
    const source = path.join(directory, 'new.dmg')
    expect(await hashUpdateFile(source)).toBe(digest)
    const hex = createHash('sha512').update(bytes).digest('hex')
    expect(normalizeUpdateHash(hex)).toBe(digest)
    expect(normalizeUpdateHash(digest)).toBe(digest)
    await verifyUpdateFile(source, hex)
    await symlink(source, path.join(directory, 'link.dmg'))
    await expect(
      verifyUpdateFile(path.join(directory, 'link.dmg'), digest),
    ).rejects.toThrow('checksum')
    await expect(verifyUpdateFile(directory, digest)).rejects.toThrow(
      'checksum',
    )
    await expect(verifyUpdateFile(source, 'wrong')).rejects.toThrow('checksum')
  })

  test('keeps a matching installer and blockmap even when the downloaded version is not installed', async () => {
    expect(await hasDmgBaseline(directory)).toBe(false)
    await saveDmgBaseline(
      directory,
      path.join(directory, 'new.dmg'),
      path.join(directory, 'new.blockmap'),
      '9.0.0',
      digest,
    )
    expect(await hasDmgBaseline(directory)).toBe(true)
    expect(
      JSON.parse(
        await readFile(path.join(directory, 'dmg-baseline.json'), 'utf8'),
      ),
    ).toMatchObject({ version: '9.0.0', sha512: digest })
    expect(
      (await readdir(directory)).some((name) =>
        name.startsWith('dmg-baseline-'),
      ),
    ).toBe(false)
    await writeFile(path.join(directory, 'current.dmg'), 'tampered')
    expect(await hasDmgBaseline(directory)).toBe(false)
  })

  test('rejects stale or malformed blockmap identities', async () => {
    await saveDmgBaseline(
      directory,
      path.join(directory, 'new.dmg'),
      path.join(directory, 'new.blockmap'),
      '1.0.0',
      digest,
    )
    await writeFile(
      path.join(directory, 'current.blockmap'),
      'different mapping',
    )
    expect(await hasDmgBaseline(directory)).toBe(false)
    for (const value of [
      'null',
      '{}',
      '{"sha512":123,"blockmapSha512":"x"}',
      '{broken',
    ]) {
      await writeFile(path.join(directory, 'dmg-baseline.json'), value)
      expect(await hasDmgBaseline(directory)).toBe(false)
    }
  })

  test('never promotes an unverified installer or missing map', async () => {
    await expect(
      saveDmgBaseline(
        directory,
        path.join(directory, 'new.dmg'),
        path.join(directory, 'new.blockmap'),
        '1.0.0',
        'wrong',
      ),
    ).rejects.toThrow('checksum')
    await expect(
      saveDmgBaseline(
        directory,
        path.join(directory, 'new.dmg'),
        path.join(directory, 'missing'),
        '1.0.0',
        digest,
      ),
    ).rejects.toThrow()
    expect(await hasDmgBaseline(directory)).toBe(false)
  })
})

describe('Downloads export', () => {
  test('exports a verified independent copy and reuses an identical existing package', async () => {
    const downloads = path.join(directory, '下载 folder')
    const output = await exportUpdatePackage(
      path.join(directory, 'new.dmg'),
      downloads,
      'Copilot.API-1.0.0-arm64.dmg',
      digest,
    )
    expect(output).toBe(path.join(downloads, 'Copilot.API-1.0.0-arm64.dmg'))
    expect(
      await exportUpdatePackage(
        path.join(directory, 'new.dmg'),
        downloads,
        path.basename(output),
        digest,
      ),
    ).toBe(output)
    await writeFile(output, 'user changed the exported package')
    expect(await hashUpdateFile(path.join(directory, 'new.dmg'))).toBe(digest)
    expect(
      (await readdir(downloads)).some((name) => name.endsWith('.part')),
    ).toBe(false)
  })

  test('does not overwrite a different download or a symlink', async () => {
    const downloads = path.join(directory, 'downloads')
    await exportUpdatePackage(
      path.join(directory, 'new.dmg'),
      downloads,
      'update.dmg',
      digest,
    )
    await writeFile(path.join(downloads, 'update.dmg'), 'user file')
    await symlink(
      path.join(directory, 'new.dmg'),
      path.join(downloads, 'update (1).dmg'),
    )
    expect(
      await exportUpdatePackage(
        path.join(directory, 'new.dmg'),
        downloads,
        'update.dmg',
        digest,
      ),
    ).toBe(path.join(downloads, 'update (2).dmg'))
    expect(await readFile(path.join(downloads, 'update.dmg'), 'utf8')).toBe(
      'user file',
    )
  })

  test('cleans temporary files and does not publish failed verification', async () => {
    const downloads = path.join(directory, 'downloads')
    await expect(
      exportUpdatePackage(
        path.join(directory, 'new.dmg'),
        downloads,
        'update.dmg',
        'bad',
      ),
    ).rejects.toThrow('checksum')
    expect(await readdir(downloads)).toEqual([])
    await expect(
      exportUpdatePackage(
        path.join(directory, 'new.dmg'),
        downloads,
        '../escape.dmg',
        digest,
      ),
    ).rejects.toThrow('filename')
    await expect(
      exportUpdatePackage(
        path.join(directory, 'new.dmg'),
        downloads,
        'update.zip',
        digest,
      ),
    ).rejects.toThrow('filename')
  })

  test('bounds conflicting filenames instead of overwriting existing files', async () => {
    const downloads = path.join(directory, 'downloads')
    await exportUpdatePackage(
      path.join(directory, 'new.dmg'),
      downloads,
      'update.dmg',
      digest,
    )
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        writeFile(
          path.join(downloads, index ? `update (${index}).dmg` : 'update.dmg'),
          'different',
        ),
      ),
    )
    await expect(
      exportUpdatePackage(
        path.join(directory, 'new.dmg'),
        downloads,
        'update.dmg',
        digest,
      ),
    ).rejects.toThrow('unused')
    expect((await readdir(downloads)).length).toBe(100)
  })
})
