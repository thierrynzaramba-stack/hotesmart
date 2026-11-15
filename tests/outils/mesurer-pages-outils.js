#!/usr/bin/env node
// tests/outils/mesurer-pages-outils.js
// LA MESURE AVANT / APRÈS DES PAGES OUTILS (intégration V5) — case 8 de la
// règle de performance (CLAUDE.md) : appels, requêtes, octets, MESURÉS.
//
//   node tests/outils/mesurer-pages-outils.js apps/serrures/index.html …
//
// Ce que la mesure EXÉCUTE, sur un compte de démonstration fixe (titulaire,
// Brevo et Seam configurés, deux logements chez le gestionnaire de canaux,
// onboarding terminé, hors bêta, essai GuestFlow en cours) :
//  - la page elle-même, au banc (tests/outils/banc-page.js) ;
//  - la VRAIE barre latérale de l'ancien socle (components/sidebar.js) et son
//    VRAI bandeau d'incitation (components/onboarding-banner.js), exécutés au
//    banc avec leurs lectures — une mesure AVANT qui les omettrait mesurerait
//    une page qui n'a jamais existé ;
//  - le VRAI `requireAuth` (components/auth-guard.js) ; le contexte de compte
//    est compté UN appel `/api/membres` au premier chargement (cache froid,
//    shared/compte-courant.js le garde ensuite 3 minutes).
// Ce qu'elle NE mesure PAS, et le dit : le nombre de requêtes Supabase faites
// CÔTÉ SERVEUR par chaque `/api/…`. Le lot ne touche aucun fichier api/ : ce
// nombre est le même avant et après, par construction.
// Les octets : ceux du dépôt que le navigateur télécharge (banc-page.js,
// `octetsStatiques`), plus les dictionnaires que le moteur i18n a demandés.

const path = require('path')
const { monterPage, evaluerModule, octetsStatiques, RACINE } = require('./banc-page')

const SESSION = { access_token: 'jeton-session', user: { id: 'u-moi', email: 'thierry@exemple.test', user_metadata: {} } }

const API = (u, e) => {
  const q = u.split('?')[1] || ''
  if (u.startsWith('/api/serrures')) {
    if (/action=config/.test(q)) return { body: { configured: true, enabled: true } }
    if (/action=locks/.test(q)) return { body: { locks: [] } }
    return { body: { success: true } }
  }
  if (u.startsWith('/api/sms')) {
    if (/action=config/.test(q)) return { body: { configured: true, enabled: true, senderEmail: 'contact@exemple.test' } }
    if (/action=senders/.test(q)) return { body: { configured: true, senders: [{ email: 'contact@exemple.test', name: 'Thierry' }] } }
    if (/action=logs/.test(q)) return { body: { logs: [] } }
    return { body: { success: true } }
  }
  if (u.startsWith('/api/beds24-setup')) return { body: { connected: false } }
  if (u.startsWith('/api/channel-property')) {
    return { body: { properties: [
      { id: 'b1', name: 'La bulle', provider: 'channex', city: 'Bagnères-de-Bigorre', capacity: 2 },
      { id: 'b2', name: 'Cœur de vie 23', provider: 'channex', city: 'Bagnères-de-Bigorre', capacity: 4 }
    ] } }
  }
  if (u.startsWith('/api/stripe')) return { body: { url: 'https://stripe.test/x' } }
  return null
}

const TABLES = {
  api_keys: { data: { api_key: null, seam_api_key: 'x', seam_enabled: true, brevo_api_key: 'k', brevo_enabled: true }, error: null },
  properties: { data: [{ id: 'b1' }], error: null },
  onboarding_state: { data: { current_step: 7, completed: true, data: {} }, error: null },
  accounts: { data: { is_beta: false }, error: null },
  subscriptions: (req) => req.filtres.some(f => f[1] === 'module')
    ? { data: { status: 'trialing' }, error: null }
    : { data: [{ module: 'guestflow', status: 'trialing', trial_ends_at: '2026-11-30T00:00:00Z', current_period_end: null, cancel_at_period_end: false, quantity: 2 }], error: null }
}

