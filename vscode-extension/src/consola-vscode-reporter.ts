import type { ConsolaReporter, LogObject } from "consola"
import type * as vscode from "vscode"

import { inspect } from "node:util"

import { stripAnsi } from "./util"

function formatConsolaLogObject(logObj: LogObject): string {
  const parts: Array<string> = []

  parts.push(`[${logObj.type}]`)
  if (logObj.message) parts.push(logObj.message)

  if (typeof logObj.additional === "string") {
    parts.push(logObj.additional)
  } else if (Array.isArray(logObj.additional)) {
    parts.push(...logObj.additional)
  }

  if (Array.isArray(logObj.args) && logObj.args.length > 0) {
    parts.push(
      ...logObj.args.map((arg) => {
        if (typeof arg === "string") return arg
        return inspect(arg, { colors: false, depth: 4 })
      }),
    )
  }

  return stripAnsi(parts.join(" ").trim())
}

export function createVscodeOutputReporter(
  output: vscode.OutputChannel,
): ConsolaReporter {
  return {
    log(logObj) {
      const line = formatConsolaLogObject(logObj)
      if (line.length === 0) return
      output.appendLine(line)
    },
  }
}
