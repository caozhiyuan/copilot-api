import { afterEach, describe, expect, test } from "bun:test"

import {
  createToolUseSseCapture,
  isToolUseSseCaptureEnabled,
  TOOL_USE_SSE_CAPTURE_BYTE_LIMIT,
} from "~/lib/tool-use-sse-capture"

const CAPTURE_ENV = "COPILOT_API_CAPTURE_TOOLUSE_SSE"

const withCaptureEnv = (value: string | undefined, run: () => void) => {
  const previous = process.env[CAPTURE_ENV]
  if (value === undefined) delete process.env[CAPTURE_ENV]
  else process.env[CAPTURE_ENV] = value
  try {
    run()
  } finally {
    if (previous === undefined) delete process.env[CAPTURE_ENV]
    else process.env[CAPTURE_ENV] = previous
  }
}

const frame = (event: unknown): string => JSON.stringify(event)

const toolUseFrames = (
  index: number,
  id: string,
  name: string,
  fragments: Array<string>,
): Array<[string, string]> => [
  [
    "content_block_start",
    frame({
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id, name, input: {} },
    }),
  ],
  ...fragments.map((partial): [string, string] => [
    "content_block_delta",
    frame({
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: partial },
    }),
  ]),
  ["content_block_stop", frame({ type: "content_block_stop", index })],
]

const feed = (
  capture: NonNullable<ReturnType<typeof createToolUseSseCapture>>,
  frames: Array<[string, string]>,
) => {
  frames.forEach(([, received]) => capture.record(received))
}

afterEach(() => {
  delete process.env[CAPTURE_ENV]
})

describe("tool-use SSE capture gate", () => {
  test("is inert when the env gate is unset", () => {
    withCaptureEnv(undefined, () => {
      expect(isToolUseSseCaptureEnabled()).toBe(false)
      expect(createToolUseSseCapture()).toBeUndefined()
    })
  })

  test("treats explicit falsy values as disabled", () => {
    for (const value of ["", "0", "false", "off", "no", "  OFF  "]) {
      withCaptureEnv(value, () => {
        expect(isToolUseSseCaptureEnabled()).toBe(false)
        expect(createToolUseSseCapture()).toBeUndefined()
      })
    }
  })

  test("activates for truthy values", () => {
    for (const value of ["1", "true", "on", "yes"]) {
      withCaptureEnv(value, () => {
        expect(isToolUseSseCaptureEnabled()).toBe(true)
        expect(createToolUseSseCapture()).toBeDefined()
      })
    }
  })
})

describe("tool-use SSE capture verdict", () => {
  test("reports a clean boundary for well-formed verbatim tool_use", () => {
    withCaptureEnv("1", () => {
      const capture = createToolUseSseCapture()
      expect(capture).toBeDefined()
      if (!capture) return

      feed(capture, [
        [
          "message_start",
          frame({ type: "message_start", message: { content: [] } }),
        ],
        ...toolUseFrames(0, "toolu_1", "Bash", ['{"command":', '"ls -la"}']),
        ["message_stop", frame({ type: "message_stop" })],
      ])

      const summary = capture.finish()
      expect(summary.verdict).toBe("boundary-clean")
      expect(summary.toolUseBlocks).toBe(1)
      expect(summary.malformedBlocks).toBe(0)
      expect(summary.truncatedBlocks).toBe(0)
    })
  })

  test("flags malformed tool input received at the upstream boundary", () => {
    withCaptureEnv("1", () => {
      const capture = createToolUseSseCapture()
      if (!capture) return

      feed(
        capture,
        toolUseFrames(0, "toolu_bad", "Bash", [
          '{"command":',
          '"ls" court',
          "}",
        ]),
      )

      const summary = capture.finish()
      expect(summary.verdict).toBe("upstream-boundary-malformed")
      expect(summary.toolUseBlocks).toBe(1)
      expect(summary.malformedBlocks).toBe(1)
    })
  })

  test("stops retaining fragments at the capture byte limit", () => {
    withCaptureEnv("1", () => {
      const capture = createToolUseSseCapture()
      if (!capture) return

      feed(capture, [
        ...toolUseFrames(0, "toolu_large", "Read", [
          `{"path":"${"a".repeat(TOOL_USE_SSE_CAPTURE_BYTE_LIMIT)}"}`,
        ]),
      ])

      const summary = capture.finish()
      expect(summary.verdict).toBe("capture-limit-exceeded")
      expect(summary.toolUseBlocks).toBe(1)
      expect(summary.malformedBlocks).toBe(0)
      expect(summary.truncatedBlocks).toBe(1)
    })
  })

  test("ignores empty partial JSON fragments", () => {
    withCaptureEnv("1", () => {
      const capture = createToolUseSseCapture()
      if (!capture) return

      feed(
        capture,
        toolUseFrames(0, "toolu_empty_fragments", "Read", [
          "",
          '{"path":',
          "",
          '"README.md"}',
          "",
        ]),
      )

      const summary = capture.finish()
      expect(summary.verdict).toBe("boundary-clean")
      expect(summary.malformedBlocks).toBe(0)
    })
  })

  test("accepts empty tool input", () => {
    withCaptureEnv("1", () => {
      const capture = createToolUseSseCapture()
      if (!capture) return

      feed(capture, toolUseFrames(0, "toolu_3", "NoArgs", []))

      const summary = capture.finish()
      expect(summary.verdict).toBe("boundary-clean")
      expect(summary.malformedBlocks).toBe(0)
    })
  })
})