function injecter (w, journal, supabase) {
  const contexte = { charge: false }
  const chargerContexte = async () => {
    if (contexte.charge) return { comptes: [] }
    contexte.charge = true
    journal.fetch.push({ url: '/api/membres?action=mes-comptes', methode: 'GET', note: 'contexte de compte (cache froid)' })
    return { comptes: [] }
  }
  const cc = {
    compteCourant: () => 'u-moi', moi: () => 'u-moi', peutLire: () => true, peutEcrire: () => true,
    estTitulaire: () => true, comptes: () => [], doitAfficherSelecteur: () => false,
    basculerVers: async () => {}, enteteCompte: () => ({}),
    exigerCompteProprePage: async () => { await chargerContexte(); return true }
  }
  const getUser = async () => (await supabase.auth.getUser()).data.user
  const getSession = async () => (await supabase.auth.getSession()).data.session
  const signOut = async () => { journal.auth.push('signOut') }
  const { requireAuth, markOnboardingCompleted } = evaluerModule(w, 'components/auth-guard.js', {
    supabase, getSession, purgerCachesLocaux: async () => {}, chargerContexte, reinitialiser: () => {}
  })
  const { renderOnboardingBanner } = evaluerModule(w, 'components/onboarding-banner.js', { supabase, getUser })
  const { sansArchives } = evaluerModule(w, 'shared/biens-vivants.js', {})
  const CONFIG = evaluerModule(w, 'shared/config.js', {}).default
  const pageOutil = evaluerModule(w, 'shared/page-outil.js', {})
  const { renderSidebar } = evaluerModule(w, 'components/sidebar.js', {
    getUser, signOut, supabase, CONFIG, sansArchives, renderOnboardingBanner, ...cc
  })
  return {
    ...cc, ...pageOutil, requireAuth, markOnboardingCompleted, renderSidebar, renderOnboardingBanner,
    supabase, getUser, getSession, signOut,
    initErrorHandler: () => {}, logger: { info () {}, warn () {}, error () {} },
    escapeHtml: (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    openConnexions: () => { journal.assistant = (journal.assistant || 0) + 1 },
    bootstrapAirbnbReturn: () => {}
  }
}

async function mesurer (rel) {
  const banc = await monterPage(rel, { api: API, tables: TABLES, session: SESSION, injecter })
  const j = banc.journal
  const statique = octetsStatiques(rel)
  const dicos = j.fetch.filter(f => f.url.startsWith('/shared/i18n/'))
  const octetsDicos = dicos.reduce((s, f) => s + (f.octets || 0), 0)
  const api = j.fetch.filter(f => f.url.startsWith('/api/'))
  const res = {
    page: rel,
    appels_api: api.map(f => `${f.methode} ${f.url}${f.corps && f.corps.action ? ' (' + f.corps.action + ')' : ''}`),
    lectures_supabase_navigateur: j.supabase.map(r => `${r.mode} ${r.table}`),
    identite_reseau: j.auth.slice(),
    dictionnaires: dicos.map(f => f.url.split('?')[0]),
    octets_depot: statique.brut,
    octets_depot_gzip: statique.gzip,
    octets_dictionnaires: octetsDicos,
    fichiers: statique.detail.length,
    externes: statique.externes,
    erreurs: j.erreurs
  }
  res.total_appels_reseau = api.length + j.supabase.length + j.auth.length + dicos.length
  banc.fermer()
  return res
}

async function main () {
  const pages = process.argv.slice(2)
  if (!pages.length) { console.error('usage : node tests/outils/mesurer-pages-outils.js <page.html> …'); process.exit(2) }
  const sortie = []
  for (const p of pages) sortie.push(await mesurer(p))
  if (process.env.JSON) { console.log(JSON.stringify(sortie, null, 2)); return }
  for (const r of sortie) {
    console.log(`\n## ${r.page}`)
    console.log(`appels /api : ${r.appels_api.length}  ->  ${r.appels_api.join(' | ') || '—'}`)
    console.log(`lectures Supabase depuis le navigateur : ${r.lectures_supabase_navigateur.length}  ->  ${r.lectures_supabase_navigateur.join(' | ') || '—'}`)
    console.log(`identité (aller-retour) : ${r.identite_reseau.length}  ->  ${r.identite_reseau.join(' | ') || '—'}`)
    console.log(`dictionnaires : ${r.dictionnaires.length}  ->  ${r.dictionnaires.join(' | ') || '—'}`)
    console.log(`TOTAL requêtes réseau vers nos services au chargement : ${r.total_appels_reseau}`)
    console.log(`octets du dépôt : ${r.octets_depot} (gzip ${r.octets_depot_gzip}) en ${r.fichiers} fichiers + dictionnaires ${r.octets_dictionnaires}`)
    console.log(`externes (non comptés) : ${r.externes.join(' | ') || '—'}`)
    if (r.erreurs.length) console.log(`ERREURS AU BANC : ${r.erreurs.join(' || ')}`)
  }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1) })
module.exports = { mesurer, API, TABLES, injecter, SESSION }
void path; void RACINE
