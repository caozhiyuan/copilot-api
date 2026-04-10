import { afterEach, expect, mock, test } from "bun:test"

import { copyText } from "../src/lib/clipboard"

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator")
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document")

type GlobalName = "navigator" | "document"

function setGlobal(name: GlobalName, value: unknown): void {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  })
}

function restoreGlobal(name: GlobalName, descriptor?: PropertyDescriptor): void {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor)
    return
  }

  Reflect.deleteProperty(globalThis, name)
}

function createDocumentMock(execCommandResult: boolean) {
  const textarea = {
    value: "",
    style: {} as Record<string, string>,
    setAttribute: mock(() => {}),
    select: mock(() => {}),
    setSelectionRange: mock(() => {}),
    remove: mock(() => {}),
  }

  const appendChild = mock(() => textarea)
  const execCommand = mock(() => execCommandResult)
  const createElement = mock(() => textarea)

  const documentMock = {
    body: { appendChild },
    createElement,
    execCommand,
  }

  return {
    documentMock,
    textarea,
    appendChild,
    createElement,
    execCommand,
  }
}

afterEach(() => {
  restoreGlobal("navigator", originalNavigator)
  restoreGlobal("document", originalDocument)
})

test("copyText uses navigator.clipboard.writeText when available", async () => {
  const writeText = mock(async () => {})

  setGlobal("navigator", {
    clipboard: { writeText },
  })
  setGlobal("document", undefined)

  await copyText("ABCD-EFGH")

  expect(writeText).toHaveBeenCalledWith("ABCD-EFGH")
})

test("copyText falls back to document.execCommand when clipboard write fails", async () => {
  const writeText = mock(async () => {
    throw new Error("Clipboard blocked")
  })
  const { documentMock, textarea, createElement, execCommand } = createDocumentMock(true)

  setGlobal("navigator", {
    clipboard: { writeText },
  })
  setGlobal("document", documentMock)

  await copyText("ABCD-EFGH")

  expect(writeText).toHaveBeenCalledWith("ABCD-EFGH")
  expect(createElement).toHaveBeenCalledWith("textarea")
  expect(textarea.value).toBe("ABCD-EFGH")
  expect(textarea.select).toHaveBeenCalledTimes(1)
  expect(textarea.setSelectionRange).toHaveBeenCalledWith(0, "ABCD-EFGH".length)
  expect(execCommand).toHaveBeenCalledWith("copy")
  expect(textarea.remove).toHaveBeenCalledTimes(1)
})

test("copyText uses document.execCommand when navigator.clipboard is unavailable", async () => {
  const { documentMock, execCommand } = createDocumentMock(true)

  setGlobal("navigator", {})
  setGlobal("document", documentMock)

  await copyText("ABCD-EFGH")

  expect(execCommand).toHaveBeenCalledWith("copy")
})

test("copyText preserves fallback context when clipboard and legacy copy both fail", async () => {
  const writeText = mock(async () => {
    throw new Error("Clipboard blocked")
  })
  const { documentMock, execCommand } = createDocumentMock(false)

  setGlobal("navigator", {
    clipboard: { writeText },
  })
  setGlobal("document", documentMock)

  try {
    await copyText("ABCD-EFGH")
    throw new Error("Expected copyText to throw")
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("Clipboard blocked")
    expect((error as Error).message).toContain("legacy copy fallback")
  }

  expect(execCommand).toHaveBeenCalledWith("copy")
})

test("copyText preserves both errors when legacy fallback throws", async () => {
  const writeText = mock(async () => {
    throw new Error("Clipboard blocked")
  })
  const textarea = {
    value: "",
    style: {} as Record<string, string>,
    setAttribute: mock(() => {}),
    select: mock(() => {
      throw new Error("select failed")
    }),
    setSelectionRange: mock(() => {}),
    remove: mock(() => {}),
  }

  setGlobal("navigator", {
    clipboard: { writeText },
  })
  setGlobal("document", {
    body: { appendChild: mock(() => textarea) },
    createElement: mock(() => textarea),
    execCommand: mock(() => true),
  })

  try {
    await copyText("ABCD-EFGH")
    throw new Error("Expected copyText to throw")
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("Clipboard blocked")
    expect((error as Error).message).toContain("select failed")
    expect(textarea.remove).toHaveBeenCalledTimes(1)
  }
})

test("copyText throws a clear error when no copy strategy is available", async () => {
  setGlobal("navigator", undefined)
  setGlobal("document", undefined)

  try {
    await copyText("ABCD-EFGH")
    throw new Error("Expected copyText to throw")
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("Clipboard unavailable")
  }
})
