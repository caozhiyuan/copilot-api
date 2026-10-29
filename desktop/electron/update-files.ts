import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, constants } from 'node:fs'
import {
  copyFile,
  link,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

export async function hashUpdateFile(file: string): Promise<string> {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('base64')
}

export function normalizeUpdateHash(hash: string): string {
  return /^[a-f\d]{128}$/i.test(hash) ?
      Buffer.from(hash, 'hex').toString('base64')
    : hash
}

export async function verifyUpdateFile(
  file: string,
  sha512: string,
): Promise<void> {
  const stat = await lstat(file)
  if (
    !stat.isFile()
    || (await hashUpdateFile(file)) !== normalizeUpdateHash(sha512)
  )
    throw new Error('Update package SHA-512 checksum mismatch')
}

interface DmgBaseline {
  version: string
  sha512: string
  blockmapSha512: string
}

export async function hasDmgBaseline(cacheDir: string): Promise<boolean> {
  try {
    const value: unknown = JSON.parse(
      await readFile(path.join(cacheDir, 'dmg-baseline.json'), 'utf8'),
    )
    if (
      !value
      || typeof value !== 'object'
      || !('sha512' in value)
      || !('blockmapSha512' in value)
      || typeof value.sha512 !== 'string'
      || typeof value.blockmapSha512 !== 'string'
    )
      return false
    await verifyUpdateFile(path.join(cacheDir, 'current.dmg'), value.sha512)
    await verifyUpdateFile(
      path.join(cacheDir, 'current.blockmap'),
      value.blockmapSha512,
    )
    return true
  } catch {
    return false
  }
}

// Write the identity last. An interrupted promotion cannot leave a valid
// identity beside an installer and blockmap from different update rounds.
export async function saveDmgBaseline(
  cacheDir: string,
  file: string,
  blockmap: string,
  version: string,
  sha512: string,
): Promise<void> {
  await verifyUpdateFile(file, sha512)
  const baseline: DmgBaseline = {
    version,
    sha512: normalizeUpdateHash(sha512),
    blockmapSha512: await hashUpdateFile(blockmap),
  }
  const temporary = path.join(cacheDir, `dmg-baseline-${randomUUID()}`)
  try {
    await mkdir(temporary, { recursive: true })
    await copyFile(file, path.join(temporary, 'current.dmg'))
    await copyFile(blockmap, path.join(temporary, 'current.blockmap'))
    await writeFile(
      path.join(temporary, 'dmg-baseline.json'),
      JSON.stringify(baseline),
    )
    for (const name of ['current.dmg', 'current.blockmap', 'dmg-baseline.json'])
      await rename(path.join(temporary, name), path.join(cacheDir, name))
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export async function exportUpdatePackage(
  source: string,
  directory: string,
  filename: string,
  sha512: string,
): Promise<string> {
  if (path.basename(filename) !== filename || !filename.endsWith('.dmg'))
    throw new Error('Invalid update package filename')
  await mkdir(directory, { recursive: true })
  const temporary = path.join(directory, `.copilot-api-${randomUUID()}.part`)
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL)
    await verifyUpdateFile(temporary, sha512)
    for (let index = 0; index < 100; index++) {
      const name =
        index === 0 ? filename : `${filename.slice(0, -4)} (${index}).dmg`
      const target = path.join(directory, name)
      try {
        // Publish an already-verified file without overwriting an existing
        // download. This link is to our temporary copy, never to the cache.
        await link(temporary, target)
        return target
      } catch (error) {
        if (
          !(error instanceof Error)
          || !('code' in error)
          || error.code !== 'EEXIST'
        )
          throw error
        try {
          await verifyUpdateFile(target, sha512)
          return target
        } catch {
          // Keep a different user file (including symlinks) and try a new name.
        }
      }
    }
    throw new Error('Unable to choose an unused download filename')
  } finally {
    await rm(temporary, { force: true })
  }
}
