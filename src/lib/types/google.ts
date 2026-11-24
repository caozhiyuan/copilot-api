// Gemini GenerateContent REST contracts. Keep these independent of an SDK so
// the gateway uses the same fetch, proxy and cancellation paths as other APIs.
export interface GoogleInlineData {
  mimeType: string
  mime_type?: string
  data: string
  displayName?: string
  display_name?: string
}

export interface GoogleInlineDataInput {
  mimeType?: string
  mime_type?: string
  data: string
  displayName?: string
  display_name?: string
}

export interface GoogleFileDataInput {
  mimeType?: string
  mime_type?: string
  fileUri?: string
  file_uri?: string
}

export interface GoogleFunctionCall {
  id?: string
  name: string
  args?: Record<string, unknown>
}

export interface GoogleFunctionResponsePart {
  inlineData?: GoogleInlineData
  inline_data?: GoogleInlineDataInput
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
  thought_signature?: string
  inlineData?: GoogleInlineData
  inline_data?: GoogleInlineDataInput
  fileData?: {
    mimeType?: string
    mime_type?: string
    fileUri: string
    file_uri?: string
  }
  file_data?: GoogleFileDataInput
  functionCall?: GoogleFunctionCall
  function_call?: GoogleFunctionCall
  functionResponse?: GoogleFunctionResponse
  function_response?: GoogleFunctionResponse
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
  parameters_json_schema?: Record<string, unknown>
}

export interface GoogleTool {
  functionDeclarations?: Array<GoogleFunctionDeclaration>
  function_declarations?: Array<GoogleFunctionDeclaration>
  [key: string]: unknown
}

export interface GoogleFunctionCallingConfig {
  mode?: "AUTO" | "ANY" | "NONE" | "VALIDATED" | "MODE_UNSPECIFIED"
  allowedFunctionNames?: Array<string>
  allowed_function_names?: Array<string>
}

export interface GoogleToolConfig {
  functionCallingConfig?: GoogleFunctionCallingConfig
  function_calling_config?: GoogleFunctionCallingConfig
}

export interface GoogleTextResponseFormat {
  mimeType?: string
  mime_type?: string
  schema?: Record<string, unknown>
  jsonSchema?: Record<string, unknown>
  json_schema?: Record<string, unknown>
}

export interface GoogleResponseFormat {
  text?: GoogleTextResponseFormat
  [key: string]: unknown
}

export interface GoogleGenerationConfig {
  candidateCount?: number
  candidate_count?: number
  maxOutputTokens?: number
  max_output_tokens?: number
  temperature?: number
  topP?: number
  top_p?: number
  topK?: number
  top_k?: number
  stopSequences?: Array<string>
  stop_sequences?: Array<string>
  responseMimeType?: string
  response_mime_type?: string
  responseJsonSchema?: Record<string, unknown>
  response_json_schema?: Record<string, unknown>
  responseSchema?: Record<string, unknown>
  response_schema?: Record<string, unknown>
  responseFormat?: GoogleResponseFormat | Array<GoogleResponseFormat>
  response_format?: GoogleResponseFormat | Array<GoogleResponseFormat>
  thinkingConfig?: GoogleThinkingConfig
  thinking_config?: GoogleThinkingConfig
}

export interface GoogleGenerateContentRequest {
  contents?: Array<GoogleContent>
  systemInstruction?: GoogleContent
  system_instruction?: GoogleContent
  tools?: Array<GoogleTool>
  toolConfig?: GoogleToolConfig
  tool_config?: GoogleToolConfig
  generationConfig?: GoogleGenerationConfig
  generation_config?: GoogleGenerationConfig
  safetySettings?: Array<unknown>
  safety_settings?: Array<unknown>
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
  include_thoughts?: boolean
  thinkingBudget?: number
  thinking_budget?: number
  thinkingLevel?: GoogleThinkingLevel | (string & {})
  thinking_level?: GoogleThinkingLevel | (string & {})
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
