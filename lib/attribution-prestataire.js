// lib/attribution-prestataire.js
// Quels avis sont attribuables a une prestataire ?
//
// DEUX VOIES, dans cet ordre de fiabilite :
//   1. `menage_event_id` — le lien au menage PRECIS. C'est la voie normale, et
//      la seule pour tout menage futur.
//   2. `prestataire_periodes` — une attribution DECLAREE par l'hote, quand
//      aucun menage_event n'existe. Exception bornee a des faits etablis.
//
// ⚠ UN AVIS NON ATTRIBUABLE RESTE NON ATTRIBUE. Aucun forcage : ni « le
// prestataire du bien par defaut », ni « le plus probable ». Un reproche qui
// tombe sur la mauvaise personne coute plus cher qu'un reproche qui ne tombe
// sur personne.

// ⚠ BORNE DICTEE PAR LA LONGUEUR D'URL, pas par un ordre de grandeur choisi.
//
// Ces identifiants repartent en `.in('id', ids)`, que PostgREST recoit en QUERY
// STRING : un UUID pese ~37 octets, et les passerelles devant Supabase coupent
// vers 8 Ko. La barre reelle est donc autour de 200 identifiants — une premiere
// version fixait 2000, soit ~74 Ko : le mode de defaillance serait arrive DIX
// FOIS AVANT la borne, en erreur HTTP, sans que `tronque` ne se leve jamais.
//
// Regina en a 98 aujourd'hui. Le jour ou un compte approche cette borne, la
// bonne reponse est une vue ou un rpc SQL — pas une borne plus haute.
const MAX_IDS = 150

// Meme contrainte de longueur d'URL que `MAX_IDS`, appliquee aux references de
// biens d'un lot de comptage. Une reference provider est plus courte qu'un UUID,
// mais elle en est souvent un : on reste sous la meme barre.
const LOT_REFS = 100

// Date qui situe l'avis dans le temps, pour l'appliquer a une periode.
//
// ⚠ `stay_end` d'abord : un menage precede le sejour, l'avis peut tomber des
// semaines apres. `received_at` est un REPLI ASSUME — 136 des 168 avis reels
// n'ont pas de sejour resolu. Un avis recu avant la fin d'une periode concerne
// presque surement un sejour anterieur ; c'est une approximation, pas une
// verite. Quand l'import de l'historique des reservations resoudra les
// booking_uid, `stay_end` reprendra la main SANS reprise manuelle : l'attribution
// se recalcule a chaque affichage, elle n'est jamais figee en base.
function dateDeRattachement (avis) {
  const d = avis?.stay_end || avis?.received_at
  return d ? String(d).slice(0, 10) : null
}

function dansLaPeriode (dateAvis, periode) {
  if (!dateAvis) return false
  if (periode.debut && dateAvis < String(periode.debut).slice(0, 10)) return false
  if (periode.fin && dateAvis > String(periode.fin).slice(0, 10)) return false
  return true
}

/**
 * Identifiants des avis attribuables a une prestataire.
 *
 * @returns { ids: string[], parMenage: number, parPeriode: number, tronque: boolean }
 *          ou { erreur: true }
 */
