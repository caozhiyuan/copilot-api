import consola from "consola"

interface PromptSelectOption {
  label: string
  value: string
  hint?: string
}

interface TextPromptOptions {
  type?: "text"
  default?: string
  initial?: string
  placeholder?: string
}

interface SelectPromptOptions {
  type: "select"
  initial?: string
  options: Array<string | PromptSelectOption>
}

export type InteractivePromptOptions = SelectPromptOptions | TextPromptOptions

interface ClackSelectOptions {
  message: string
  initialValue?: string
  options: Array<PromptSelectOption>
}

interface ClackTextOptions {
  message: string
  defaultValue?: string
  initialValue?: string
  placeholder?: string
}

export interface ClackPromptBackend {
  isCancel(value: unknown): boolean
  select(options: ClackSelectOptions): Promise<string | symbol>
  text(options: ClackTextOptions): Promise<string | symbol>
}

interface PromptRuntime {
  bunVersion?: string
  platform: NodeJS.Platform
  stdinIsTTY?: boolean
  stdoutIsTTY?: boolean
  stdoutIsTTYStream?: boolean
}

// Consola 3.4.2 bundles a prompt implementation that writes keyboard input to
// tty fd 0. Bun treats that as a real stdin write on Windows and throws EPIPE.
export function shouldUseClackPrompt(
  runtime: PromptRuntime = {
    bunVersion: process.versions.bun,
    platform: process.platform,
    stdinIsTTY: process.stdin.isTTY,
    stdoutIsTTY: process.stdout.isTTY,
    stdoutIsTTYStream: typeof process.stdout.getColorDepth === "function",
  },
): boolean {
  return Boolean(
    runtime.platform === "win32"
      && runtime.bunVersion
      && runtime.stdinIsTTY
      && runtime.stdoutIsTTY
      && runtime.stdoutIsTTYStream,
  )
}

function getCancelValue(options: InteractivePromptOptions): string | undefined {
  return options.type === "select" ?
      options.initial
    : (options.default ?? options.initial)
}

export async function promptWithClack(
  message: string,
  options: InteractivePromptOptions,
  backend: ClackPromptBackend,
): Promise<string | undefined> {
  if (options.type === "select") {
    const value = await backend.select({
      message,
      options: options.options.map((option) =>
        typeof option === "string" ? { label: option, value: option } : option,
      ),
      initialValue: options.initial,
    })
    if (backend.isCancel(value)) {
      return getCancelValue(options)
    }
    return typeof value === "string" ? value : undefined
  }

  const value = await backend.text({
    message,
    defaultValue: options.default,
    initialValue: options.initial,
    placeholder: options.placeholder,
  })
  if (backend.isCancel(value)) {
    return getCancelValue(options)
  }
  return typeof value === "string" ? value : undefined
}

export async function prompt(
  message: string,
  options: InteractivePromptOptions,
): Promise<string | undefined> {
  if (!shouldUseClackPrompt()) {
    if (options.type === "select") {
      const value = await consola.prompt(message, options)
      return typeof value === "string" ? value : undefined
    }
    return await consola.prompt(message, options)
  }

  const clack = await import("@clack/prompts")
  return await promptWithClack(message, options, clack)
}
