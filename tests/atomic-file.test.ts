import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { writeFileAtomically } from "~/lib/storage/atomic-file"

const tempDirs: Array<string> = []

function createTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-file-"))
  tempDirs.push(tempDir)
  return tempDir
}

function listTempFiles(directory: string): Array<string> {
  return fs
    .readdirSync(directory)
    .filter(
      (entry) => entry.startsWith(".config.json.") && entry.endsWith(".tmp"),
    )
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe("writeFileAtomically", () => {
  test("replaces an existing file without leaving a temporary file", () => {
    const tempDir = createTempDir()
    const filePath = path.join(tempDir, "config.json")
    fs.writeFileSync(filePath, "old", "utf8")

    writeFileAtomically(filePath, "new")

    expect(fs.readFileSync(filePath, "utf8")).toBe("new")
    expect(listTempFiles(tempDir)).toEqual([])
  })

  test("preserves the target when writing the temporary file fails", () => {
    const tempDir = createTempDir()
    const filePath = path.join(tempDir, "config.json")
    fs.writeFileSync(filePath, "old", "utf8")
    const originalWriteFileSync = fs.writeFileSync
    fs.writeFileSync = ((target, ...args) => {
      if (typeof target === "number") {
        throw new Error("forced temporary write failure")
      }
      return Reflect.apply(originalWriteFileSync, fs, [target, ...args])
    }) as typeof fs.writeFileSync

    try {
      expect(() => writeFileAtomically(filePath, "new")).toThrow(
        "forced temporary write failure",
      )
    } finally {
      fs.writeFileSync = originalWriteFileSync
    }

    expect(fs.readFileSync(filePath, "utf8")).toBe("old")
    expect(listTempFiles(tempDir)).toEqual([])
  })

  test("preserves the target when the atomic replacement fails", () => {
    const tempDir = createTempDir()
    const filePath = path.join(tempDir, "config.json")
    fs.writeFileSync(filePath, "old", "utf8")
    const originalRenameSync = fs.renameSync
    fs.renameSync = (() => {
      throw new Error("forced atomic replacement failure")
    }) as typeof fs.renameSync

    try {
      expect(() => writeFileAtomically(filePath, "new")).toThrow(
        "forced atomic replacement failure",
      )
    } finally {
      fs.renameSync = originalRenameSync
    }

    expect(fs.readFileSync(filePath, "utf8")).toBe("old")
    expect(listTempFiles(tempDir)).toEqual([])
  })
})
