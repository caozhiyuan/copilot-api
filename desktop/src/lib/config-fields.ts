export const configSections = [
  'mappings',
  'general',
  'models',
  'search',
  'transport',
] as const
export type ConfigSection = (typeof configSections)[number]

export const configFields = [
  {
    id: 'useMessagesApi',
    path: 'useMessagesApi',
    section: 'general',
    type: 'boolean',
  },
  {
    id: 'useResponsesApiWebSocket',
    path: 'useResponsesApiWebSocket',
    section: 'general',
    type: 'boolean',
  },
  {
    id: 'opencodeModelContextWindow',
    path: 'opencodeModelContextWindow',
    section: 'general',
    type: 'number',
    unit: 'tokens',
  },
  {
    id: 'claudeTokenMultiplier',
    path: 'claudeTokenMultiplier',
    section: 'general',
    type: 'number',
    step: '0.01',
  },
  {
    id: 'anthropicApiKey',
    path: 'anthropicApiKey',
    section: 'general',
    type: 'secret',
  },
  { id: 'smallModels', path: 'smallModels', section: 'models', type: 'json' },
  {
    id: 'claudeAutoModel',
    path: 'claudeAutoModel',
    section: 'models',
    type: 'model',
  },
  {
    id: 'modelReasoningEfforts',
    path: 'modelReasoningEfforts',
    section: 'models',
    type: 'json',
  },
  { id: 'extraPrompts', path: 'extraPrompts', section: 'models', type: 'json' },
  {
    id: 'useResponsesApiWebSearch',
    path: 'useResponsesApiWebSearch',
    section: 'search',
    type: 'boolean',
  },
  {
    id: 'alphaSearchCodexPriority',
    path: 'alphaSearchCodexPriority',
    section: 'search',
    type: 'boolean',
  },
  {
    id: 'alphaSearchModel',
    path: 'alphaSearchModel',
    section: 'search',
    type: 'string',
  },
  {
    id: 'messageApiWebSearchModel',
    path: 'messageApiWebSearchModel',
    section: 'search',
    type: 'string',
  },
  {
    id: 'imageGenerationModel',
    path: 'imageGenerationModel',
    section: 'search',
    type: 'string',
  },
  {
    id: 'imageEditModel',
    path: 'imageEditModel',
    section: 'search',
    type: 'string',
  },
  {
    id: 'headersTimeoutMs',
    path: 'upstreamTransport.headersTimeoutMs',
    section: 'transport',
    type: 'number',
    unit: 'ms',
  },
  {
    id: 'streamInactivityTimeoutMs',
    path: 'upstreamTransport.streamInactivityTimeoutMs',
    section: 'transport',
    type: 'number',
    unit: 'ms',
  },
  {
    id: 'websocketOpenTimeoutMs',
    path: 'upstreamTransport.websocketOpenTimeoutMs',
    section: 'transport',
    type: 'number',
    unit: 'ms',
  },
  {
    id: 'websocketPoolIdleTimeoutMs',
    path: 'upstreamTransport.websocketPoolIdleTimeoutMs',
    section: 'transport',
    type: 'number',
    unit: 'ms',
  },
  {
    id: 'websocketMaxBufferedBytes',
    path: 'upstreamTransport.websocketMaxBufferedBytes',
    section: 'transport',
    type: 'number',
    unit: 'bytes',
  },
  {
    id: 'websocketMaxBufferedMessages',
    path: 'upstreamTransport.websocketMaxBufferedMessages',
    section: 'transport',
    type: 'number',
  },
] as const
export type ConfigField = (typeof configFields)[number]
export type ConfigFieldId = ConfigField['id']
