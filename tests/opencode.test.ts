import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { resolveOpencodeVersionFromNpmRoot } from "~/lib/opencode"

const tempDirs: Array<string> = []

const createNpmRoot = (): string => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-version-"))
  tempDirs.push(tempDir)
  return tempDir
}

const writePackage = (
  npmRootPath: string,
  packageName: string,
  metadata: string,
): void => {
  const packageDir = path.join(npmRootPath, ...packageName.split("/"))
  fs.mkdirSync(packageDir, { recursive: true })
  fs.writeFileSync(path.join(packageDir, "package.json"), metadata, "utf8")
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

test("resolves the installed @opencode/cli version", async () => {
  const npmRootPath = createNpmRoot()
  writePackage(npmRootPath, "@opencode/cli", '{"version":"2.2.5"}')

  const version = await resolveOpencodeVersionFromNpmRoot(npmRootPath)
  expect(version).toBe("2.2.5")
})

test("falls back to the legacy opencode-ai package", async () => {
  const npmRootPath = createNpmRoot()
  writePackage(npmRootPath, "opencode-ai", '{"version":"1.19.5"}')

  const version = await resolveOpencodeVersionFromNpmRoot(npmRootPath)
  expect(version).toBe("1.19.5")
})

test("prefers @opencode/cli when both packages are installed", async () => {
  const npmRootPath = createNpmRoot()
  writePackage(npmRootPath, "@opencode/cli", '{"version":"2.2.5"}')
  writePackage(npmRootPath, "opencode-ai", '{"version":"1.19.5"}')

  const version = await resolveOpencodeVersionFromNpmRoot(npmRootPath)
  expect(version).toBe("2.2.5")
})

test.each(["{}", '{"version":""}'])(
  "tries the legacy package after malformed scoped metadata %j",
  async (metadata) => {
    const npmRootPath = createNpmRoot()
    writePackage(npmRootPath, "@opencode/cli", metadata)
    writePackage(npmRootPath, "opencode-ai", '{"version":"1.19.5"}')

    const version = await resolveOpencodeVersionFromNpmRoot(npmRootPath)
    expect(version).toBe("1.19.5")
  },
)

test("rejects when neither package is installed", async () => {
  const npmRootPath = createNpmRoot()

  const result = await resolveOpencodeVersionFromNpmRoot(npmRootPath).catch(
    (error: unknown) => error,
  )
  expect(result).toBeInstanceOf(Error)
})
