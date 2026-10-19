// ═══════════════════════════════════════════════════════════════════════════
// GET /api/logement — la liste V5 (sans `id`) et la fiche d'un bien (avec `id`)
// ═══════════════════════════════════════════════════════════════════════════
//
// Etape 0 du lot « Logements V5 » (docs/specs/logements-v5/). Un endpoint de
// LECTURE SEULE : aucune ecriture, aucun appel au partenaire, aucun identifiant
// du partenaire dans la reponse. Les actions passent par les endpoints
// existants (PATCH, photo, automation, DELETE…), inchanges.
//
// ⚠ POURQUOI UN FICHIER NEUF, ET PAS UN PARAMETRE DE PLUS SUR
// api/channel-property.js. Ce fichier porte deja GET (la liste), POST (creation
// ET releve des canaux), PATCH et DELETE sur 1 100 lignes, avec quatre gardes
// differentes — et c'est celui ou un patch mecanique a casse l'iframe de
// connexion le 19 octobre 2026. Une lecture, une garde, un fichier : ca se
// relit.
//
// ⚠ ET channel-property GET RESTE INCHANGE (decision de Thierry, 19 octobre
// 2026). Le « fait date » est une lecture de bookings_snapshot : la poser dans
// l'ancien GET l'aurait fait porter a TOUS ses appelants — dont les ecrans qui
// n'affichent aucun fait date. Ici, aucun appelant existant ne change, donc le
// lot n'emporte aucun risque de regression sur les ecrans d'aujourd'hui.

const { createClient } = require('@supabase/supabase-js')
const { requirePermission } = require('../lib/require-permission')
const { refsDuPerimetre } = require('../lib/permissions')
const { lireFiche, lireListe } = require('../lib/logement/lecture')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

module.exports = async function handler (req, res) {
  // ⚠ Le navigateur ne doit pas servir une fiche en cache : les canaux, le fait
  // date et le drapeau de suppression changent sans que l'URL change.
  res.setHeader('cache-control', 'max-age=0, must-revalidate')

  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET')
    return res.status(405).json({ error: 'Méthode non autorisée' })
  }

  const id = req.query && req.query.id != null ? String(req.query.id).trim() : ''

  // ─── La fiche d'un bien ───
  if (id) {
    // ⚠ LE BIEN DESIGNE LE COMPTE. C'est la regle du depot : `X-Compte` est
    // ignore ici, puisque la ressource fait foi — un membre ne peut donc pas
    // lire la fiche d'un bien d'un autre compte en passant un en-tete.
    // `bienRequis` rend 404 sur un bien inconnu, sans distinguer « n'existe
    // pas » de « ne vous appartient pas », et sans renvoyer une donnee.
    const garde = await requirePermission(req, res, {
      domaine: 'reservations', niveau: 'read', bien: id, bienRequis: true
    })
    if (!garde.ok) return

    // ⚠ On lit par l'UUID RESOLU PAR LA GARDE, pas par le parametre brut : le
    // client peut legitimement passer une reference partenaire (c'est ce que
    // `resoudreBien` accepte), et `.eq('id', <ref texte>)` echouerait en 22P02
    // — le troisieme passage du piege UUID.
    const bienId = garde.bien ? garde.bien.id : id

    try {
      const fiche = await lireFiche(supabase, {
        compte: garde.accountUserId, bienId
      })
      // La garde a deja rendu 404 pour un bien inconnu ; ici, c'est un bien
      // connu mais absent du compte proprietaire — on ne renseigne pas plus.
      if (!fiche) return res.status(404).json({ error: 'Bien introuvable' })
      return res.status(200).json(fiche)
    } catch (e) {
      // ⚠ UNE PANNE SE DIT 503, ELLE NE SE DEGUISE PAS EN FICHE VIDE. Un 200
      // ampute laisserait l'ecran afficher un bien sans nom ni prix, et l'hote
      // croirait a une perte de donnees.
      console.error('[logement] fiche illisible :', e.message)
      return res.status(503).json({ error: 'La fiche de ce logement est momentanément indisponible. Réessayez dans un instant.' })
    }
  }

  // ─── La liste ───
  //
  // ⚠ `compteDelegue: true` : c'est la liste des biens, donc le premier ecran
  // d'un membre delegue. Sans elle, il ne verrait aucun bien. La garde revalide
  // l'en-tete X-Compte — etre membre actif de ce compte, ou rien.
  const garde = await requirePermission(req, res, {
    domaine: 'reservations', niveau: 'read', compteDelegue: true
  })
  if (!garde.ok) return

  // ⚠ FILTRE DE PERIMETRE, OBLIGATOIRE SUR UNE COLLECTION. `requirePermission`
  // ne verifie rien bien par bien quand aucun bien n'est designe : sans ce
  // filtre, un membre invite sur UN bien recevrait le portefeuille COMPLET du
  // titulaire — noms, adresses, prix de base, annonces.
  const refsPerimetre = refsDuPerimetre(garde.contexte)

  try {
    const liste = await lireListe(supabase, {
      compte: garde.accountUserId, refsPerimetre
    })
    return res.status(200).json(liste)
  } catch (e) {
    console.error('[logement] liste illisible :', e.message)
    return res.status(503).json({ error: 'La liste de vos logements est momentanément indisponible. Réessayez dans un instant.' })
  }
}
