import { describe, expect, spyOn, test } from 'bun:test'

import { runSettingsTransaction } from '../electron/settings-transaction'

describe('desktop settings transaction', () => {
  test('applies before persistence and rolls back persistence failures', async () => {
    const events: string[] = []

    await runSettingsTransaction(
      () => events.push('apply'),
      () => events.push('persist'),
      () => events.push('rollback'),
    )
    expect(events).toEqual(['apply', 'persist'])

    events.length = 0
    const error = new Error('write failed')
    await expect(
      runSettingsTransaction(
        () => events.push('apply'),
        () => {
          events.push('persist')
          throw error
        },
        () => events.push('rollback'),
      ),
    ).rejects.toBe(error)
    expect(events).toEqual(['apply', 'persist', 'rollback'])
  })

  test('preserves the original error when rollback also fails', async () => {
    const error = new Error('write failed')
    const log = spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(
        runSettingsTransaction(
          () => {},
          () => {
            throw error
          },
          () => {
            throw new Error('rollback failed')
          },
        ),
      ).rejects.toBe(error)
      expect(log).toHaveBeenCalledTimes(1)
    } finally {
      log.mockRestore()
    }
  })
})
