// UI strings live in locales/<code>.json. The panel follows Chrome's own
// language by default; the language menu in the header overrides it, and that
// choice is saved in chrome.storage.local.

// [code, native name], in the order shown in the menu.
export const LANGUAGES = [
  ['en', 'English'],
  ['pt', 'Português'],
  ['es', 'Español']
];
const CODES = new Set(LANGUAGES.map(([code]) => code));
// BCP 47 tags for <html lang> and number formatting.
const BCP47 = { pt: 'pt-BR' };

let lang = 'en';
let strings = {};
let fallback = null;
const cache = new Map();

async function load(code) {
  if (!cache.has(code)) {
    cache.set(code, fetch(new URL(`./locales/${code}.json`, import.meta.url)).then(r => r.json()));
  }
  return cache.get(code);
}

// Maps a browser language ("pt-BR", "es-419"…) to a supported one.
export function detectLang(ui = 'en') {
  const tag = String(ui).replace('-', '_');
  if (CODES.has(tag)) return tag;
  const base = tag.split('_')[0];
  return CODES.has(base) ? base : 'en';
}

export async function setLang(next) {
  lang = CODES.has(next) ? next : 'en';
  fallback ??= await load('en');
  strings = lang === 'en' ? fallback : await load(lang);
  document.documentElement.lang = BCP47[lang] ?? lang;
}

export function getLang() {
  return lang;
}

// Locale for Intl (decimal separators etc.).
export function getLocale() {
  return BCP47[lang] ?? lang;
}

// t('status.holding', { side: 'B' }) -> "Holding video B"
export function t(key, vars = {}) {
  const str = strings[key] ?? fallback?.[key] ?? key;
  return str.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''));
}

// Fills every element that has data-i18n (text) or data-i18n-* (attributes).
export function applyStatic(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-aria-label]')) el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
  document.title = t('page.title');
}
