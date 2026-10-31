import { expect, test } from 'bun:test'
import { selectMediaImageModel } from '../src/lib/media-models'

test.each([null, undefined, {}, { data: null }, { data: 'invalid' }])(
  'keeps model selection automatic for an invalid catalog %#',
  (value) => {
    expect(selectMediaImageModel(value)).toBe('')
  },
)

test('uses default image priority without picking unrelated or malformed records', () => {
  expect(
    selectMediaImageModel({
      data: [
        null,
        2,
        {},
        { id: 2 },
        { id: 'codex/gpt-6-sol' },
        { id: 'xai/grok-imagine-image-2.0' },
        { id: 'github-copilot/gpt-image-2.5-flare' },
      ],
    }),
  ).toBe('github-copilot/gpt-image-2.5-flare')
})