async function avisDuPrestataire (sb, { userId, prestataireId, contexte = null } = {}) {
  const vide = { ids: [], parMenage: 0, parPeriode: 0, tronque: false }
  if (!userId || !prestataireId) return vide

  const retenus = new Map()   // id -> 'menage' | 'periode'

  // ─── Voie 1 : les menages precis ──────────────────────────────────────────
  // `menage_events` n'a pas encore de provider_id (chantier prestataires) : la
  // prestataire y est identifiee par son TOKEN. Un profil sans token — une
  // identite d'attribution historique — n'a donc aucun menage par cette voie,
  // et c'est correct : elle ne travaille plus.
  // ⚠ CONTEXTE REUTILISE, PAS RE-LU. `filtresAttribution` vient de resoudre le
  // profil et les periodes ; les relire ici doublait deux allers-retours base
  // par requete sur un endpoint ouvert sans session, qu'un porteur de lien peut
  // marteler en bouclant sur les quatre periodes. C'est l'invariant que garde le
  // test « l'attribution n'est resolue QU'UNE FOIS par requete ».
  let profil = contexte && contexte.profil
  if (!contexte) {
    const r = await sb.from('profiles')
      .select('id, pwa_token, account_user_id')
      .eq('id', prestataireId).eq('account_user_id', userId).maybeSingle()
    if (r.error) { console.error('[attribution] profil:', r.error.message); return { erreur: true } }
    profil = r.data
  }
  // ⚠ Le profil doit appartenir AU COMPTE : sans ce filtre, l'identifiant d'une
  // prestataire d'un autre hote rendrait ses menages (REVIEW.md regles 1 et 11).
  if (!profil) return vide

  if (profil.pwa_token) {
    // ⚠ `.eq('user_id', userId)` est ici de la defense en profondeur : une
    // mutation qui le retire ne fait echouer aucun test, parce que la lecture
    // des avis ci-dessous porte deja le filtre de compte et n'aurait aucune
    // ligne a rendre. On le garde — un token n'a aucune unicite garantie entre
    // comptes, et cette requete ne doit pas dependre de la suivante pour etre
    // correcte.
    // ⚠ ORDONNE, ET DU PLUS RECENT. Ces lectures sont PLAFONNEES : sans `order`,
    // PostgREST rend un echantillon arbitraire, qui peut changer d'un appel a
    // l'autre. Depuis que le COMPTEUR est exact et la LISTE plafonnee, les deux
    // peuvent se contredire a l'ecran : l'en-tete annonce 3 avis sur 15 jours et
    // la liste dit « aucune mention », parce que les 150 identifiants preleves
    // etaient les plus anciens. Prendre les plus recents aligne la liste sur ce
    // que la prestataire regarde.
    const { data: menages, error: errMen } = await sb.from('menage_events')
      .select('id').eq('user_id', userId).eq('token', profil.pwa_token)
      .order('created_at', { ascending: false }).limit(MAX_IDS + 1)
    if (errMen) { console.error('[attribution] menages:', errMen.message); return { erreur: true } }
    const liste = menages || []
    if (liste.length) {
      const { data: avis, error: errAvis } = await sb.from('ota_reviews')
        .select('id').eq('user_id', userId).eq('statut', 'confirme')
        .in('menage_event_id', liste.slice(0, MAX_IDS).map(m => m.id))
        .order('received_at', { ascending: false }).limit(MAX_IDS + 1)
      if (errAvis) { console.error('[attribution] avis par menage:', errAvis.message); return { erreur: true } }
      for (const a of (avis || [])) retenus.set(a.id, 'menage')
    }
  }

  // ─── Voie 2 : les periodes declarees ──────────────────────────────────────
  let periodes = contexte && contexte.periodes
  if (!contexte) {
    const r = await sb.from('prestataire_periodes')
      .select('property_id_ref, debut, fin')
      .eq('user_id', userId).eq('provider_id', prestataireId)
    if (r.error) { console.error('[attribution] periodes:', r.error.message); return { erreur: true } }
    periodes = r.data
  }

  let tronque = false
  for (const p of (periodes || [])) {
    const { data: avis, error } = await sb.from('ota_reviews')
      .select('id, stay_end, received_at')
      .eq('user_id', userId).eq('statut', 'confirme')
      .eq('property_id_ref', p.property_id_ref)
      .order('received_at', { ascending: false }).limit(MAX_IDS + 1)
    if (error) { console.error('[attribution] avis par periode:', error.message); return { erreur: true } }
    const liste = avis || []
    if (liste.length > MAX_IDS) tronque = true
    for (const a of liste.slice(0, MAX_IDS)) {
      // Un avis deja retenu par la voie 1 n'est pas compte deux fois : la Map
      // dedoublonne, et le menage precis prime sur la periode declaree.
      if (retenus.has(a.id)) continue
      if (dansLaPeriode(dateDeRattachement(a), p)) retenus.set(a.id, 'periode')
    }
  }

  // ⚠ BORNE GLOBALE, pas par periode. La voie 2 accumulait jusqu'a MAX_IDS par
  // periode : cinq biens suffisaient a depasser la barre d'URL que cette borne
  // existe precisement pour respecter. On tronque ici, et on le DIT.
  const toutes = [...retenus.keys()]
  const ids = toutes.slice(0, MAX_IDS)
  if (toutes.length > MAX_IDS) tronque = true
  let parMenage = 0, parPeriode = 0
  for (const v of retenus.values()) { if (v === 'menage') parMenage++; else parPeriode++ }
  return { ids, parMenage, parPeriode, tronque }
}


