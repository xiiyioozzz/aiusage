import * as React from 'react';
import { I18N, type Locale } from '../i18n';

export function UsageEstimateNotice({ estimatedTokenCount = 0, locale }: {
  estimatedTokenCount?: number;
  locale: Locale;
}) {
  if (!Number.isFinite(estimatedTokenCount) || estimatedTokenCount <= 0) return null;
  const t = I18N[locale];
  const count = new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    notation: 'compact', maximumFractionDigits: 1,
  }).format(estimatedTokenCount);
  return (
    <div role="status" className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
      <span className="font-medium">{t.estimatedUsage}: {count} tokens.</span>{' '}
      {t.estimatedUsageExplanation}
    </div>
  );
}
