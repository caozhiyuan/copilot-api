export type ConfigEditorErrorCode =
  'conflict' | 'validation' | 'readFailed' | 'saveFailed' | 'applyFailed'

export class ConfigEditorError extends Error {
  readonly code: ConfigEditorErrorCode

  constructor(code: ConfigEditorErrorCode, message: string = code) {
    super(message)
    this.code = code
    this.name = 'ConfigEditorError'
  }
}

export type ConfigEditorReply<T> =
  T | { error: { code: ConfigEditorErrorCode; message?: string } }

export function unwrapConfigEditorReply<T extends object>(
  reply: ConfigEditorReply<T>,
): T {
  if ('error' in reply)
    throw new ConfigEditorError(reply.error.code, reply.error.message)
  return reply
}
