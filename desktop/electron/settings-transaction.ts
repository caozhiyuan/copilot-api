type SettingsTask = () => void | Promise<void>

export async function runSettingsTransaction(
  apply: SettingsTask,
  persist: SettingsTask,
  rollback: SettingsTask,
): Promise<void> {
  try {
    await apply()
    await persist()
  } catch (error) {
    try {
      await rollback()
    } catch (rollbackError) {
      console.error('Failed to roll back desktop settings:', rollbackError)
    }
    throw error
  }
}
