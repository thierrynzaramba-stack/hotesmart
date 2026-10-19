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
const { refsDuPerimetre, peutLire, peutEcrire } = require('../lib/permissions')
const { lireFiche, lireListe } = require('../lib/logement/lecture')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// ⚠ LES DROITS PAR DOMAINE, AU-DELA DE LA GARDE D'ENTREE. Constat de SECURITE de
// la revue du 20 octobre 2026. `reservations: read` ouvre l'endpoint, mais trois
// blocs appartiennent a d'autres domaines, et leurs policies RLS le disent :
// `property_cleaning_providers` -> 'prestataires', `ota_reviews` -> 'avis',
// `taxes_sejour` -> table de service (`revoke all from authenticated`).
// L'endpoint tourne en service key, qui contourne la RLS par conception : c'est
// pour ca qu'il doit verifier lui-meme. Sans ces trois lignes, un co-hote invite
// avec `prestataires: none` recevait le nom de la prestataire de menage, son rang
// et ses jours de travail — ce que api/menages.js lui refuse.
//
// Le precedent est explicite (api/menages.js, equipe du 13 octobre) : « TROIS
// DROITS, TROIS CHOSES ».
//
// ⚠ `reglages_write` N'OUVRE RIEN ICI : il ne sert qu'a ne pas PROMETTRE a un
// profil en lecture une suppression que le serveur lui refusera en 403.
function droitsDesBlocs (contexte, cible) {
  return {
    prestataires: peutLire(contexte, 'prestataires', cible),
    avis: peutLire(contexte, 'avis', cible),
    // ⚠ `reglages` COUVRE DEUX BLOCS : les serrures (`property_locks_select` et
    // `locks_select` font tous deux `can_read(user_id, 'reglages', …)`, et
    // api/serrures.js declare `locks: ['reglages', 'read']`) et le BAREME de la
    // taxe de sejour — decision de Thierry du 20 octobre 2026 : la fiche ne
    // montre que le bareme, les montants collectes restent sous `facturation`
    // et hors de cette fiche.
    reglages: peutLire(contexte, 'reglages', cible),
    reglages_write: peutEcrire(contexte, 'reglages', cible)
  }
}

module.exports = async function handler (req, res) {
  // ⚠ Le navigateur ne doit pas servir une fiche en cache : les canaux, le fait
  // date et le drapeau de suppression changent sans que l'URL change. Et la
  // reponse est PROPRE A UN COMPTE : `private, no-store` dit ce qu'on veut dire,
  // la ou `must-revalidate` autorise encore un cache partage a la detenir
  // (constat L1 de la revue).
  res.setHeader('cache-control', 'private, no-store')
  res.setHeader('vary', 'authorization, x-compte')

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

    const cible = garde.bien ? { id: garde.bien.id, ref: garde.bien.provider_property_id } : null
    try {
      const fiche = await lireFiche(supabase, {
        compte: garde.accountUserId, bienId,
        droits: droitsDesBlocs(garde.contexte, cible)
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
    // ⚠ AUCUN DROIT DE DOMAINE A PASSER : la liste ne lit que `properties`,
    // `canaux_*`, `bookings_snapshot` et `fermetures` — tout le domaine
    // `reservations`, deja verifie par la garde. Le perimetre, lui, est un filtre.
    const liste = await lireListe(supabase, {
      compte: garde.accountUserId, refsPerimetre
    })
    return res.status(200).json(liste)
  } catch (e) {
    console.error('[logement] liste illisible :', e.message)
    return res.status(503).json({ error: 'La liste de vos logements est momentanément indisponible. Réessayez dans un instant.' })
  }
}
