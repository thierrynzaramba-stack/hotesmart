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
//   export_urls { ids }                   -> lot 8d : les URL de lecture (60 s)
//                                            des factures ENREGISTRÉES (≤ 20)
//   credit_importer  { fichier (PDF en base64), preteur, entite_id, bien_id }
//                                         -> le crédit et ses charges (§14.20)
//   credit_supprimer { id }               -> le crédit, ses échéances, ses charges
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

const ACTIONS = new Set(['envoi', 'confirmer', 'valider', 'trancher', 'supprimer', 'consulter', 'export_urls', 'credit_importer', 'credit_supprimer',
  // Lot 8b (§14.21.3) : un seul bouton « Ajouter », le tableau reconnu tout seul.
  'tableau_importer', 'tableau_reconnaitre', 'tableau_en_facture'])
// Un tableau d'amortissement en base64 : 2 Mo de PDF font 2,7 Mo de texte, sous
// la limite de 4,5 Mo d'un corps de requête Vercel.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/

function rendre (res, r, succes) {
  if (!r.ok) return res.status(r.statut || 500).json({ error: r.code || 'erreur', ...(r.detail ? { detail: String(r.detail) } : {}) })
  return res.status(200).json({ ok: true, ...succes(r) })
}

/**
 * Lit une charge `a_lire` et rend l'issue à l'écran.
 * ⚠ LA LECTURE SE FAIT TOUT DE SUITE quand c'est possible : l'hôte attend son
 * formulaire pré-rempli. Une PANNE ou le PLAFOND du jour laissent la charge
 * `a_lire` : le cron dédié la relira, sans compter d'échec.
 */
async function lireEtRendre (res, { compte, charge, octets, type, tableau }) {
  const resultat = tableau
    ? { tableau }
    : (await charges.lectureAutorisee(supabase, compte))
        ? await lireDocument({ octets, type, compte })
        : { plafond: true }
  const a = await charges.appliquerLecture(supabase, { compte, id: charge.id, resultat })
  if (!a.ok && a.code === 'pas_a_lire') {
    // Une autre écriture est passée entre-temps (le cron) : l'hôte reçoit la
    // charge telle qu'elle est, pas un refus pour un travail fait.
    const l = await charges.lireCharge(supabase, { compte, id: charge.id })
    return rendre(res, l, x => ({ issue: 'deja_lue', charge: x.charge }))
  }
  if (!a.ok) return rendre(res, a)
  return res.status(200).json({ ok: true, issue: a.issue, charge: a.charge || charge })
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
      // ⚠ LE TABLEAU D'ABORD (§14.21.3) : un PDF qui est un tableau
      // d'amortissement lisible passe `tableau` SANS appel à l'IA — donc sans
      // toucher au plafond du jour, que cette reconnaissance précède.
      const t = await charges.lireCommeTableau(r.octets, r.type, compte)
      return lireEtRendre(res, { compte, charge: r.charge, octets: r.octets, type: r.type, tableau: t.ok ? t.tableau : null })
    }

    if (action === 'tableau_reconnaitre') {
      const r = await charges.passerEnTableau(supabase, { compte, id: corps.id })
      return rendre(res, r, x => ({ issue: 'tableau', charge: x.charge }))
    }

    if (action === 'tableau_en_facture') {
      const r = await charges.tableauEnFacture(supabase, { compte, id: corps.id })
      if (!r.ok) return rendre(res, r)
      // L'hôte vient de dire « ce n'est pas un tableau » : l'IA lit, sans
      // repasser par la reconnaissance (elle le renverrait d'où il vient).
      return lireEtRendre(res, { compte, charge: r.charge, octets: r.octets, type: r.type, tableau: null })
    }

    if (action === 'tableau_importer') {
      const r = await charges.importerTableau(supabase, {
        compte, id: corps.id, preteur: corps.preteur, entiteId: corps.entite_id, bienId: corps.bien_id
      })
      return rendre(res, r, x => ({ credit: x.credit, charges: x.charges, charge_retiree: x.charge_retiree }))
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

    if (action === 'credit_importer') {
      const b64 = typeof corps.fichier === 'string' ? corps.fichier.replace(/\s+/g, '') : ''
      if (!b64) return res.status(400).json({ error: 'fichier_requis' })
      if (b64.length > Math.ceil(charges.CREDIT_PDF_MAX / 3) * 4 + 4) return res.status(413).json({ error: 'trop_gros' })
      if (!BASE64_RE.test(b64)) return res.status(400).json({ error: 'fichier_invalide' })
      const r = await charges.importerCredit(supabase, {
        compte, octets: Buffer.from(b64, 'base64'),
        preteur: corps.preteur, entiteId: corps.entite_id, bienId: corps.bien_id
      })
      return rendre(res, r, x => ({ credit: x.credit, charges: x.charges }))
    }

    if (action === 'credit_supprimer') {
      const r = await charges.supprimerCredit(supabase, { compte, id: corps.id })
      return rendre(res, r, x => ({ supprime: x.supprime }))
    }

    if (action === 'export_urls') {
      const r = await charges.urlsExport(supabase, { compte, ids: corps.ids })
      return rendre(res, r, x => ({ urls: x.urls, absentes: x.absentes, expire_dans_s: x.expire_dans_s }))
    }

    // consulter
    const r = await charges.urlConsultation(supabase, { compte, id: corps.id })
    return rendre(res, r, x => ({ url: x.url, expire_dans_s: x.expire_dans_s }))
  } catch (e) {
    console.error('[charges]', action, e && e.message)
    return res.status(500).json({ error: 'erreur' })
  }
}
