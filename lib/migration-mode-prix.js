// lib/migration-mode-prix.js
// ETAPE « qui gere les prix » — assistant de migration.
// Spec : docs/specs/spec-assistant-migration.md
//
// ⚠ POURQUOI CETTE ETAPE EXISTE, ALORS QUE LE REGLAGE EXISTAIT DEJA.
// `api/channel-property.js` sait changer `rate_sync_mode`, mais il le refuse a
// tout bien qui n'est pas deja chez le canal : « Le mode de prix ne s'applique
// qu'aux biens connectes aux plateformes ». Un bien en cours de migration est
// precisement dans l'angle mort — encore chez son ancien provider, deja pourvu
// d'une propriete cible. Sans cette etape, le seul moyen de le regler serait
// d'ecrire en base a la main : le chemin de faveur que la spec interdit, et sur
// lequel le prochain hote migre buterait a son tour.
//
// ⚠ CE QUE CE GESTE ENGAGE, ET POURQUOI IL SE MONTRE AVANT DE SE FAIRE.
// « HoteSmart gere mes prix » veut dire que les tarifs du coeur partiront vers
// les plateformes. L'hote doit voir AVANT : combien de nuits sont tarifees,
// combien partiraient fermees faute de prix, et — le point qui coute cher —
// quelles nuits DEJA VENDUES partiraient annoncees comme disponibles.

const { estEnMigration } = require('./rate-sync')
const { nuitsOccupees } = require('./nuits-occupees')
const { pousserAri, lignesDuCoeur } = require('./migration-ari')
const { JOURS_POUSSES } = require('./channel-fullsync')

const MODES = ['keep', 'managed']
const LIBELLE = { keep: 'Je garde mes prix', managed: 'HoteSmart gere mes prix' }

function raisonDeNePasChanger (bien, mode) {
  if (!bien) return { raison: 'bien_inconnu', message: 'Bien introuvable.' }
  if (!MODES.includes(mode)) {
    return { raison: 'mode_invalide', message: `Mode inconnu. Valeurs possibles : ${MODES.join(', ')}.` }
  }
  // Hors migration, le reglage a deja son endroit : les reglages du bien.
  // Deux portes vers la meme colonne finiraient par se contredire.
  if (!estEnMigration(bien)) {
    return { raison: 'pas_en_migration',
      message: 'Ce logement n\'est pas en cours de migration : son mode de prix se regle '
        + 'dans les reglages du bien, pas ici.' }
  }
  if (bien.rate_sync_mode === mode) {
    return { raison: 'deja_dans_ce_mode', message: `Ce logement est deja en « ${LIBELLE[mode]} ».` }
  }
  return null
}

