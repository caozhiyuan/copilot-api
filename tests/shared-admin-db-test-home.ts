import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export const sharedAdminDbTestHome = path.join(
  os.tmpdir(),
  "copilot-api-shared-admin-db-tests",
)

// These tests share getAdminDb() within the same Bun process, so they must
// also share one stable COPILOT_API_HOME instead of racing per-file temp dirs.
await fs.mkdir(sharedAdminDbTestHome, { recursive: true })
process.env.COPILOT_API_HOME = sharedAdminDbTestHome
