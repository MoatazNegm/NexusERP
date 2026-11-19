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

// v1.0001241 (user order 2026-11-19, AI integration model list): the OpenAI-compatible integration keeps an ordered,
// admin-editable list of models in the database next to its key (settings.openaiConfig.models). The order scan, the AI
// Assistant and the supplier price-list mapping loop over that list in order (first success wins). No caller holds a model
// list of its own any more. The five models below are ONLY the OpenRouter seed: they are shown and saved once when the
// integration points at OpenRouter and no list was ever saved; after that the admin changes, adds or deletes any of them.
export const OPENROUTER_DEFAULT_MODELS = [
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'dots-studio/dots-3-note-preview:free',
  'google/gemma-4-26b-a4b-it:free',
  'minimax/minimax-m3:free',
  'openrouter/auto'
];
export const MAX_AI_MODELS = 20;
export const AI_MODEL_NAME_RE = /^[A-Za-z0-9._:\/-]{1,120}$/;
export const isOpenRouterUrl = (u) => {
  try { const h = new URL(String(u || '').trim()).hostname.toLowerCase(); return h === 'openrouter.ai' || h.endsWith('.openrouter.ai'); }
  catch { return false; }
};
// Trimmed, valid, unique names in the given order, at most MAX_AI_MODELS.
export const normalizeModelList = (list) => {
  const out = [];
  (Array.isArray(list) ? list : []).forEach(m => {
    const s = typeof m === 'string' ? m.trim() : '';
    if (s && AI_MODEL_NAME_RE.test(s) && !out.includes(s) && out.length < MAX_AI_MODELS) out.push(s);
  });
  return out;
};
// The list the app uses for a saved openaiConfig. A saved array is used as saved (also when empty: the admin deleted all).
// A record that never saved a list (older data) gets its old single model name, plus the OpenRouter seed when the base
// URL is OpenRouter (this is what the old hard-coded loop did); the next settings save stores it in the DB.
export const effectiveOpenAiModels = (cfg) => {
  const c = cfg || {};
  if (Array.isArray(c.models)) return { models: normalizeModelList(c.models), source: 'saved' };
  const legacy = c.modelName ? [String(c.modelName).trim()] : [];
  if (isOpenRouterUrl(c.baseUrl)) return { models: normalizeModelList([...legacy, ...OPENROUTER_DEFAULT_MODELS]), source: 'openrouter-default' };
  return { models: normalizeModelList(legacy), source: legacy.length ? 'legacy' : 'none' };
};
