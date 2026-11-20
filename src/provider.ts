import { defineCommand } from "citty"

import { saveProviderManagementConfig } from "./lib/config/provider-management"

function providerStateCommand(enabled: boolean) {
  return defineCommand({
    meta: {
      description: `${enabled ? "Enable" : "Disable"} a configured provider`,
    },
    args: {
      name: {
        type: "positional",
        required: true,
        description: "Provider name",
      },
    },
    run({ args }) {
      try {
        saveProviderManagementConfig({
          providers: { [args.name]: { enabled } },
        })
        process.stdout.write(
          `Provider '${args.name}' ${enabled ? "enabled" : "disabled"}. Restart the running server to apply the change.\n`,
        )
      } catch (error) {
        process.stderr.write(
          `${error instanceof Error ? error.message : String(error)}\n`,
        )
        process.exitCode = 1
      }
    },
  })
}

export const provider = defineCommand({
  meta: { name: "provider", description: "Manage configured providers" },
  subCommands: {
    enable: providerStateCommand(true),
    disable: providerStateCommand(false),
  },
})
