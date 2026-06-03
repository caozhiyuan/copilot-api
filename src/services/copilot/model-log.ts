import consola from "consola"

export const formatCopilotModelLog = (
  model: string,
  requestedModel?: string,
): string => {
  const logLine = `<-- model: ${model}`
  if (!requestedModel) {
    return logLine
  }
  return `${logLine} <-- requested model: ${requestedModel}`
}

export const logCopilotModel = (
  model: string,
  requestedModel?: string,
): void => {
  consola.log(formatCopilotModelLog(model, requestedModel))
}