// Ce que le geste produira, montre AVANT de le faire.
async function apercuDuMode (supabase, bien, mode, { appel = null } = {}) {
  const apercu = {
    mode_actuel: bien.rate_sync_mode,
    mode_demande: mode,
    effet: mode === 'managed'
      ? 'Les prix du coeur partiront vers les plateformes a chaque poussee.'
      : 'Plus aucun tarif ne partira : les prix restent ceux que vous gerez chez les plateformes.'
  }

  // Passer en « je garde mes prix » n'envoie rien : rien a montrer de plus.
  if (mode !== 'managed') return apercu

  // Ce qui partirait : le calcul REEL de la poussee, en apercu (aucun appel
  // d'ecriture). Meme source que l'etape « pousser l'ARI » — pas une estimation.
  let p
  // Une lecture qui echoue n'a pas a bloquer l'ecriture d'UNE colonne, qui ne
  // depend pas de l'apercu. On dit ce qu'on n'a pas pu montrer, et on continue.
  try { p = await pousserAri(bien, { dryRun: true, appel }) }
  catch (e) { p = { ok: false, raison: 'apercu_indisponible', message: e.message } }
  if (p.ok) {
    apercu.ce_qui_partirait = {
      dates_tarifees: p.resultat.dates_tarifees,
      dates_fermees_faute_de_prix: p.resultat.dates_fermees_faute_de_prix,
      premiere_fermee: p.resultat.premiere_fermee,
      derniere_fermee: p.resultat.derniere_fermee,
      canaux_sur_la_cible: p.canaux_sur_la_cible
    }
  } else {
    apercu.ce_qui_partirait = { indisponible: p.raison, message: p.message }
  }

  // ⚠ LE POINT QUI COUTE CHER : les nuits DEJA VENDUES qui partiraient ouvertes.
  // `calendar_inventory.avail` vaut `NULL` sur les biens amorces, et la poussee
  // traduit `NULL` par « disponible ». Tant que le stock n'est pas CALCULE
  // (chantier audit stop_sell), une nuit vendue peut etre remise en vente des
  // qu'un canal existe. On ne bloque pas le reglage — il n'envoie rien par
  // lui-meme — mais on refuse de le laisser signer a l'aveugle.
  //
  // ⚠ ON REPRODUIT LA REGLE DE LA POUSSEE, PAS UNE APPROXIMATION.
  //   `availability` = ligne presente ET `avail` different de 0 (NULL vaut 1) ;
  //   vendable        = un prix existe, par date OU par `base_price`.
  // Ne regarder que les dates tarifees a l'unite manquait le bien qui n'a qu'un
  // prix de base — ou TOUTES les nuits vendues seraient reparties ouvertes — et
  // criait a tort sur une nuit que l'hote avait deja mise a `avail = 0`.
  //
  // Et sur la fenetre REELLEMENT poussee : en inspecter moins, c'est promettre
  // sur ce qu'on n'a pas regarde.
  const lu = await lignesDuCoeur(supabase, bien, JOURS_POUSSES)
  if (lu.error) {
    apercu.nuits_vendues = { lu: false, detail: lu.error }
    return apercu
  }
  const base = Number(bien.base_price) > 0
  // ⚠ `NULL` VAUT 1, PAS 0 — c'est la regle exacte de `runFullSync` :
  //   `availability = ligne ? (avail != null ? avail : 1) : 0`.
  // Ecrire `Number(l.avail) !== 0` la trahissait : `Number(null)` vaut 0, donc
  // toute ligne non renseignee — c'est-a-dire TOUTES celles des biens amorces —
  // passait pour fermee, et l'avertissement se taisait sur le cas meme qu'il
  // doit couvrir.
  const partiraitOuverte = (l) => (l.avail == null || Number(l.avail) !== 0)
    && (Number(l.rate) > 0 || base)
  const ouvertes = lu.lignes.filter(partiraitOuverte)
  if (!ouvertes.length) {
    apercu.nuits_vendues = { lu: true, total: 0, dates: [] }
    return apercu
  }
  let occ
  try {
    occ = await nuitsOccupees(supabase, bien.provider_property_id,
      ouvertes[0].date, ouvertes[ouvertes.length - 1].date)
  } catch (e) {
    apercu.nuits_vendues = { lu: false, detail: e.message }
    return apercu
  }
  const vendues = ouvertes.filter(n => occ[n.date] && occ[n.date].length)
  apercu.nuits_vendues = {
    lu: true,
    total: vendues.length,
    dates: vendues.map(n => n.date),
    avertissement: vendues.length
      ? `${vendues.length} nuit(s) tarifee(s) sont DEJA VENDUES et partiraient annoncees `
        + 'DISPONIBLES : le stock n\'est pas encore calcule dans le coeur. Sans consequence '
        + 'tant qu\'aucun canal n\'existe sur la propriete cible ; a regler avant d\'en activer un.'
      : null
  }
  return apercu
}

// Le geste. `dryRun` par defaut, comme toute action de l'assistant.
async function changerModeDePrix (supabase, bien, mode, { dryRun = true, appel = null } = {}) {
  const refus = raisonDeNePasChanger(bien, mode)
  if (refus) return { ok: false, ...refus }

  const apercu = await apercuDuMode(supabase, bien, mode, { appel })
  if (dryRun) {
    return { ok: true, dry_run: true, bien: { id: bien.id, nom: bien.name }, apercu,
      note: 'Rien n\'a ete change. Ce reglage n\'envoie rien par lui-meme : il autorise '
        + 'la poussee des prix, il ne la declenche pas.' }
  }

  // ⚠ UNE SEULE COLONNE. Cette etape ne touche ni le provider, ni les
  // identifiants, ni le calendrier.
  const { error } = await supabase.from('properties')
    .update({ rate_sync_mode: mode }).eq('id', bien.id)
  if (error) return { ok: false, raison: 'ecriture_base', message: `Enregistrement impossible : ${error.message}` }

  return { ok: true, dry_run: false, bien: { id: bien.id, nom: bien.name },
    mode_actuel: mode, apercu,
    note: `Ce logement est desormais en « ${LIBELLE[mode]} ». Aucune poussee n'a ete `
      + 'declenchee : l\'etape « prix et disponibilites chez le nouveau provider » reste un geste a part.' }
}

// L'etat de l'etape, pour l'assistant.
function etatModeDePrix (bien) {
  if (!estEnMigration(bien)) {
    return { etat: 'sans_objet',
      message: 'Ce logement n\'est pas en cours de migration : son mode de prix se regle dans les reglages du bien.' }
  }
  if (bien.rate_sync_mode === 'managed') {
    return { etat: 'fait', action: 'mode_de_prix',
      message: '« HoteSmart gere mes prix » : les tarifs du coeur peuvent partir vers les plateformes.' }
  }
  return { etat: 'a_faire', action: 'mode_de_prix',
    message: '« Je garde mes prix » : aucun tarif ne partira. Apres la bascule, l\'ancien provider '
      + 'ne poussera plus rien non plus — ce logement ne serait alors vendable nulle part.' }
}

module.exports = { changerModeDePrix, apercuDuMode, etatModeDePrix, raisonDeNePasChanger, MODES, LIBELLE }
