import { HTTPError } from "~/lib/error"
import {
  assertExternalImageBase64,
  externalImageJsonStream,
  readExternalImageJson,
} from "~/lib/image-json-value"
import {
  translateXaiImageEditJson,
  translateXaiImageGeneration,
  XaiImagesRequestError,
} from "~/services/xai/images"
import type { CodexImagesOperation } from "~/services/codex/images"

/** Existing translators validate a bounded skeleton; large strings stay on disk. */
export async function translateXaiImageJsonRequest(
  request: Request,
  operation: CodexImagesOperation,
  model: string,
) {
  let json: Awaited<ReturnType<typeof readExternalImageJson>>
  try {
    json = await readExternalImageJson(request)
  } catch (error) {
    if (error instanceof HTTPError || request.signal.aborted) throw error
    throw new XaiImagesRequestError(
      operation === "edits" ?
        "Image edit body must be JSON"
      : "Image generation body must be JSON",
    )
  }
  try {
    const payload =
      operation === "edits" ?
        translateXaiImageEditJson(json.value, model)
      : translateXaiImageGeneration(json.value, model)
    try {
      assertExternalImageBase64(json, payload)
    } catch {
      throw new XaiImagesRequestError("image b64_json is not valid base64")
    }
    return {
      payload,
      body: externalImageJsonStream(json, payload, request.signal),
    }
  } catch (error) {
    await json.cleanup()
    throw error
  }
}
