export const MCP_SUBCOMMAND = "mcp"

/**
 * Only a direct `copilot-api mcp` invocation takes the fast path. Global flags
 * before the subcommand (e.g. `--api-home`) or help flags after it route to
 * citty through the regular startup path. Any other trailing args after `mcp`
 * are ignored because the MCP server consumes no CLI options.
 */
export const isMcpFastPath = (argv: ReadonlyArray<string>): boolean =>
  argv[2] === MCP_SUBCOMMAND
  && !argv
    .slice(3)
    .some((argument) => argument === "-h" || argument === "--help")