// ─── COMPTER SANS RAPATRIER — le ratio n'a pas besoin des identifiants ──────
//
// ⚠ LA BORNE `MAX_IDS` NE DOIT PLUS DECIDER DE LA VERITE D'UN COMPTEUR.
// `avisDuPrestataire` rend des IDS, et ces ids repartent en `.in('id', …)` dans
// une query string : d'ou la borne, qui est juste. Mais elle plafonnait AUSSI le
// ratio, qui n'a jamais eu besoin d'eux. Mesure du 14 septembre 2026 : Regina a
// 577 avis reellement attribuables, sa PWA en affichait 150 marques « tronques »,
// donc son en-tete restait masquee — 74 % de son travail invisible pour elle. Et
// le chiffre de 150 n'etait meme pas un sous-total : la borne s'appliquait DEUX
// fois (150 par periode, puis 150 au global), sur des lignes qu'aucun `order` ne
// fixait. Un compteur partiel, ca se dit ; un compteur arbitraire, non.
//
// La reponse n'est pas une borne plus haute — le commentaire de `MAX_IDS` le dit
// depuis toujours — c'est de compter COTE BASE, par des filtres. Ce qui suit ne
// rend pas des chiffres mais les FILTRES qui les produisent : `ratioProprete` les
// applique, une fois par verdict, en `head: true`. Aucun identifiant ne transite.
//
// ⚠ DEUX VOIES, ET IL NE FAUT COMPTER PERSONNE DEUX FOIS.
//   +  la voie 1 entiere (le menage precis) ;
//   +  chaque intervalle declare ;
//   -  leur intersection, sinon un avis qui releve des deux est compte deux fois.
// Les signes sont portes par les filtres eux-memes : l'appelant somme, il n'a
// aucune regle d'attribution a connaitre.

// Les intervalles d'un meme bien sont FUSIONNES avant tout comptage.
//
// ⚠ SANS CETTE FUSION, deux periodes qui se chevauchent sur le meme bien
// comptent deux fois les memes avis. `avisDuPrestataire` ne pouvait pas avoir ce
// defaut — sa `Map` dedoublonnait par id — mais un comptage par filtres, si.
// C'est le prix de ne plus rapatrier les lignes, et il se paie ici.
function fusionnerIntervalles (periodes) {
  const parBien = new Map()
  for (const p of (periodes || [])) {
    const ref = String(p.property_id_ref)
    if (!parBien.has(ref)) parBien.set(ref, [])
    parBien.get(ref).push({ debut: p.debut ? String(p.debut).slice(0, 10) : null,
                            fin: p.fin ? String(p.fin).slice(0, 10) : null })
  }
  for (const [ref, liste] of parBien) {
    // `null` en debut vaut -infini, `null` en fin vaut +infini.
    liste.sort((a, b) => (a.debut || '').localeCompare(b.debut || ''))
    const out = []
    for (const iv of liste) {
      const dernier = out[out.length - 1]
      // Se touchent-ils ? `dernier.fin === null` = ouvert a droite, il avale tout.
      const seTouchent = dernier &&
        (dernier.fin === null || iv.debut === null || iv.debut <= dernier.fin)
      if (!seTouchent) { out.push({ ...iv }); continue }
      if (dernier.fin !== null) {
        dernier.fin = (iv.fin === null) ? null
          : (iv.fin > dernier.fin ? iv.fin : dernier.fin)
      }
      if (iv.debut === null) dernier.debut = null
    }
    parBien.set(ref, out)
  }
  return parBien
}

// Le lendemain d'une date de calendrier, en UTC.
// ⚠ Pas de `new Date(x).setDate(+1)` en heure locale : a l'ouest de Greenwich,
// il rendrait le meme jour. C'est le piege deja corrige deux fois dans ce depot.
function lendemain (jour) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(jour))
  if (!m) return String(jour)
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + 1))
  return d.toISOString().slice(0, 10)
}

