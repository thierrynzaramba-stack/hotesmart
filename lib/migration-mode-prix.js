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
// combien partiraient fermees faute de prix, et ce que deviennent les nuits
// deja vendues.
//
// ⚠ TOUT CE QU'IL MONTRE EST LU DU CALCUL REEL DE LA POUSSEE, jamais refait
// ici. Une seconde copie de la regle finit par annoncer autre chose que ce qui
// part — c'est arrive sur ce meme bloc, le temps d'un commit.

const { estEnMigration } = require('./rate-sync')
const { pousserAri } = require('./migration-ari')

const MODES = ['keep', 'managed']
// ⚠ LE LIBELLE DIT CE QUI EST, PLUS CE QUE L'HOTE CHOISIT. « Je garde mes
// prix » promettait quelque chose que l'OTA interdit : des qu'un channel
// manager est lie, l'extranet REFUSE que l'hote edite ses tarifs
// (« modification obligatoire par le CM », constat du 11 septembre 2026). Le
// mode ne decrit donc pas une preference, mais un ETAT TRANSITOIRE de la
// bascule — les prix vivent encore chez l'ancien channel manager.
const LIBELLE = {
  keep: 'Prix encore gérés par votre ancien channel manager',
  managed: 'HôteSmart gère mes prix'
}
// La consequence, jamais separee du libelle : un mode qui n'envoie aucun prix
// doit le dire, sinon l'hote tarife dans le vide — c'est exactement ce qui est
// arrive sur un bien reel, 31 nuits vendues au prix de provisionnement.
const CONSEQUENCE = {
  keep: 'HôteSmart n\'enverra aucun prix tant que ce mode est actif.',
  managed: 'Les tarifs de votre calendrier HôteSmart sont envoyés aux plateformes.'
}

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
// `supabase` n'est plus dans la signature : toutes les lectures sont passees
// dans `pousserAri`, qui les fait par le writer. Un parametre mort finit par
// laisser croire qu'il sert.
async function apercuDuMode (bien, mode, { appel = null } = {}) {
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

  // ⚠ CE QUE DEVIENNENT LES NUITS DEJA VENDUES — LU, PAS RECALCULE.
  // Le writer ferme desormais leur stock (`availability = unites − vendues`,
  // lib/channel-fullsync.js). Refaire ici le compte a la main aurait recree la
  // double copie de regle que `lib/nuits-occupees.js` a ete cree pour supprimer
  // — et, le temps d'un commit, l'apercu a effectivement annonce le contraire de
  // ce que la poussee faisait. On lit donc ce que la poussee dit d'elle-meme.
  const r = p.ok ? p.resultat : null
  apercu.nuits_vendues = r
    ? {
        lu: true,
        total: r.nuits_vendues_fermees || 0,
        dates: r.dates_vendues || [],
        note: (r.nuits_vendues_fermees || 0)
          ? `${r.nuits_vendues_fermees} nuit(s) sont deja vendues : elles partiront FERMEES `
            + '(stock calcule a la poussee). Aucune ne sera remise en vente.'
          : null
      }
    : { lu: false, detail: p.message }

  return apercu
}

// Le geste. `dryRun` par defaut, comme toute action de l'assistant.
async function changerModeDePrix (supabase, bien, mode, { dryRun = true, appel = null } = {}) {
  const refus = raisonDeNePasChanger(bien, mode)
  if (refus) return { ok: false, ...refus }

  const apercu = await apercuDuMode(bien, mode, { appel })
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
      message: `« ${LIBELLE.managed} » : ${CONSEQUENCE.managed}` }
  }
  return { etat: 'a_faire', action: 'mode_de_prix',
    message: `« ${LIBELLE.keep} » : ${CONSEQUENCE.keep} Apres la bascule, l'ancien channel manager `
      + 'ne poussera plus rien non plus — ce logement ne serait alors vendable nulle part.' }
}

module.exports = {
  CONSEQUENCE, changerModeDePrix, apercuDuMode, etatModeDePrix, raisonDeNePasChanger, MODES, LIBELLE }
