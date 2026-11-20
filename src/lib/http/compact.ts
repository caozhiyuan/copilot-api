export const COMPACT_REQUEST = 1 as const
export const COMPACT_AUTO_CONTINUE = 2 as const

export const compactSystemPromptStart =
  "You are a helpful AI assistant tasked with summarizing conversations"
export const compactOpenCodeSystemPromptStart =
  "You are an anchored context summarization assistant for coding sessions."
export const compactSystemPromptStarts = [
  compactSystemPromptStart,
  compactOpenCodeSystemPromptStart,
] as const
export const compactTextOnlyGuard =
  "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools."
export const compactSummaryPromptStart =
  "Your task is to create a detailed summary of the conversation so far"
export const compactAutoContinueClaudeCodePromptStart =
  "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation."
export const compactAutoContinueOpenCodePromptStart =
  "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
export const compactAutoContinueOpenCodePromptStart2 =
  "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context."
export const compactAutoContinuePromptStarts = [
  compactAutoContinueClaudeCodePromptStart,
  compactAutoContinueOpenCodePromptStart,
  compactAutoContinueOpenCodePromptStart2,
] as const
export const compactMessageSections = [
  "Pending Tasks:",
  "Current Work:",
] as const

export type CompactType =
  | 0
  | typeof COMPACT_REQUEST
  | typeof COMPACT_AUTO_CONTINUE