// La date de rattachement, ecrite en filtre PostgREST.
//
// ⚠ C'EST `coalesce(stay_end, received_at)`, et ca ne s'ecrit pas en `.gte()`.
// PostgREST ne connait pas `coalesce` : on l'exprime en deux branches — le
// sejour quand il est resolu, la reception sinon. Verifie en production : deux
// `.or()` chaines sont bien ET-es, ce qui permet de borner des deux cotes.
function bornerParDate (q, { debut, fin }) {
  // ⚠ LES DEUX COLONNES N'ONT PAS LE MEME TYPE, ET LA BORNE HAUTE EN DEPEND.
  // `stay_end` est un `date` : `lte fin` est exact.
  // `received_at` est un `timestamptz` : compare a une date nue, Postgres la
  // caste en `fin 00:00:00`. Un avis recu le dernier jour a 18 h etait donc
  // EXCLU du compteur — alors que `dansLaPeriode`, qui alimente la LISTE,
  // tronque a `slice(0,10)` et l'INCLUT. Le compteur et la liste se
  // contredisaient exactement sur le jour de bord, et comme 136 avis sur 168
  // n'ont pas de `stay_end`, c'est la branche dominante.
  // On borne donc la reception par `lt lendemain`, ce qui couvre la journee
  // entiere — les bornes de `prestataire_periodes` sont inclusives (migration
  // du 3 septembre).
  // ⚠ En UTC des deux cotes : `received_at` sort en ISO UTC de Supabase, et
  // c'est sur cette chaine que `dansLaPeriode` tronque. Les deux lectures
  // parlent du meme jour.
  if (fin) {
    q = q.or(`and(stay_end.not.is.null,stay_end.lte.${fin}),` +
             `and(stay_end.is.null,received_at.lt.${lendemain(fin)})`)
  }
  // La borne basse, elle, est symetrique : `>= debut` vaut `>= debut 00:00:00`,
  // qui inclut bien toute la journee du premier jour.
  if (debut) {
    q = q.or(`and(stay_end.not.is.null,stay_end.gte.${debut}),` +
             `and(stay_end.is.null,received_at.gte.${debut})`)
  }
  // ⚠ UN AVIS SANS AUCUNE DATE N'EST DANS AUCUNE PERIODE, meme non bornee.
  // `dansLaPeriode` rend `false` quand la date de rattachement est nulle ; sans
  // cette ligne, un intervalle ouvert des deux cotes l'aurait compte. Aucun cas
  // en base aujourd'hui (verifie) — c'est la divergence qu'on ferme, pas le
  // symptome.
  if (!fin && !debut) q = q.or('stay_end.not.is.null,received_at.not.is.null')
  return q
}

/**
 * Les filtres qui comptent les avis d'une prestataire, cote base.
 *
 * @returns { voies: [{ signe, select, appliquer }] } ou { erreur: true }
 *          `voies` peut etre vide : personne n'a d'avis, et c'est zero — pas
 *          une panne, pas « tous ».
 */
