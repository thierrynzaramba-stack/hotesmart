// api/facture-publique.js — la page du VOYAGEUR (pages/facture.html), par son
// jeton : lire sa demande de facture, remplir ou corriger ses coordonnées de
// facturation (étape 2). Aucune session : le jeton est la seule clé.
// Spec : docs/specs/spec-facture-voyageur.md §2, §5.3, §9
// KB   : docs/kb/facture-voyageur.md (modif = MEME COMMIT)
//
// POST { action: 'lire', jeton }
// POST { action: 'enregistrer', jeton, destinataire }
//
// ⚠ POST POUR LIRE AUSSI, ET C'EST VOULU : le jeton voyage dans le CORPS, jamais
// dans l'URL. La page le tient du fragment (`/facture#<jeton>`), qui n'est
// envoyé à aucun serveur ; un `GET ?jeton=` le ferait entrer dans les journaux
// de Vercel et dans l'en-tête Referer.
//
// ⚠ LA PAGE NE REÇOIT QUE SA DEMANDE : la langue, l'état, le destinataire que
// le voyageur (ou l'hôte) a saisi, le nom du logement et les dates du séjour.
// Rien d'autre du compte — ni l'identité de l'hôte avant l'émission, ni ses
// autres réservations.
//
// ⚠ LE DÉPART EST RELU DANS LE CŒUR à chaque lecture, jamais copié dans la
// demande (§5.5) : une réservation prolongée déplace la date annoncée.
//
// ⚠ UN JETON MAL FORMÉ EST REFUSÉ AVANT TOUTE REQUÊTE. Un jeton bien formé mais
// inconnu, et un jeton expiré, se disent différemment : « demandez un nouveau
// lien à votre hôte » (Q13) n'a de sens que pour le second. Le dire ne révèle
// rien — seul le détenteur du jeton peut poser la question.
//
// ⚠ `private, no-store` AVANT LE PREMIER REFUS (règle 4 de la performance) : la
// réponse porte le nom et l'adresse du voyageur.

const FV = require('../lib/factures-voyageur')
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const db = () => supabase

function posterEnTetes (res) {
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Robots-Tag', 'noindex')
}

function corpsDe (req) {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body !== 'string' || !req.body) return {}
  try { return JSON.parse(req.body) } catch (e) { return null }
}

const CODES = {
  entree_invalide: 400, lien_invalide: 404, lien_expire: 410,
  verrouillee: 409, plafond: 429, introuvable: 404, panne: 503
}
function repondreRefus (res, motif, champ = null) {
  return res.status(CODES[motif] || 400).json({ error: motif, motif, champ })
}

// Le séjour et le logement : ce que le voyageur sait déjà, pour qu'il
// reconnaisse sa réservation. Une lecture du cœur, une des propriétés.
async function lireSejour (base, demande) {
  const [resa, bien] = await Promise.all([
    base.from('bookings_snapshot').select('snapshot')
      .eq('user_id', demande.user_id).eq('booking_id', demande.booking_id).maybeSingle(),
    base.from('properties').select('name')
      .eq('id', demande.property_uuid).eq('user_id', demande.user_id).maybeSingle()
  ])
  if (resa.error || bien.error) return { ok: false }
  const sp = (resa.data && resa.data.snapshot) || {}
  return {
    ok: true,
    sejour: {
      logement: bien.data ? bien.data.name : null,
      arrivee: sp.arrival || null,
      depart: sp.departure || null
    }
  }
}

// L'état vu par la page. `modifiable` : le formulaire est encore ouvert.
function etatVu (demande, sejour) {
  return {
    langue: demande.langue,
    statut: demande.statut,
    modifiable: FV.MODIFIABLES.includes(demande.statut),
    destinataire: FV.destinataireVu(demande),
    sejour
  }
}

module.exports = async function handler (req, res) {
  posterEnTetes(res)
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Méthode non autorisée' })
  }
  const t0 = Date.now()
  let requetes = 0
  const corps = corpsDe(req)
  if (corps == null) return repondreRefus(res, 'entree_invalide')
  const action = corps.action
  if (action !== 'lire' && action !== 'enregistrer') return repondreRefus(res, 'entree_invalide', 'action')
  if (!FV.jetonBienForme(corps.jeton)) return repondreRefus(res, 'lien_invalide')

  try {
    const base = db()
    requetes += 2
    const lu = await FV.lireParJeton(corps.jeton, { db: base })
    if (!lu.ok) return repondreRefus(res, lu.motif)

    if (action === 'enregistrer') {
      const v = FV.validerDestinataire(corps.destinataire)
      if (!v.ok) return repondreRefus(res, v.motif, v.champ)
      requetes++
      const r = await FV.enregistrerDestinataire(lu.demande.user_id, lu.demande.id, v.dest,
        { jetonId: lu.jeton.id, saisiPar: 'voyageur' }, { db: base })
      if (!r.ok) return repondreRefus(res, r.motif)
      // La demande relue : l'état rendu est celui de la base, pas une
      // supposition (`lien_envoye` devient `formulaire_rempli`).
      requetes += 2
      const relu = await FV.lireParJeton(corps.jeton, { db: base })
      if (!relu.ok) return repondreRefus(res, relu.motif)
      lu.demande = relu.demande
    }

    requetes += 2
    const s = await lireSejour(base, lu.demande)
    if (!s.ok) return repondreRefus(res, 'panne')
    res.setHeader('Server-Timing', `db;desc="${requetes} requêtes";dur=${Date.now() - t0}`)
    return res.status(200).json({ ok: true, ...etatVu(lu.demande, s.sejour) })
  } catch (e) {
    console.error('[facture-publique] exception', e.message)
    if (!res.headersSent) return res.status(500).json({ error: 'erreur', motif: 'erreur' })
  }
}
