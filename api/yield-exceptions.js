// api/yield-exceptions.js
// Les periodes « hors reference » du moteur YieldFlow.
// Spec : docs/specs/spec-yieldflow-v1.md §5 (etape 2, lot 2.2)
// Writer : lib/yield/exceptions.js — DOC : docs/kb/capacite-yield.md §8
//
// ⚠ DEUX DOMAINES DE DROITS, ET CE N'EST PAS UNE HESITATION.
// Arbitrage de Thierry, 12 septembre 2026 :
//
//   ECRITURE -> `reglages`. Une exception ALTERE LA REFERENCE DU PRICING :
//   declarer « juin 2025 hors reference » change ce que le moteur proposera en
//   juin 2027. C'est le meme niveau de consequence qu'un prix, donc le meme
//   droit que le calendrier tarifaire. La ranger sous `reservations` aurait
//   laisse un profil qui gere les sejours modifier la strategie tarifaire.
//
//   LECTURE -> `reservations`. Les ecrans de statistiques a venir doivent
//   pouvoir AFFICHER les periodes ecartees — sans quoi un TO amoindri
//   resterait inexplicable a qui le regarde. Exiger `reglages` en lecture
//   aurait rendu les stats illisibles a un profil qui n'y a pas droit.
//
// Aucun appel provider : ces periodes n'existent chez aucun canal.

const { requirePermission, UUID_RE } = require('../lib/require-permission')
const { estJourISO } = require('../lib/yield/capacite')
const { createClient } = require('@supabase/supabase-js')
const {
  exceptionsDuBien, creerException, supprimerException
} = require('../lib/yield/exceptions')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

module.exports = async (req, res) => {
  const body = req.body || {}
  const bienDemande = req.query.bien || body.bien
  if (!bienDemande) return res.status(400).json({ error: 'bien_requis' })

  const ecriture = req.method !== 'GET'
  const garde = await requirePermission(req, res, {
    domaine: ecriture ? 'reglages' : 'reservations',
    niveau: ecriture ? 'write' : 'read',
    bien: bienDemande,
    bienRequis: true
  })
  if (!garde.ok) return

  const bien = garde.bien
  const compte = garde.accountUserId

  // ─── GET : lister ────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    // ⚠ LES BORNES SONT VALIDEES ICI — releve en review.
    // Sans cela, `?debut=2026-6-1` (mois non padde) ou un parametre repete —
    // que Vercel rend en TABLEAU, donc pas une chaine — rendait 200 « aucune
    // exception » a un hote qui en a declare. Une fenetre facultative reste
    // facultative ; une fenetre FOURNIE doit etre correcte.
    const brut = (v) => (Array.isArray(v) ? v[0] : v)
    const debutBrut = brut(req.query.debut)
    const finBrut = brut(req.query.fin)
    // Fenetre par defaut : bornee, pas 1900-2999 — enumerer un millenaire
    // couterait 400 000 iterations au moteur.
    const debut = debutBrut || '2015-01-01'
    const fin = finBrut || '2035-12-31'
    if ((debutBrut && !estJourISO(debutBrut)) || (finBrut && !estJourISO(finBrut)) || fin < debut) {
      return res.status(400).json({ error: 'periode_invalide', debut, fin })
    }
    try {
      const periodes = await exceptionsDuBien(supabase, bien.id, debut, fin)
      return res.status(200).json({ bien: bien.id, exceptions: periodes })
    } catch (e) {
      console.error('[yield-exceptions] GET', e.message)
      return res.status(503).json({ error: 'lecture_impossible' })
    }
  }

  // ─── POST : declarer ─────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { debut, fin, motif } = body
    try {
      const creee = await creerException(supabase, {
        userId: compte,          // le compte PROPRIETAIRE, pas l'appelant
        propertyId: bien.id,     // revalide serveur par la garde
        debut, fin, motif
      })
      console.log(`[yield-exceptions] ${bien.name} : ${debut} -> ${fin} « ${creee.motif} »`)
      return res.status(201).json({ exception: creee })
    } catch (e) {
      // Une saisie invalide est une erreur d'APPELANT (400), pas une panne.
      // Les deux se distinguent par le prefixe du writer : lui seul leve des
      // messages de validation.
      // ⚠ REGEX ANCREE SUR LES TROIS MESSAGES DE VALIDATION REELS.
      // L'alternative nue `requis` capturait aussi « supabase requis » et
      // « userId et propertyId requis » — des defauts de cablage SERVEUR, qui
      // seraient sortis en 400 sans `console.error`, donc invisibles en prod.
      const validation = /periode invalide|motif requis|motif trop long/.test(e.message)
      if (!validation) console.error('[yield-exceptions] POST', e.message)
      return res.status(validation ? 400 : 503)
        .json({ error: validation ? e.message.replace('[yield-exceptions] ', '') : 'ecriture_impossible' })
    }
  }

  // ─── DELETE : corriger une saisie ────────────────────────────────────────
  if (req.method === 'DELETE') {
    const id = req.query.id || body.id
    if (!id) return res.status(400).json({ error: 'id_requis' })
    // ⚠ UN ID MAL FORME EST UNE ERREUR D'APPELANT, PAS UNE PANNE.
    // `.eq('id', 'abc')` sur une colonne `uuid` fait echouer la requete : sans
    // ce test, l'appelant recevait 503 « service indisponible » et l'incident
    // partait dans les logs comme une panne d'infra.
    if (!UUID_RE.test(String(id))) return res.status(400).json({ error: 'id_invalide' })
    try {
      const r = await supprimerException(supabase, { propertyId: bien.id, id })
      // 404 plutot que 200 : « rien supprime » sur un id fourni est une
      // information, pas un succes. L'appelant doit pouvoir le distinguer.
      if (!r.supprimees) return res.status(404).json({ error: 'exception_introuvable' })
      return res.status(200).json({ supprimees: r.supprimees })
    } catch (e) {
      console.error('[yield-exceptions] DELETE', e.message)
      return res.status(503).json({ error: 'suppression_impossible' })
    }
  }

  return res.status(405).json({ error: 'methode_non_supportee' })
}
