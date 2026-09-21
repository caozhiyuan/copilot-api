import { readBodyWithLimit } from "~/lib/bounded-body"

export const MAX_MODELS_CATALOG_SIZE_BYTES = 10 * 1024 * 1024

export async function readModelsCatalogResponse(
  response: Response,
): Promise<unknown> {
  const body = await readBodyWithLimit(
    response.body,
    MAX_MODELS_CATALOG_SIZE_BYTES,
    response.headers.get("content-length"),
  )
  return JSON.parse(new TextDecoder().decode(body)) as unknown
}
