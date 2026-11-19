// Shared AI provider/model lists used by both client and server (v1.0001235, Claude in the AI integration settings).
// The Claude models are a fixed list (the existing providers take a free model name; no provider lists models dynamically).
export const AI_PROVIDERS = ['gemini', 'openai', 'claude'];
export const CLAUDE_MODELS = [
  { id: 'claude-fable-5-2', label: 'Claude Fable 5.2' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' }
];
export const CLAUDE_MODEL_IDS = CLAUDE_MODELS.map(m => m.id);
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5-5';
