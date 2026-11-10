// api/alertes-desinscription.js — la page de désinscription d'un contact libre
// (PWA lot 2c-3, étape 3). Spec : docs/specs/spec-pwa-lot2-notifications.md §16.8,
// Q30 et Q33 · KB : docs/kb/pwa.md §12.3
//
//   GET  /api/alertes-desinscription?jeton=…   → la page : l'adresse masquée, les
//                                                logements, UN bouton
//   POST /api/alertes-desinscription  jeton, action=arreter|reprendre  → le geste
//
// ⚠ PUBLIQUE, SANS SESSION : le jeton de 64 caractères porté par chaque e-mail
// du contact est la seule clé, et il ne vaut que pour CE contact (et les autres
// contacts du même compte qui portent la même adresse : c'est l'ADRESSE qui se
// désinscrit, lib/notifications/contacts.js `lignesDuLien`). Il change quand
// l'adresse du contact change (Q35) : un ancien lien ne fait plus rien.
// ⚠ UN GET NE CHANGE JAMAIS RIEN : les messageries d'entreprise ouvrent les liens
// d'un e-mail pour les inspecter. Le geste est le bouton, donc un POST.
// ⚠ `private, no-store` et non indexée, AVANT le premier refus ; aucun script ;
// la page ne montre ni l'adresse en clair, ni le jeton ailleurs que dans son
// propre formulaire, ni qui est l'hôte.

const { posterEnTetesPrives } = require('../lib/require-permission')
const contacts = require('../lib/notifications/contacts')
const reglages = require('../lib/notifications/reglages')
const textes = require('../lib/notifications/textes')
const { masquer } = require('../lib/notifications/reprise-listes')

function client () {
  return require('../lib/cron-shared').supabase
}

function champs (req) {
  const b = req.body
  if (b && typeof b === 'object') return b
  if (typeof b === 'string' && b) {
    try { return Object.fromEntries(new URLSearchParams(b)) } catch { return {} }
  }
  return {}
}

function envoyerPage (res, code, page) {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  return res.status(code).send(page)
}

// La langue du titulaire (Q31) ; le français si on ne peut pas la lire.
async function langueDuCompte (compte, db) {
  try {
    const r = await reglages.lire({ userId: compte, db })
    return r.ok ? r.reglages.langue : 'fr'
  } catch { return 'fr' }
}

// Les logements de TOUTES les lignes que le bouton fera taire (constat D3 de
// review) : la page dit ce que fait le geste, pas moins.
async function nomsDesBiens (compte, lignes, db) {
  const ids = [...new Set(lignes.flatMap(l => (Array.isArray(l.biens) ? l.biens : []).map(String)))]
  if (!ids.length) return []
  const { data, error } = await db.from('properties').select('name').eq('user_id', compte).in('id', ids)
  if (error) return []
  return (data || []).map(p => p.name).filter(Boolean).sort()
}

const adresseMasquee = (c) => (c.email ? masquer('email', c.email) : masquer('sms', c.telephone))

async function handler (req, res, { db = null } = {}) {
  posterEnTetesPrives(res)
  res.setHeader('x-robots-tag', 'noindex, nofollow')
  res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'")
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST')
    return envoyerPage(res, 405, textes.pageDesinscription({ langue: 'fr', etat: 'invalide' }))
  }
  const base = db || client()
  const jeton = String(req.method === 'GET' ? ((req.query && req.query.jeton) || '') : (champs(req).jeton || ''))
  try {
    const lu = await contacts.lignesDuLien({ jeton, db: base })
    if (!lu.ok) return envoyerPage(res, 503, textes.pageDesinscription({ langue: 'fr', etat: 'panne' }))
    if (!lu.contact) return envoyerPage(res, 404, textes.pageDesinscription({ langue: 'fr', etat: 'invalide' }))
    const c = lu.contact
    const langue = await langueDuCompte(c.compte_id, base)

    if (req.method === 'GET') {
      const biens = await nomsDesBiens(c.compte_id, lu.lignes, base)
      return envoyerPage(res, 200, textes.pageDesinscription({
        langue, etat: c.desinscrit_le ? 'desinscrit' : 'inscrit', adresse: adresseMasquee(c), biens, jeton
      }))
    }

    const action = champs(req).action
    if (action !== 'arreter' && action !== 'reprendre') return envoyerPage(res, 400, textes.pageDesinscription({ langue, etat: 'invalide' }))
    const r = await contacts.changerInscriptionParJeton({ jeton, inscrit: action === 'reprendre', db: base })
    if (!r.ok) {
      const code = r.motif === 'contact_introuvable' ? 404 : 503
      return envoyerPage(res, code, textes.pageDesinscription({ langue, etat: code === 404 ? 'invalide' : 'panne' }))
    }
    return envoyerPage(res, 200, textes.pageDesinscription({ langue, etat: action === 'arreter' ? 'fait_arret' : 'fait_reprise' }))
  } catch (e) {
    console.error('alertes-desinscription:', e && e.message)
    return envoyerPage(res, 500, textes.pageDesinscription({ langue: 'fr', etat: 'panne' }))
  }
}

module.exports = (req, res) => handler(req, res)
module.exports.handler = handler
