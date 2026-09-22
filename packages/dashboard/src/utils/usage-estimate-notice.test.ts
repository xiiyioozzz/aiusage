import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UsageEstimateNotice } from '../components/usage-estimate-notice';

test('legacy responses without estimated tokens do not display an estimate notice', () => {
  assert.equal(renderToStaticMarkup(createElement(UsageEstimateNotice, { locale: 'en' })), '');
  assert.equal(renderToStaticMarkup(createElement(UsageEstimateNotice, { locale: 'zh', estimatedTokenCount: 0 })), '');
});

test('estimated tokens display a visible localized notice and billing limitation', () => {
  const en = renderToStaticMarkup(createElement(UsageEstimateNotice, { locale: 'en', estimatedTokenCount: 1200 }));
  assert.match(en, /Includes estimated usage/);
  assert.match(en, /1.2K tokens/);
  assert.match(en, /not provider-verified usage or an official bill/);
  const zh = renderToStaticMarkup(createElement(UsageEstimateNotice, { locale: 'zh', estimatedTokenCount: 1200 }));
  assert.match(zh, /含估算用量/);
  assert.match(zh, /不能作为官方账单/);
});
