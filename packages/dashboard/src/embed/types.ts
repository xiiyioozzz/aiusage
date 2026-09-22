export const EMBED_WIDGETS = [
  'stats-row1', 'stats-row2', 'cost-trend', 'tool-trend', 'cost-composition',
  'token-trend', 'token-composition', 'flow', 'share',
] as const;

export type EmbedWidget = typeof EMBED_WIDGETS[number];

export type EmbedTheme = 'light' | 'dark' | 'auto';
export type EmbedLocale = 'en' | 'zh' | 'auto';
export type EmbedCurrency = 'USD' | 'CNY' | 'auto';

export interface EmbedParams {
  widget: EmbedWidget | null;
  items: number[] | null;       // null = show all
  range: string;
  theme: EmbedTheme;
  transparent: boolean;
  locale: EmbedLocale;
  currency: EmbedCurrency;
  deviceId: string;
  product: string;
}
