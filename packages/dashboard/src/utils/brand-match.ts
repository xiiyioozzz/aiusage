export type BrandId =
  | 'hermes'
  | 'claude'
  | 'openai'
  | 'grok'
  | 'glm'
  | 'zhipu'
  | 'kimi'
  | 'deepseek'
  | 'gemini'
  | 'cursor'
  | 'kiro'
  | 'qwen'
  | 'trae'
  | 'copilot'
  | 'antigravity'
  | 'amp'
  | 'opencode'
  | 'openrouter'
  | 'anthropic'
  | 'moonshot';

function normalize(value: string, label = ''): string {
  return `${value} ${label}`.trim().toLowerCase();
}

function isGrok(id: string): boolean {
  return id.includes('grok') || id.includes('xai');
}

function isClaude(id: string): boolean {
  return /claude|anthropic|\bopus\b|\bsonnet\b|\bhaiku\b|\bfable\b|\bmythos\b/.test(id);
}

function isGlm(id: string): boolean {
  return /\bglm(?:-v)?\b/.test(id) || id.includes('chatglm') || id.includes('智谱');
}

function isKimi(id: string): boolean {
  return id.includes('kimi') || id.includes('moonshot');
}

function isOpenAI(id: string): boolean {
  return (
    id.includes('openai') ||
    id.includes('chatgpt') ||
    id.includes('codex') ||
    /\bgpt\b/.test(id) ||
    /\bo[134]\b/.test(id) ||
    /\b(astra|terra|luna|sol)\b/.test(id)
  );
}

function isCursorNative(id: string): boolean {
  return id.includes('composer') || id.includes('big-pickle') || id.includes('cursor');
}

export function resolveModelBrand(value: string, label = ''): BrandId | undefined {
  const id = normalize(value, label);
  if (isGrok(id)) return 'grok';
  if (isClaude(id)) return 'claude';
  if (isGlm(id) || id.includes('zhipu')) return 'glm';
  if (id.includes('deepseek')) return 'deepseek';
  if (id.includes('gemini')) return 'gemini';
  if (isKimi(id)) return 'kimi';
  if (id.includes('openrouter')) return 'openrouter';
  if (id.includes('qwen') || id.includes('通义')) return 'qwen';
  if (id.includes('copilot')) return 'copilot';
  if (id.includes('trae')) return 'trae';
  if (isCursorNative(id)) return 'cursor';
  if (isOpenAI(id)) return 'openai';
  if (id.includes('hermes')) return 'hermes';
  if (id.includes('kiro')) return 'kiro';
  return undefined;
}

export function resolveProductBrand(value: string): BrandId | undefined {
  const id = normalize(value);
  if (id.includes('claude')) return 'claude';
  if (id.includes('codex')) return 'openai';
  if (id.includes('hermes')) return 'hermes';
  if (id.includes('gemini')) return 'gemini';
  if (id.includes('kimi')) return 'kimi';
  if (id.includes('copilot')) return 'copilot';
  if (id.includes('trae')) return 'trae';
  if (id.includes('qwen')) return 'qwen';
  if (id.includes('antigravity')) return 'antigravity';
  if (id.includes('amp')) return 'amp';
  if (id.includes('cursor')) return 'cursor';
  if (id.includes('kiro')) return 'kiro';
  if (id.includes('opencode')) return 'opencode';
  return undefined;
}

export function resolveProviderBrand(value: string): BrandId | undefined {
  const id = normalize(value);
  if (id.includes('hermes')) return 'hermes';
  if (id.includes('xkiro') || id.includes('kiro')) return 'kiro';
  if (id.includes('cursor')) return 'cursor';
  if (id.includes('anthropic')) return 'anthropic';
  if (id.includes('openai')) return 'openai';
  if (id.includes('google')) return 'gemini';
  if (id.includes('deepseek')) return 'deepseek';
  if (id.includes('moonshot')) return 'moonshot';
  if (id.includes('alibaba')) return 'qwen';
  if (id.includes('zhipu')) return 'zhipu';
  if (id.includes('xai')) return 'grok';
  if (id.includes('github')) return 'copilot';
  if (id.includes('opencode')) return 'opencode';
  return undefined;
}
