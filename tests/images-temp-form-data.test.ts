import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { Writable } from "node:stream"

import {
  MultipartBodyTooLargeError,
  multipartStagingDependencies,
  stageMultipartBodyToDisk,
  type MultipartStagingLimits,
} from "~/routes/images/temp-form-data"

async function stage(
  formData: FormData,
  limits: Partial<MultipartStagingLimits> = {},
) {
  const response = new Response(formData)
  const contentType = response.headers.get("content-type")
  if (!contentType || !response.body) {
    throw new Error("Failed to build a multipart request body")
  }
  return await stageMultipartBodyToDisk(response.body, contentType, limits)
}

async function expectTooLarge(
  formData: FormData,
  limits: Partial<MultipartStagingLimits>,
): Promise<void> {
  let error: unknown
  try {
    await stage(formData, limits)
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(MultipartBodyTooLargeError)
}

const listStagingDirectories = (): Array<string> =>
  readdirSync(tmpdir())
    .filter((name) => name.startsWith("copilot-api-images-"))
    .sort()

describe("stageMultipartBodyToDisk", () => {
  test("streams fields and files to disk and rebuilds the form data", async () => {
    const formData = new FormData()
    formData.append("model", "gpt-image-2")
    formData.append("prompt", "make the background transparent")
    formData.append(
      "image",
      new Blob(["first-image-bytes"], { type: "image/png" }),
      "first.png",
    )
    formData.append(
      "image",
      new Blob(["second-image-bytes"], { type: "image/webp" }),
      "second.webp",
    )

    const staged = await stage(formData)
    expect(existsSync(staged.directory)).toBe(true)

    try {
      // Serialize like the forwarding request does: Bun keeps the staged
      // file's path as the in-memory entry name, so assert on the round-trip.
      const roundTripped = await new Response(staged.formData).formData()
      expect(roundTripped.get("model")).toBe("gpt-image-2")
      expect(roundTripped.get("prompt")).toBe("make the background transparent")

      const images = roundTripped.getAll("image")
      expect(images).toHaveLength(2)
      const [first, second] = images
      if (typeof first === "string" || typeof second === "string") {
        throw new Error("Expected staged images to be files")
      }
      expect(first.name).toBe("first.png")
      expect(first.type).toBe("image/png")
      expect(await first.text()).toBe("first-image-bytes")
      expect(second.name).toBe("second.webp")
      expect(second.type).toBe("image/webp")
      expect(await second.text()).toBe("second-image-bytes")
    } finally {
      await staged.cleanup()
    }

    expect(existsSync(staged.directory)).toBe(false)
  })

  test.each([
    ["../../evil.png", "evil.png"],
    ["capture?.png", "capture?.png"],
  ])(
    "stages %s safely and preserves the name %s",
    async (name, expectedName) => {
      const formData = new FormData()
      formData.append(
        "image",
        new Blob(["image-bytes"], { type: "image/png" }),
        name,
      )

      const staged = await stage(formData)
      try {
        expect(readdirSync(staged.directory)).toEqual(["0.upload"])

        const roundTripped = await new Response(staged.formData).formData()
        const image = roundTripped.get("image")
        if (image === null || typeof image === "string") {
          throw new Error("Expected the staged image to be a file")
        }
        expect(image.name).toBe(expectedName)
        expect(await image.text()).toBe("image-bytes")
      } finally {
        await staged.cleanup()
      }
    },
  )

  test("rejects fields that exceed their byte limit instead of truncating", async () => {
    const formData = new FormData()
    formData.set("prompt", "too long")

    await expectTooLarge(formData, { maxFieldSizeBytes: 4 })
  })

  test("rejects files that exceed their byte limit", async () => {
    const formData = new FormData()
    formData.set("image", new Blob(["too-large"]), "image.png")

    await expectTooLarge(formData, { maxFileSizeBytes: 4 })
  })

  test("rejects multipart bodies that exceed their aggregate byte limit", async () => {
    const formData = new FormData()
    formData.set("prompt", "body limit")

    await expectTooLarge(formData, { maxBodySizeBytes: 32 })
  })

  test("rejects multipart bodies with too many files", async () => {
    const formData = new FormData()
    formData.append("image", new Blob(["one"]), "one.png")
    formData.append("image", new Blob(["two"]), "two.png")

    await expectTooLarge(formData, { maxFiles: 1 })
  })

  test("rejects multipart bodies with too many parts", async () => {
    const formData = new FormData()
    formData.set("model", "gpt-image-2")
    formData.set("prompt", "too many parts")

    await expectTooLarge(formData, { maxParts: 1 })
  })

  test("rejects multipart bodies with too many fields", async () => {
    const formData = new FormData()
    formData.set("model", "gpt-image-2")
    formData.set("prompt", "too many fields")
    await expectTooLarge(formData, { maxFields: 1 })
  })

  test("cleans incomplete uploads when the client cancels", async () => {
    const before = listStagingDirectories()
    const controller = new AbortController()
    const original = multipartStagingDependencies.createWriteStream
    multipartStagingDependencies.createWriteStream = (path) => {
      queueMicrotask(() => controller.abort())
      return original(path)
    }
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(
          new TextEncoder().encode(
            '--upload\r\nContent-Disposition: form-data; name="image"; filename="source.png"\r\nContent-Type: image/png\r\n\r\npartial-image',
          ),
        )
      },
    })
    try {
      await Promise.resolve(
        expect(
          stageMultipartBodyToDisk(
            body,
            "multipart/form-data; boundary=upload",
            {},
            controller.signal,
          ),
        ).rejects.toThrow(),
      )
      expect(listStagingDirectories()).toEqual(before)
    } finally {
      multipartStagingDependencies.createWriteStream = original
    }
  })

  test("rejects invalid limits and already cancelled uploads before staging", async () => {
    const before = listStagingDirectories()
    await Promise.resolve(
      expect(stage(new FormData(), { maxFiles: 0 })).rejects.toThrow(
        "positive safe integer",
      ),
    )
    await Promise.resolve(
      expect(
        stageMultipartBodyToDisk(
          null,
          "multipart/form-data; boundary=upload",
          {},
          AbortSignal.abort(),
        ),
      ).rejects.toThrow(),
    )
    expect(listStagingDirectories()).toEqual(before)
  })

  test("rejects file write failures without waiting for the request to end", async () => {
    const originalCreateWriteStream =
      multipartStagingDependencies.createWriteStream
    const directoriesBefore = listStagingDirectories()
    multipartStagingDependencies.createWriteStream = () =>
      new Writable({
        write(_chunk, _encoding, callback) {
          callback(new Error("temporary file write failed"))
        },
      })

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            '--slow\r\nContent-Disposition: form-data; name="image"; filename="image.png"\r\nContent-Type: image/png\r\n\r\nbytes',
          ),
        )
      },
    })
    let timeout: ReturnType<typeof setTimeout> | undefined

    try {
      const result = await Promise.race([
        stageMultipartBodyToDisk(
          body,
          "multipart/form-data; boundary=slow",
        ).then(
          () => new Error("Expected staging to fail"),
          (error: unknown) => error,
        ),
        new Promise<"timeout">((resolve) => {
          timeout = setTimeout(() => resolve("timeout"), 500)
        }),
      ])

      expect(result).not.toBe("timeout")
      expect(result).toBeInstanceOf(Error)
      expect((result as Error).message).toBe("temporary file write failed")
      expect(listStagingDirectories()).toEqual(directoriesBefore)
    } finally {
      if (timeout) clearTimeout(timeout)
      multipartStagingDependencies.createWriteStream = originalCreateWriteStream
    }
  })

  test("rejects a malformed multipart body", async () => {
    const body = new Response("this is not multipart").body

    let error: unknown
    try {
      await stageMultipartBodyToDisk(
        body,
        "multipart/form-data; boundary=broken",
      )
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
  })

  test("scheduleCleanup tolerates a following manual cleanup", async () => {
    const formData = new FormData()
    formData.append("image", new Blob(["image-bytes"]), "image.png")

    const staged = await stage(formData)
    staged.scheduleCleanup()

    await staged.cleanup()
    expect(existsSync(staged.directory)).toBe(false)
  })
})
