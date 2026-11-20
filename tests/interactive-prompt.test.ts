import { describe, expect, test } from "bun:test"

import {
  type ClackPromptBackend,
  promptWithClack,
  shouldUseClackPrompt,
} from "~/lib/cli/interactive-prompt"

function createBackend(
  overrides: Partial<ClackPromptBackend>,
): ClackPromptBackend {
  return {
    isCancel: () => false,
    select: () => Promise.reject(new Error("Unexpected select prompt")),
    text: () => Promise.reject(new Error("Unexpected text prompt")),
    ...overrides,
  }
}

describe("interactive prompt compatibility", () => {
  test("uses Clack only for an interactive Bun process on Windows", () => {
    expect(
      shouldUseClackPrompt({
        bunVersion: "1.4.2",
        platform: "win32",
        stdinIsTTY: true,
        stdoutIsTTY: true,
        stdoutIsTTYStream: true,
      }),
    ).toBe(true)

    expect(
      shouldUseClackPrompt({
        platform: "win32",
        stdinIsTTY: true,
        stdoutIsTTY: true,
        stdoutIsTTYStream: true,
      }),
    ).toBe(false)
    expect(
      shouldUseClackPrompt({
        bunVersion: "1.4.2",
        platform: "linux",
        stdinIsTTY: true,
        stdoutIsTTY: true,
        stdoutIsTTYStream: true,
      }),
    ).toBe(false)
    expect(
      shouldUseClackPrompt({
        bunVersion: "1.4.2",
        platform: "win32",
        stdinIsTTY: false,
        stdoutIsTTY: true,
        stdoutIsTTYStream: true,
      }),
    ).toBe(false)
  })

  test("maps select options and returns the selected value", async () => {
    let receivedOptions: Parameters<ClackPromptBackend["select"]>[0] | undefined
    const backend = createBackend({
      select: (options) => {
        receivedOptions = options
        return Promise.resolve("second")
      },
    })

    const value = await promptWithClack(
      "Pick one",
      {
        type: "select",
        initial: "first",
        options: [
          "first",
          { label: "Second option", value: "second", hint: "recommended" },
        ],
      },
      backend,
    )

    expect(value).toBe("second")
    expect(receivedOptions).toEqual({
      message: "Pick one",
      initialValue: "first",
      options: [
        { label: "first", value: "first" },
        { label: "Second option", value: "second", hint: "recommended" },
      ],
    })
  })

  test("maps text options and returns the entered value", async () => {
    let receivedOptions: Parameters<ClackPromptBackend["text"]>[0] | undefined
    const backend = createBackend({
      text: (options) => {
        receivedOptions = options
        return Promise.resolve("entered")
      },
    })

    const value = await promptWithClack(
      "Enter value",
      {
        type: "text",
        default: "fallback",
        initial: "initial",
        placeholder: "placeholder",
      },
      backend,
    )

    expect(value).toBe("entered")
    expect(receivedOptions).toEqual({
      message: "Enter value",
      defaultValue: "fallback",
      initialValue: "initial",
      placeholder: "placeholder",
    })
  })

  test("preserves Consola cancellation defaults", async () => {
    const cancelled = Symbol.for("clack:cancel")
    const backend = createBackend({
      isCancel: (value) => value === cancelled,
      select: () => Promise.resolve(cancelled),
      text: () => Promise.resolve(cancelled),
    })

    expect(
      await promptWithClack(
        "Pick one",
        {
          type: "select",
          initial: "first",
          options: ["first", "second"],
        },
        backend,
      ),
    ).toBe("first")
    expect(
      await promptWithClack(
        "Enter value",
        {
          type: "text",
          default: "fallback",
          initial: "initial",
        },
        backend,
      ),
    ).toBe("fallback")
  })
})
