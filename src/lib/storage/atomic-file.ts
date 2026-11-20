import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const TEMP_FILE_RANDOM_BYTES = 8

// The file-level fsync persists the contents, but the rename only updates the
// parent directory entry, which needs its own fsync to survive a crash or
// power loss. Best-effort: the rename has already taken effect, so a failure
// here only weakens crash durability and must not fail the write. Directory
// fsync is not supported on Windows (opening a directory handle fails there).
const fsyncDirectory = (directory: string): void => {
  if (process.platform === "win32") {
    return
  }

  let directoryFd: number | undefined
  try {
    directoryFd = fs.openSync(directory, "r")
    fs.fsyncSync(directoryFd)
  } catch (error) {
    console.warn(`Failed to fsync directory: ${directory}`, error)
  } finally {
    if (directoryFd !== undefined) {
      try {
        fs.closeSync(directoryFd)
      } catch {
        // Preserve the fsync warning.
      }
    }
  }
}

export function writeFileAtomically(filePath: string, content: string): void {
  const directory = path.dirname(filePath)
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(TEMP_FILE_RANDOM_BYTES).toString("hex")}.tmp`,
  )

  fs.mkdirSync(directory, { recursive: true })

  let fileDescriptor: number | undefined
  let tempFileCreated = false
  try {
    fileDescriptor = fs.openSync(tempPath, "wx", 0o600)
    tempFileCreated = true
    fs.writeFileSync(fileDescriptor, content, "utf8")
    fs.fsyncSync(fileDescriptor)
    fs.closeSync(fileDescriptor)
    fileDescriptor = undefined
    fs.renameSync(tempPath, filePath)
    tempFileCreated = false
    fsyncDirectory(directory)
  } catch (error) {
    if (fileDescriptor !== undefined) {
      try {
        fs.closeSync(fileDescriptor)
      } catch {
        // Preserve the original write error.
      }
    }

    if (tempFileCreated) {
      try {
        fs.rmSync(tempPath, { force: true })
      } catch {
        // Preserve the original write error.
      }
    }

    throw error
  }
}
