import { selectDefaultImageModel } from '../../../src/lib/image-models'

export function selectMediaImageModel(catalog: unknown): string {
  if (
    !catalog
    || typeof catalog !== 'object'
    || !('data' in catalog)
    || !Array.isArray(catalog.data)
  )
    return ''
  const ids = catalog.data.flatMap((model: unknown) =>
    (
      model
      && typeof model === 'object'
      && 'id' in model
      && typeof model.id === 'string'
    ) ?
      [model.id]
    : [],
  )
  return selectDefaultImageModel(ids) ?? ''
}
