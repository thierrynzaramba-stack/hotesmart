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

// ⚠ LE JOUR A PARIS, PAS LE JOUR DU PROCESS — releve en review.
// La premiere version lisait `getFullYear()/getMonth()/getDate()`, donc le
// fuseau du process. Aucun `TZ` n'est pose dans `vercel.json` : la fonction
// tourne en UTC, et le « minuit local » que le commentaire promettait n'existait
// pas. Le defaut est fail-closed (UTC <= Paris, donc aucune periode future ne
// passe), mais il refusait a l'hote une journee entierement revolue : le
// 13 septembre a 00 h 30 a Paris, le serveur est encore le 12, et une periode
// finissant le 12 etait rejetee comme « future ».
function jourLocal (d) {
  // `en-CA` rend directement `YYYY-MM-DD`.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(d)
}
const { createClient } = require('@supabase/supabase-js')
const {
  exceptionsDuBien, creerException, supprimerException
} = require('../lib/yield/exceptions')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

module.exports = async (req, res) => {
  const body = req.body || {}
  // ⚠ DEUX NOMS POUR LA MEME CHOSE, ET ÇA A TUE LE LOT 4.3 ENTIER.
  // Cet endpoint (lot 2.2) attend `bien` ; `/api/yield` (lot 4.1) attend
  // `property_id`. L'ecran, ecrit contre le second, envoyait `property_id` au
  // premier : `bienDemande` valait `undefined` et CHAQUE saisie repondait
  // « Aucun logement designe », AVANT meme la garde. Les deux boutons de la
  // page — declarer et supprimer — etaient morts, et `npm test` etait vert.
  // On accepte les deux noms plutot que d'en imposer un : casser un appelant
  // existant pour une question de vocabulaire serait payer deux fois.
  const bienDemande = req.query.bien || body.bien ||
    req.query.property_id || body.property_id
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
        debut, fin, motif,
        // ⚠ L'HORLOGE VIENT DU SERVEUR, JAMAIS DU CORPS DE LA REQUETE.
        // Une exception porte sur le PASSE (arbitrage du lot 4.3) : laisser
        // l'appelant fournir « aujourd'hui » reviendrait a lui laisser ouvrir
        // l'avenir en envoyant la date de son choix.
        aujourdHui: jourLocal(new Date())
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
      // ⚠ `futur` REJOINT LA LISTE : une exception posee sur l'avenir est une
      // saisie a corriger, pas une panne. Sans ce mot, l'hote recevait 503
      // « service indisponible » sur un refus qu'il pouvait corriger lui-meme.
      const validation = /periode invalide|motif requis|motif trop long|futur/.test(e.message)
      if (!validation) console.error('[yield-exceptions] POST', e.message)
      if (!validation) return res.status(503).json({ error: 'ecriture_impossible' })
      // ⚠ UN CODE POUR LE REFUS PRINCIPAL DU LOT — releve en review.
      // Le message brut du writer partait tel quel a l'hote : « periode dans le
      // futur : ... (une exception porte sur le passe ; fermez la date au
      // calendrier pour l avenir) » — sans accents, non traduit, et c'est
      // justement le refus qu'il rencontrera le plus souvent.
      const code = /futur/.test(e.message) ? 'periode_future' : null
      return res.status(400).json({
        error: code || e.message.replace('[yield-exceptions] ', ''),
        ...(code ? { detail: e.message.replace('[yield-exceptions] ', '') } : {})
      })
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
