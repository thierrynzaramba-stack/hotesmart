/* ============================================================
   HôteSmart — i18n.js
   Ajouter une langue = ajouter un fichier <code>.json + une ligne
   dans langues.json. Aucune condition sur la langue dans le code.

   API :
     await I18n.init()                      → charge la langue de l'hôte
     I18n.t('today.greeting', {name:'Thierry'})
     I18n.t('today.nights', {n: 2})         → pluriels ICU simples
     I18n.date(d), I18n.time(d), I18n.money(1240, 'EUR'), I18n.pct(0.78)
     I18n.set('en')                         → change et re-traduit la page
     I18n.langues                           → liste pour le sélecteur
   HTML :
     <span data-i18n="nav.today"></span>
     <button data-i18n-attr="aria-label:nav.notifications">
   ============================================================ */
window.I18n = (() => {
  const BASE = '/shared/i18n/';
  // ⚠ LA VERSION DES DICTIONNAIRES, ET POURQUOI ELLE EST ECRITE A LA MAIN.
  // Les quatre fichiers d'i18n etaient charges avec `cache: 'no-cache'`, donc
  // REVALIDES a chaque ouverture de page : 42 Ko pour le francais, 82 Ko pour
  // un hote anglophone ou hispanophone (fr.json sert de repli), un aller-retour
  // a chaque fois. Mesure du 22 octobre 2026 en production : l'en-tete servi
  // etait `public, max-age=0, must-revalidate`, `x-vercel-cache: MISS`.
  // Ils sont desormais caches UN AN, et c'est cette version qui les invalide :
  // elle entre dans l'URL, donc un dictionnaire change = une URL neuve.
  // ⚠ ET ELLE EST TENUE PAR UN TEST, PAS PAR LA MEMOIRE DE QUI TRADUIT.
  // `tests/i18n-version.test.js` recalcule l'empreinte des quatre fichiers et
  // ROUGIT si elle ne correspond pas. Sans lui, une traduction corrigee
  // resterait invisible un an chez l'hote — le defaut exact que le cache long
  // rend possible.
  const VERSION = 'a89359b57e4c';
  const FALLBACK = 'fr';
  const STORAGE_KEY = 'hs.lang';

  let langues = [];
  let current = FALLBACK;
  let dict = {};
  let fallbackDict = {};

  async function load(code) {
    const r = await fetch(`${BASE}${code}.json?v=${VERSION}`);
    if (!r.ok) throw new Error(`i18n: ${code}.json introuvable`);
    return r.json();
  }

  function detect() {
    // 1. préférence du profil (posée par l'app après connexion) 2. localStorage 3. navigateur
    const fromProfile = document.documentElement.dataset.userLang;
    let saved = null;
    try { saved = localStorage.getItem(STORAGE_KEY); } catch (_) {}
    const nav = (navigator.language || FALLBACK).slice(0, 2).toLowerCase();
    const wanted = fromProfile || saved || nav;
    return langues.some(l => l.code === wanted) ? wanted : FALLBACK;
  }

  // Pluriels ICU minimalistes : {n, plural, =0 {…} one {…} other {…}}
  function plural(str, vars) {
    return str.replace(/\{(\w+),\s*plural,\s*((?:[^{}]|\{[^{}]*\})*)\}/g, (_, key, body) => {
      const n = Number(vars[key] ?? 0);
      const cases = {};
      body.replace(/(=\d+|\w+)\s*\{([^{}]*)\}/g, (__, k, v) => { cases[k] = v; });
      const exact = cases[`=${n}`];
      const cat = new Intl.PluralRules(current).select(n);
      const chosen = exact ?? cases[cat] ?? cases.other ?? '';
      return chosen.replace(/#/g, new Intl.NumberFormat(current).format(n));
    });
  }

  function t(key, vars = {}) {
    let s = dict[key] ?? fallbackDict[key];
    if (s == null) { console.warn('i18n: clé manquante', key); return key; }
    s = plural(s, vars);
    return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));
  }

  function apply(root = document) {
    root.querySelectorAll('[data-i18n]').forEach(el => {
      const vars = el.dataset.i18nVars ? JSON.parse(el.dataset.i18nVars) : {};
      el.textContent = t(el.dataset.i18n, vars);
    });
    root.querySelectorAll('[data-i18n-attr]').forEach(el => {
      el.dataset.i18nAttr.split(';').forEach(pair => {
        const [attr, key] = pair.split(':').map(s => s.trim());
        if (attr && key) el.setAttribute(attr, t(key));
      });
    });
    const meta = langues.find(l => l.code === current);
    document.documentElement.lang = current;
    document.documentElement.dir = meta?.dir || 'ltr';
  }

  async function set(code) {
    if (!langues.some(l => l.code === code)) return;
    current = code;
    dict = await load(code);
    try { localStorage.setItem(STORAGE_KEY, code); } catch (_) {}
    apply();
    document.dispatchEvent(new CustomEvent('i18n:changed', { detail: { lang: code } }));
    // L'app enregistre aussi la préférence sur le profil (appel serveur) : à brancher ici.
  }

  async function init() {
    // La liste des langues et le dictionnaire de repli ne dependent pas l'un de
    // l'autre : les deux partaient en FILE, soit deux allers-retours la ou un
    // seul suffit. `detect()` a besoin des deux, il attend donc les deux.
    const [liste, repli] = await Promise.all([
      fetch(`${BASE}langues.json?v=${VERSION}`).then(r => {
        if (!r.ok) throw new Error('i18n: langues.json introuvable');
        return r.json();
      }),
      load(FALLBACK)
    ]);
    langues = liste;
    fallbackDict = repli;
    current = detect();
    dict = current === FALLBACK ? fallbackDict : await load(current);
    apply();
    return current;
  }

  // Formats : jamais à la main.
  const date  = (d, opts = { weekday: 'long', day: 'numeric', month: 'long' }) => new Intl.DateTimeFormat(current, opts).format(d);
  const time  = (d) => new Intl.DateTimeFormat(current, { hour: '2-digit', minute: '2-digit' }).format(d);
  const money = (n, currency = 'EUR') => new Intl.NumberFormat(current, { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
  const pct   = (x) => new Intl.NumberFormat(current, { style: 'percent', maximumFractionDigits: 0 }).format(x);
  const num   = (n, opts) => new Intl.NumberFormat(current, opts).format(n);

  return { init, t, set, apply, date, time, money, pct, num, get lang() { return current; }, get langues() { return langues; } };
})();
