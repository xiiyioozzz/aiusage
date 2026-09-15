import { BrainCircuit } from 'lucide-react';
import claudeCodeIcon from '@lobehub/icons-static-svg/icons/claudecode-color.svg?url';
import claudeIcon from '@lobehub/icons-static-svg/icons/claude-color.svg?url';
import anthropicIcon from '@lobehub/icons-static-svg/icons/anthropic.svg?url';
import deepseekIcon from '@lobehub/icons-static-svg/icons/deepseek-color.svg?url';
import openaiIcon from '@lobehub/icons-static-svg/icons/openai.svg?url';
import geminiIcon from '@lobehub/icons-static-svg/icons/gemini-color.svg?url';
import geminiCliIcon from '@lobehub/icons-static-svg/icons/geminicli-color.svg?url';
import chatGlmIcon from '@lobehub/icons-static-svg/icons/chatglm-color.svg?url';
import zhipuIcon from '@lobehub/icons-static-svg/icons/zhipu-color.svg?url';
import kimiIcon from '@lobehub/icons-static-svg/icons/kimi.svg?url';
import copilotIcon from '@lobehub/icons-static-svg/icons/githubcopilot.svg?url';
import traeIcon from '@lobehub/icons-static-svg/icons/trae-color.svg?url';
import qwenIcon from '@lobehub/icons-static-svg/icons/qwen-color.svg?url';
import openrouterIcon from '@lobehub/icons-static-svg/icons/openrouter-color.svg?url';
import antigravityIcon from '@lobehub/icons-static-svg/icons/antigravity-color.svg?url';
import ampIcon from '@lobehub/icons-static-svg/icons/amp-color.svg?url';
import cursorIcon from '@lobehub/icons-static-svg/icons/cursor.svg?url';
import kiroIcon from '@lobehub/icons-static-svg/icons/kiro-color.svg?url';
import grokIcon from '@lobehub/icons-static-svg/icons/grok.svg?url';
import opencodeIcon from '@lobehub/icons-static-svg/icons/opencode.svg?url';
import moonshotIcon from '@lobehub/icons-static-svg/icons/moonshot.svg?url';
import hermesAgentIcon from '@lobehub/icons-static-svg/icons/hermesagent.svg?url';
import type { BrandId } from './brand-match';
import { resolveModelBrand, resolveProductBrand, resolveProviderBrand } from './brand-match';

export type FilterIconAsset = {
  src: string;
  tone?: 'color' | 'mono';
} | {
  Icon: typeof BrainCircuit;
  tone: 'component';
};

const colorIcon = (src: string): FilterIconAsset => ({ src, tone: 'color' });
const monoIcon = (src: string): FilterIconAsset => ({ src, tone: 'mono' });
const componentIcon = (Icon: typeof BrainCircuit): FilterIconAsset => ({ Icon, tone: 'component' });

const BRAND_ICONS: Record<BrandId, FilterIconAsset> = {
  hermes: monoIcon(hermesAgentIcon),
  claude: colorIcon(claudeIcon),
  openai: monoIcon(openaiIcon),
  grok: monoIcon(grokIcon),
  glm: colorIcon(chatGlmIcon),
  zhipu: colorIcon(zhipuIcon),
  kimi: monoIcon(kimiIcon),
  deepseek: colorIcon(deepseekIcon),
  gemini: colorIcon(geminiIcon),
  cursor: monoIcon(cursorIcon),
  kiro: colorIcon(kiroIcon),
  qwen: colorIcon(qwenIcon),
  trae: colorIcon(traeIcon),
  copilot: monoIcon(copilotIcon),
  antigravity: colorIcon(antigravityIcon),
  amp: colorIcon(ampIcon),
  opencode: monoIcon(opencodeIcon),
  openrouter: colorIcon(openrouterIcon),
  anthropic: monoIcon(anthropicIcon),
  moonshot: monoIcon(moonshotIcon),
};

const PRODUCT_ICONS: Partial<Record<BrandId, FilterIconAsset>> = {
  claude: colorIcon(claudeCodeIcon),
  gemini: colorIcon(geminiCliIcon),
};

export function productIcon(value: string): FilterIconAsset | undefined {
  const brand = resolveProductBrand(value);
  if (!brand) return undefined;
  return PRODUCT_ICONS[brand] ?? BRAND_ICONS[brand];
}

export function providerIcon(value: string): FilterIconAsset | undefined {
  const brand = resolveProviderBrand(value);
  return brand ? BRAND_ICONS[brand] : undefined;
}

export function modelIcon(value: string, label = ''): FilterIconAsset {
  const brand = resolveModelBrand(value, label);
  return brand ? BRAND_ICONS[brand] : componentIcon(BrainCircuit);
}

export function iconSrc(icon: FilterIconAsset | undefined): string | undefined {
  if (!icon || icon.tone === 'component') return undefined;
  return icon.src;
}
