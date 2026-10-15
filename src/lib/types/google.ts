// Gemini GenerateContent REST contracts. Keep these independent of an SDK so
// the gateway uses the same fetch, proxy and cancellation paths as other APIs.
export interface GooglePart {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  inlineData?: { mimeType: string; data: string; displayName?: string }
  functionCall?: {
    id?: string
    name: string
    args?: Record<string, unknown>
  }
  functionResponse?: {
    id?: string
    name: string
    response: Record<string, unknown>
    parts?: Array<Pick<GooglePart, "inlineData">>
  }
}

export interface GoogleContent {
  role?: "user" | "model"
  parts: Array<GooglePart>
}

export interface GoogleGenerateContentPayload {
  contents: Array<GoogleContent>
  systemInstruction?: GoogleContent
  tools?: Array<{
    functionDeclarations: Array<{
      name: string
      description?: string
      parametersJsonSchema: Record<string, unknown>
    }>
  }>
  toolConfig?: {
    functionCallingConfig: {
      mode: "AUTO" | "ANY" | "NONE"
      allowedFunctionNames?: Array<string>
    }
  }
  generationConfig: {
    candidateCount: number
    maxOutputTokens: number
    temperature?: number
    topP?: number
    topK?: number
    stopSequences?: Array<string>
    responseMimeType?: "application/json"
    responseJsonSchema?: Record<string, unknown>
    thinkingConfig?: GoogleThinkingConfig
  }
}

export type GoogleThinkingLevel = "LOW" | "MEDIUM" | "HIGH"

export interface GoogleThinkingConfig {
  includeThoughts?: boolean
  thinkingLevel?: GoogleThinkingLevel
}

export interface GoogleUsageMetadata {
  promptTokenCount?: number
  candidatesTokenCount?: number
  cachedContentTokenCount?: number
  thoughtsTokenCount?: number
  totalTokenCount?: number
}

export interface GoogleGenerateContentResponse {
  responseId?: string
  candidates?: Array<{
    index?: number
    content?: GoogleContent
    finishReason?: string
  }>
  usageMetadata?: GoogleUsageMetadata
  promptFeedback?: { blockReason?: string }
  error?: { code?: number; message?: string; status?: string }
}

export interface GoogleModelsResponse {
  models?: Array<{
    name: string
    displayName?: string
    description?: string
    inputTokenLimit?: number
    outputTokenLimit?: number
    supportedGenerationMethods?: Array<string>
  }>
  nextPageToken?: string
}
