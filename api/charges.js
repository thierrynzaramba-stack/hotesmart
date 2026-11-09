// ═══════════════════════════════════════════════════════════════════════════
// /api/charges — LES ÉCRITURES DU COMPTE DE CHARGES (lot 2, le socle)
// Spec : docs/specs/spec-compte-de-charges.md §5, §6 ; Q9
//
// POST seulement, une action par appel :
//   envoi      { type, octets, origine }  -> { id, url }   (URL d'envoi signée)
//   confirmer  { id }                     -> la charge, lue par l'IA si possible
//   valider    { id, champs }             -> la charge validée
//   trancher   { id }                     -> le signal « Vérifier » tranché
//   supprimer  { id }                     -> Q11 : à tout moment
//   consulter  { id }                     -> URL de lecture de 60 s
// L'écran (lot 3) lit par `/api/ecran/charges` ; ici, on n'écrit que.
//
// ⚠ RÉSERVÉ AU TITULAIRE DU COMPTE, LECTURE COMPRISE (Q9, 8 novembre 2026).
// Pas le domaine `facturation` : sa LECTURE se délègue, et un hôte qui donne
// la lecture de l'abonnement ouvrirait toutes ses factures sans le savoir. La
// garde est EXPLICITE (`estTitulaireDuCompte`) et posée AVANT toute lecture :
// `contexteDEcran` refuse sans session, il ne refuse pas un membre.
//
// ⚠ AUCUNE REQUÊTE ICI SUR LES TABLES DES CHARGES : tout passe par le writer
// unique (`lib/charges.js`), qui porte le cloisonnement par compte.
// ═══════════════════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js')
const { contexteDEcran, posterEnTetesPrives } = require('../lib/require-permission')
const { estTitulaireDuCompte } = require('../lib/permissions')
const charges = require('../lib/charges')
const { lireDocument } = require('../lib/charges/lecture')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

const ACTIONS = new Set(['envoi', 'confirmer', 'valider', 'trancher', 'supprimer', 'consulter'])

function rendre (res, r, succes) {
  if (!r.ok) return res.status(r.statut || 500).json({ error: r.code || 'erreur' })
  return res.status(200).json({ ok: true, ...succes(r) })
}

module.exports = async function handler (req, res) {
  // ⚠ L'EN-TÊTE PRIVÉ AVANT LE PREMIER REFUS, LE 405 COMPRIS (dette 90).
  posterEnTetesPrives(res)
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Méthode non autorisée' })
  }

  const garde = await contexteDEcran(req, res)
  if (!garde.ok) return
  if (!estTitulaireDuCompte(garde.contexte)) {
    return res.status(403).json({ error: 'Réservé au titulaire du compte' })
  }
  const compte = garde.accountUserId

  const corps = req.body || {}
  const action = String(corps.action || '')
  if (!ACTIONS.has(action)) return res.status(400).json({ error: 'action_inconnue' })

  try {
    if (action === 'envoi') {
      const r = await charges.ouvrirEnvoi(supabase, {
        compte, type: String(corps.type || ''), octets: corps.octets,
        origine: corps.origine === 'photo' ? 'photo' : 'fichier'
      })
      return rendre(res, r, x => ({ id: x.id, url: x.url, jeton: x.jeton }))
    }

    if (action === 'confirmer') {
      const r = await charges.confirmerEnvoi(supabase, { compte, id: corps.id })
      if (!r.ok) return rendre(res, r)
      // ⚠ LA LECTURE SE FAIT TOUT DE SUITE quand c'est possible : l'hôte attend
      // son formulaire pré-rempli. Une PANNE laisse la charge `a_lire` : le
      // cron dédié la relira, sans la compter comme un échec.
      const resultat = await lireDocument({ octets: r.octets, type: r.type, compte })
      const a = await charges.appliquerLecture(supabase, { compte, id: r.charge.id, resultat })
      if (!a.ok) return rendre(res, a)
      return res.status(200).json({ ok: true, issue: a.issue, charge: a.charge || r.charge })
    }

    if (action === 'valider') {
      const r = await charges.valider(supabase, {
        compte, valideur: garde.userId, id: corps.id, champs: corps.champs
      })
      return rendre(res, r, x => ({ charge: x.charge }))
    }

    if (action === 'trancher') {
      const r = await charges.trancher(supabase, { compte, id: corps.id })
      return rendre(res, r, () => ({}))
    }

    if (action === 'supprimer') {
      const r = await charges.supprimer(supabase, { compte, id: corps.id })
      return rendre(res, r, x => ({ supprime: x.supprime }))
    }

    // consulter
    const r = await charges.urlConsultation(supabase, { compte, id: corps.id })
    return rendre(res, r, x => ({ url: x.url, expire_dans_s: x.expire_dans_s }))
  } catch (e) {
    console.error('[charges]', action, e && e.message)
    return res.status(500).json({ error: 'erreur' })
  }
}
