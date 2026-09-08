import type { Server } from "srvx"

import { writeFileAtomically } from "~/lib/atomic-file"

export async function publishServerHealth(
  server: Pick<Server, "ready" | "url" | "close">,
  filePath = process.env.COPILOT_API_HEALTHCHECK_FILE,
): Promise<void> {
  if (!filePath) return

  try {
    await server.ready()
    if (!server.url) {
      throw new Error(
        "Cannot determine the listening address for the health check",
      )
    }
    const url = new URL(server.url)
    if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1"
    if (url.hostname === "[::]") url.hostname = "[::1]"
    writeFileAtomically(filePath, `${url.origin}/\n`)
  } catch (error) {
    await server.close(true)
    throw error
  }
}
