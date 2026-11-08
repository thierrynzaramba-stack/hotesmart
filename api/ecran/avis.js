// api/ecran/avis.js — L'APPEL D'ECRAN DE LA PAGE AVIS (refonte V5).
// Spec : docs/specs/avis-v5/spec-refonte-ui-v5-lot-avis.md §6, point 1.
//
// La page peint tout son premier affichage avec CET appel : les cartes par
// sejour, les trois chiffres, la liste des biens (filtre et formulaire), les
// periodes, et l'etat de la publication automatique. Avant, c'etaient trois
// appels `/api` partis l'un apres l'autre, derriere dix lectures Supabase du
// vieux socle : ecran complet a 4,8 s, mesure en production le 8 novembre 2026.
//
// ⚠ IL NE RECOPIE AUCUNE LECTURE : il appelle `cartesLister` et
// `autoValidationLire` d'`api/avis.js`, avec leurs gardes de perimetre (un
// membre limite a un bien ne lit que lui ; le nom et les dates d'un sejour
// suivent `reservations`, pas `avis`). Deux copies d'une regle de droits
// divergent ; c'est ainsi que dix fuites sont nees (docs/kb/profils-et-droits.md).
//
// ⚠ LECTURE SEULE. Les gestes (corriger un classement, confirmer une
// detection, saisir un avis) restent sur `api/avis.js`, avec leurs gardes
// d'ecriture.
//
// ⚠ L'EN-TETE PRIVE AVANT TOUT REFUS, y compris celui de methode (dette 90) :
// c'est `contexteDEcran` qui le pose, en premier.

const { contexteDEcran } = require('../../lib/require-permission')
const { peutLire } = require('../../lib/permissions')
const { compterRequetes } = require('../../lib/compte-requetes')
const avis = require('../avis')

// Les lectures d'`api/avis.js` repondent sur un `res` : on leur en donne un
// qui garde le code et le corps au lieu de les envoyer.
function reponseCaptee () {
  const sortie = { code: 200, body: null }
  const res = {
    headersSent: false,
    setHeader () {},
    status (c) { sortie.code = c; return res },
    json (b) { sortie.body = b; res.headersSent = true; return res },
  }
  return { sortie, res }
}

// La seule chose que la page affiche de ce reglage : combien de biens l'ont.
// Le detail (delais, droits par bien) reste au volet Reglages, qui le lit
// lui-meme a l'ouverture.
function resumeAuto (corps) {
  const biens = (corps && Array.isArray(corps.biens)) ? corps.biens : null
  if (!biens) return null
  return { actifs: biens.filter(b => b.heures !== null && b.heures !== undefined).length, total: biens.length }
}

module.exports = async (req, res) => {
  const t0 = Date.now()
  const garde = await contexteDEcran(req, res)
  if (!garde.ok) return
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Méthode non autorisée' })
  }
  const { userId, accountUserId, contexte } = garde
  // ⚠ AVANT TOUTE LECTURE : un refus pose apres la lecture a deja sorti les
  // donnees de la base.
  if (!peutLire(contexte, 'avis', null)) {
    return res.status(403).json({ error: 'Droits insuffisants' })
  }
  const g = { ok: true, userId, accountUserId, contexte, bien: null, booking: null }
  const query = {
    periode: req.query && req.query.periode,
    bien: req.query && req.query.bien,
    anciens: req.query && req.query.anciens,
  }

  let lu
  try {
    lu = await compterRequetes(async () => {
      const cartes = reponseCaptee()
      const auto = reponseCaptee()
      await Promise.all([
        avis.ecran.cartesLister({ method: 'GET', query }, cartes.res, g),
        avis.ecran.autoValidationLire({ method: 'GET', query: {} }, auto.res, g),
      ])
      return { cartes: cartes.sortie, auto: auto.sortie }
    })
  } catch (e) {
    console.error('[ecran/avis] lecture echec:', e && e.message)
    return res.status(500).json({ error: 'Lecture impossible' })
  }
  res.setHeader('Server-Timing', `total;dur=${Date.now() - t0};desc="${lu.requetes} requêtes"`)

  const { cartes, auto } = lu.resultat
  if (cartes.code !== 200) {
    return res.status(cartes.code).json(cartes.body || { error: 'Lecture impossible' })
  }
  // L'etat de la publication automatique n'est qu'une information : son echec
  // se tait (la page masque la ligne), il ne casse pas l'ecran.
  return res.status(200).json({ ...cartes.body, publication_auto: auto.code === 200 ? resumeAuto(auto.body) : null })
}