async function filtresAttribution (sb, { userId, prestataireId } = {}) {
  if (!userId || !prestataireId) return { voies: [], contexte: null }

  const { data: profil, error: errProfil } = await sb.from('profiles')
    .select('id, pwa_token, account_user_id')
    .eq('id', prestataireId).eq('account_user_id', userId).maybeSingle()
  if (errProfil) { console.error('[attribution] profil:', errProfil.message); return { erreur: true } }
  if (!profil) return { voies: [], contexte: { profil: null, periodes: [] } }

  const { data: periodes, error: errPer } = await sb.from('prestataire_periodes')
    .select('property_id_ref, debut, fin')
    .eq('user_id', userId).eq('provider_id', prestataireId)
  if (errPer) { console.error('[attribution] periodes:', errPer.message); return { erreur: true } }

  const voies = []
  const jeton = profil.pwa_token

  // ⚠ LA VOIE 1 A BESOIN DE LA RELATION `ota_reviews.menage_event_id ->
  // menage_events.id`, posee le 14 septembre 2026
  // (migrations/2026-09-14-ota-reviews-menage-event-fk.sql). Sans elle, PostgREST
  // n'expose pas l'embed et il fallait rapatrier les identifiants — c'est toute
  // l'origine de la borne.
  // ⚠ `user_id` DANS L'EMBED, PAS SEULEMENT LE JETON. L'ancienne voie 1 lisait
  // `menage_events` avec `.eq('user_id', userId)`, et son commentaire disait
  // pourquoi le garder : « un token n'a aucune unicite garantie entre comptes,
  // et cette requete ne doit pas dependre de la suivante pour etre correcte ».
  // Passer a l'embed avait perdu cette garde — seul `ota_reviews.user_id`
  // contraignait encore. C'est de la defense en profondeur, et elle se remet.
  // La colonne doit figurer dans le `select` pour etre filtrable.
  const surLeMenage = q => q.eq('menage_events.token', jeton)
                            .eq('menage_events.user_id', userId)
  const SELECT_MENAGE = 'id, menage_events!inner(token, user_id)'
  if (jeton) {
    voies.push({ signe: +1, select: SELECT_MENAGE, appliquer: surLeMenage })
  }

  // ⚠ LES INTERVALLES IDENTIQUES SE REGROUPENT, ET CA DIVISE LE NOMBRE D'APPELS.
  // Chaque voie coute QUATRE requetes (un comptage par verdict), et l'endpoint
  // en appelle jusqu'a deux series. Une voie par bien donnait, pour un hote a
  // cinq biens, 11 voies = 88 requetes PostgREST par chargement de PWA — sur un
  // endpoint ouvert sans session, « qu'un porteur de lien peut marteler ».
  // Or le cas courant est que TOUS les biens d'une prestataire partagent les
  // memes bornes (souvent aucune) : un seul `.in('property_id_ref', refs)` les
  // couvre alors, avec exactement la meme semantique. Regina passe de 5 voies a
  // 3, l'hote a cinq biens de 11 a 3.
  // ⚠ Ce n'est PAS un raccourci de calcul : le regroupement ne touche que la
  // forme de la requete. Des bornes differentes restent des voies differentes.
  const parBornes = new Map()
  for (const [ref, intervalles] of fusionnerIntervalles(periodes)) {
    for (const iv of intervalles) {
      const cle = `${iv.debut || ''}|${iv.fin || ''}`
      if (!parBornes.has(cle)) parBornes.set(cle, { iv, refs: [] })
      parBornes.get(cle).refs.push(ref)
    }
  }
  for (const { iv, refs } of parBornes.values()) {
    // ⚠ LA LISTE DE REFS RETOURNE EN QUERY STRING, comme les ids : on la
    // tronconne. C'est la meme contrainte de 8 Ko qui a donne `MAX_IDS`, et
    // l'oublier ici aurait recree le defaut qu'on vient de fermer, un cran plus
    // loin. Un hote a plus de 100 biens produit plusieurs voies : c'est correct,
    // les lots sont disjoints.
    for (let i = 0; i < refs.length; i += LOT_REFS) {
      const lot = refs.slice(i, i + LOT_REFS)
      const surLaPeriode = q => bornerParDate(q.in('property_id_ref', lot), iv)
      voies.push({ signe: +1, select: 'id', appliquer: surLaPeriode })
      // L'intersection, retiree. Un avis dont le menage est precisement le sien
      // ET qui tombe dans une periode declaree ne compte qu'une fois.
      if (jeton) {
        voies.push({ signe: -1, select: SELECT_MENAGE,
                     appliquer: q => surLeMenage(surLaPeriode(q)) })
      }
    }
  }
  // ⚠ LE CONTEXTE SORT AVEC LES FILTRES. `avisDuPrestataire` a besoin des memes
  // deux lectures pour composer la LISTE : les lui faire refaire doublerait le
  // cout d'une requete qui en fait deja huit.
  return { voies, contexte: { profil, periodes } }
}

module.exports = { avisDuPrestataire, filtresAttribution, fusionnerIntervalles,
                   dateDeRattachement, dansLaPeriode, MAX_IDS }
