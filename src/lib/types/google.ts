// Gemini GenerateContent REST contracts. Keep these independent of an SDK so
// the gateway uses the same fetch, proxy and cancellation paths as other APIs.
export interface GoogleInlineData {
  mimeType: string
  data: string
  displayName?: string
}

export interface GoogleFunctionCall {
  id?: string
  name: string
  args?: Record<string, unknown>
}

export interface GoogleFunctionResponsePart {
  inlineData?: GoogleInlineData
}

export interface GoogleFunctionResponse {
  id?: string
  name: string
  response: Record<string, unknown>
  parts?: Array<GoogleFunctionResponsePart>
}

export interface GooglePart {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  inlineData?: GoogleInlineData
  fileData?: {
    mimeType?: string
    fileUri: string
  }
  functionCall?: GoogleFunctionCall
  functionResponse?: GoogleFunctionResponse
}

export interface GoogleContent {
  role?: "user" | "model" | "function" | "system"
  parts: Array<GooglePart>
}

export interface GoogleFunctionDeclaration {
  name: string
  description?: string
  parameters?: Record<string, unknown>
  parametersJsonSchema?: Record<string, unknown>
}

export interface GoogleTool {
  functionDeclarations?: Array<GoogleFunctionDeclaration>
  [key: string]: unknown
}

export interface GoogleFunctionCallingConfig {
  mode?: "AUTO" | "ANY" | "NONE" | "VALIDATED" | "MODE_UNSPECIFIED"
  allowedFunctionNames?: Array<string>
}

export interface GoogleToolConfig {
  functionCallingConfig?: GoogleFunctionCallingConfig
}

export interface GoogleTextResponseFormat {
  mimeType?: string
  schema?: Record<string, unknown>
  jsonSchema?: Record<string, unknown>
}

export interface GoogleResponseFormat {
  text?: GoogleTextResponseFormat
  [key: string]: unknown
}

export interface GoogleGenerationConfig {
  candidateCount?: number
  maxOutputTokens?: number
  temperature?: number
  topP?: number
  topK?: number
  stopSequences?: Array<string>
  responseMimeType?: string
  responseJsonSchema?: Record<string, unknown>
  responseSchema?: Record<string, unknown>
  responseFormat?: GoogleResponseFormat | Array<GoogleResponseFormat>
  thinkingConfig?: GoogleThinkingConfig
}

export interface GoogleGenerateContentRequest {
  contents?: Array<GoogleContent>
  labels?: Record<string, string>
  systemInstruction?: GoogleContent
  tools?: Array<GoogleTool>
  toolConfig?: GoogleToolConfig
  generationConfig?: GoogleGenerationConfig
  safetySettings?: Array<unknown>
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

export type GoogleThinkingLevel = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH"

export interface GoogleThinkingConfig {
  includeThoughts?: boolean
  thinkingBudget?: number
  thinkingLevel?: GoogleThinkingLevel | (string & {})
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
  modelVersion?: string
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
