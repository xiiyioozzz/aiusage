import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { RotateCw, Sun, Moon, Monitor } from 'lucide-react';
import type { Locale, T } from '../i18n';
import { I18N, getStoredLocale } from '../i18n';
import type { ThemeMode } from '../theme';
import { getStoredTheme, applyTheme } from '../theme';
import { HeaderLogo, useFaviconFromLogo } from './site-logo';
import { SiteFooter } from './site-footer';
import { SITE_TITLE } from '../site-config';
import type { HealthPayload } from '../hooks/use-overview';

// ────────────────────────────────────────
// Context
// ────────────────────────────────────────

interface LayoutContextValue {
  locale: Locale;
  t: T;
  isDark: boolean;
  refresh: () => void;
  loading: boolean;
}

const LayoutContext = createContext<LayoutContextValue | null>(null);

export function useLayout(): LayoutContextValue {
  const ctx = useContext(LayoutContext);
  if (!ctx) throw new Error('useLayout must be used within <Layout>');
  return ctx;
}

// ────────────────────────────────────────
// Theme & Language Toggles
// ────────────────────────────────────────

const THEME_OPTIONS: { value: ThemeMode; icon: typeof Sun }[] = [
  { value: 'system', icon: Monitor },
  { value: 'light', icon: Sun },
  { value: 'dark', icon: Moon },
];

const THEME_LABELS: Record<ThemeMode, { en: string; zh: string }> = {
  system: { en: 'System', zh: '系统' },
  light: { en: 'Light', zh: '日间' },
  dark: { en: 'Dark', zh: '夜间' },
};

function ThemeToggle({ value, onChange, locale }: { value: ThemeMode; onChange: (v: ThemeMode) => void; locale: Locale }) {
  return (
    <div className="inline-flex items-center rounded-md bg-slate-100/80 p-0.5 dark:bg-[#1a1a1a]/80">
      {THEME_OPTIONS.map((o) => {
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-all duration-150 ${
              value === o.value
                ? 'bg-white text-slate-900 shadow-sm dark:bg-[#222222] dark:text-slate-300'
                : 'text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300'
            }`}
            aria-label={o.value}
          >
            <Icon className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{THEME_LABELS[o.value][locale]}</span>
          </button>
        );
      })}
    </div>
  );
}

function LangToggle({ value, onChange }: { value: Locale; onChange: (v: Locale) => void }) {
  return (
    <div className="inline-flex items-center rounded-md bg-slate-100/80 p-0.5 dark:bg-[#1a1a1a]/80">
      {(['en', 'zh'] as const).map((l) => (
        <button
          key={l}
          onClick={() => onChange(l)}
          className={`rounded px-2 py-1 text-[11px] font-medium transition-all duration-150 ${
            value === l
              ? 'bg-white text-slate-900 shadow-sm dark:bg-[#222222] dark:text-slate-300'
              : 'text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300'
          }`}
        >
          {l === 'en' ? 'EN' : '中'}
        </button>
      ))}
    </div>
  );
}

// ────────────────────────────────────────
// Layout
// ────────────────────────────────────────

async function fetchHealth(): Promise<HealthPayload> {
  try {
    const r = await fetch('/api/v1/health');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const ct = r.headers.get('content-type') ?? '';
    if (!ct.includes('application/json')) throw new Error('Not JSON');
    return r.json() as Promise<HealthPayload>;
  } catch {
    return { ok: false, siteId: 'unknown', version: 'unknown' };
  }
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [tick, setTick] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const hp = await fetchHealth();
      if (!cancelled) { setHealth(hp); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [tick]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  // Theme
  const [theme, setThemeState] = useState<ThemeMode>(getStoredTheme);
  const isFirstRender = useRef(true);
  const setTheme = useCallback((m: ThemeMode) => { setThemeState(m); applyTheme(m); }, []);
  useEffect(() => {
    applyTheme(theme, !isFirstRender.current);
    isFirstRender.current = false;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => { if (theme === 'system') applyTheme('system'); };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  // Locale
  const [locale, setLocaleState] = useState<Locale>(getStoredLocale);
  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try { localStorage.setItem('aiusage-locale', l); } catch {}
  }, []);
  const t: T = I18N[locale];

  useFaviconFromLogo();
  const isDark = document.documentElement.classList.contains('dark');

  // Sync document title
  useEffect(() => {
    document.title = SITE_TITLE;
  }, []);

  const ctxValue: LayoutContextValue = {
    locale, t, isDark, refresh, loading,
  };

  return (
    <LayoutContext.Provider value={ctxValue}>
      <main className="mx-auto w-full max-w-[1200px] px-4 pb-16 sm:px-6 lg:px-8">

        {/* ── Header ── */}
        <header className="fade-up relative z-20 py-6 sm:py-8">
          <div className="flex flex-wrap items-center justify-between gap-y-2">
            <h1 className="flex items-center gap-2 text-[18px] sm:text-[22px] font-semibold tracking-tight text-slate-900 dark:text-slate-300">
              <HeaderLogo />
              {SITE_TITLE}
            </h1>
            <div className="flex items-center gap-1.5 sm:gap-2 ml-auto">
              <ThemeToggle value={theme} onChange={setTheme} locale={locale} />
              <LangToggle value={locale} onChange={setLocale} />
              <button
                onClick={refresh}
                className="hidden sm:inline-flex items-center justify-center rounded-md bg-slate-100/80 p-1.5 text-slate-400 transition-colors hover:text-slate-600 dark:bg-[#1a1a1a]/80 dark:text-slate-500 dark:hover:text-slate-300"
                aria-label="Refresh"
              >
                <RotateCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>
        </header>

        {children}
        <SiteFooter t={t} version={health?.version} />
      </main>
    </LayoutContext.Provider>
  );
}
