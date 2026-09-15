import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveModelBrand, resolveProductBrand, resolveProviderBrand } from './brand-match';

test('maps Cursor Grok rows to Grok instead of Cursor', () => {
  assert.equal(resolveModelBrand('cursor-grok-4.6-high-fast'), 'grok');
  assert.equal(resolveModelBrand('cursor-grok-4.6-xhigh-fast'), 'grok');
  assert.equal(resolveModelBrand('grok-bot-default'), 'grok');
  assert.equal(resolveModelBrand('grok-bot-cua'), 'grok');
});

test('maps GLM text models to ChatGLM, not GLM-V', () => {
  assert.equal(resolveModelBrand('glm-5'), 'glm');
  assert.equal(resolveModelBrand('glm-4.6'), 'glm');
  assert.equal(resolveProviderBrand('zhipu'), 'zhipu');
});

test('maps Claude family aliases including Fable and Opus', () => {
  assert.equal(resolveModelBrand('claude-fable-5-1-thinking-max'), 'claude');
  assert.equal(resolveModelBrand('claude-opus-5-thinking-high-fast'), 'claude');
  assert.equal(resolveModelBrand('claude-sonnet-4-6'), 'claude');
});

test('maps OpenAI / ChatGPT / Codex model ids', () => {
  assert.equal(resolveModelBrand('gpt-5.6-sol'), 'openai');
  assert.equal(resolveModelBrand('gpt-6-astra'), 'openai');
  assert.equal(resolveModelBrand('codex-auto-review'), 'openai');
  assert.equal(resolveModelBrand('gpt-5.3-codex'), 'openai');
  assert.equal(resolveProductBrand('codex'), 'openai');
});

test('maps product and leftover Cursor-native models', () => {
  assert.equal(resolveProductBrand('hermes'), 'hermes');
  assert.equal(resolveProductBrand('cursor'), 'cursor');
  assert.equal(resolveModelBrand('composer-2.5-fast'), 'cursor');
  assert.equal(resolveModelBrand('big-pickle'), 'cursor');
  assert.equal(resolveModelBrand('kimi-k3'), 'kimi');
  assert.equal(resolveModelBrand('deepseek-v4-flash'), 'deepseek');
  assert.equal(resolveProviderBrand('xkiro'), 'kiro');
  assert.equal(resolveModelBrand('auto'), undefined);
});
