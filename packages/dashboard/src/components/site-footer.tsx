import { Github, Heart } from 'lucide-react';
import type { T } from '../i18n';
import { SITE_GITHUB_URL, SITE_TITLE, SITE_X_NAME, SITE_X_URL } from '../site-config';
import { FooterLogo } from './site-logo';

export function SiteFooter({
  t,
  version,
}: {
  t: T;
  version?: string;
}) {
  return (
    <footer className="fade-up mt-16 border-t border-slate-100 dark:border-white/[0.08] pb-10 pt-8">
      <div className="flex flex-col items-center gap-4">
        <div className="flex items-center gap-3 text-[12px] text-slate-400 dark:text-slate-500">
          <span className="flex items-center gap-1.5 font-medium text-slate-500 dark:text-slate-400">
            <FooterLogo />
            {SITE_TITLE}
          </span>
          {version && (
            <span className="rounded-full bg-slate-100 dark:bg-[#1a1a1a] px-2 py-0.5 text-[10px] font-medium text-slate-400 dark:text-slate-500">
              v{version}
            </span>
          )}
        </div>
        <div className="flex flex-wrap justify-center gap-x-4 gap-y-2 text-[11px] text-slate-300 dark:text-slate-600">
          <div className="flex items-center gap-4">
            <a
              href="/embed/docs"
              className="text-slate-400 transition-colors hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
            >
              {t.embedWidgets}
            </a>
          </div>
          <div className="flex items-center gap-4">
            <a
              href={SITE_GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-slate-400 transition-colors hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
            >
              <Github className="h-3.5 w-3.5" />
              <span>GitHub</span>
            </a>
            <span className="h-3 w-px bg-slate-200 dark:bg-[#222222]" />
            <span className="flex items-center gap-1">
              {t.madeWith} <Heart className="h-3 w-3 fill-red-300 text-red-300" /> {t.madeBy}{' '}
              <a
                href={SITE_X_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-slate-400 transition-colors hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
              >
                <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
                {SITE_X_NAME}
              </a>
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}
