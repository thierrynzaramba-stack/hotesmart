// lib/logement/archive.js — ARCHIVER UN BIEN, et le ranimer.
//
// Lot « archiver un bien », etapes 0 a 4. Go de Thierry du 31 octobre 2026.
//
// ⚠ POURQUOI UN MODULE ET PAS UN ENDPOINT. Le geste touche quatre tables et
// doit rendre compte de CE QU'IL A FAIT, y compris quand une partie echoue.
// Ecrit dans un `api/`, il ne se testerait qu'a travers HTTP ; ici il s'eprouve
// directement, et c'est ce qui permet de prouver par mutation que chaque
// coupure mord.
//
// ⚠ L'ORDRE N'EST PAS ARBITRAIRE. Le drapeau d'archive est pose EN PREMIER,
// parce que c'est lui qui sort le bien des boucles : si le menage de ce qui
// reste en vol echoue, le bien est deja hors des crons, et le compte rendu dit
// ce qui n'a pas abouti. L'inverse — nettoyer d'abord — laisserait le cron
// recreer en vol ce qu'on vient de clore.
//
// ⚠ ET RIEN N'EST SUPPRIME. `supprimer_bien_vide` existe deja et REFUSERAIT
// pour le premier cas reel (26 reservations, 106 conversations, 23 menages,
// 42 taches IA). Cet historique est vrai : il a ete encaisse, nettoye,
// repondu. Un bien archive sort des boucles ; il ne sort pas du passe.

// L'etat terminal des taches IA closes par un archivage. ⚠ UN ETAT A LUI, PAS
// `ignored` : « ignore » dit que l'hote a ecarte la proposition, ce qui serait
// faux. Et il est SANS RISQUE pour les ecrans, mesure avant de le choisir :
// `api/ecran/aujourdhui.js` compte « A valider » par LISTE BLANCHE
// (`in('status', ['pending', 'pending_validation'])`), donc un etat neuf en
// sort sans qu'une ligne change.
const STATUT_TACHE_ARCHIVEE = 'archived'

/** La borne de la lecture des sejours a venir. */
const LOT_SEJOURS = 1000

const { isActiveStatus } = require('../bookings-snapshot-status')

// Les etats de tache qui attendent encore quelque chose de l'hote.
const TACHES_EN_VOL = ['pending', 'pending_validation']

/** La cle du marqueur d'anteriorite de l'import des messages. */
const marqueurImport = (userId, propId) => `messages_import:${userId}:${propId}`

/**
 * Archive un bien : l'historique reste, les boucles s'arretent.
 *
 * @param {object} sb client Supabase (cle de service)
 * @param {object} o
 * @param {string} o.bienId        UUID du bien (resolu par la garde)
 * @param {string} o.compte        `user_id` du compte proprietaire
 * @param {string} o.parQui        `auth.users.id` de qui archive
 * @param {string} [o.motif]       pourquoi — libre, et il sert a la reprise
 * @param {string} [o.maintenant]  instant ISO, injecte par les tests
 * @returns {Promise<object>} compte rendu : ce qui a ete fait, et ce qui a rate
 */
async function archiver (sb, { bienId, compte, parQui, motif = null, maintenant = null } = {}) {
  const t = maintenant || new Date().toISOString()
  if (!bienId || !compte) return { ok: false, motif_refus: 'bien_ou_compte_absent' }

  // ⚠ ON RELIT LE BIEN DANS SON COMPTE. La garde a deja resolu l'UUID, mais
  // c'est ici qu'on a besoin de `provider_property_id` (la cle des tables
  // enfant) et de `active_at` (la facturation) — et un `select` qui omet une
  // colonne dont on juge ensuite est une garde ouverte.
  const { data: bien, error: eLire } = await sb
    .from('properties')
    .select('id, user_id, name, provider_property_id, active_at, archive_le, facturable_jusqu_au, pilote_tarifaire')
    .eq('id', bienId)
    .eq('user_id', compte)
    .maybeSingle()
  if (eLire) return { ok: false, motif_refus: 'lecture_impossible', detail: eLire.message }
  if (!bien) return { ok: false, motif_refus: 'bien_introuvable' }
  // Idempotent : rearchiver n'est pas une erreur, et ca ne redate rien.
  if (bien.archive_le) {
    return { ok: true, deja_archive: true, archive_le: bien.archive_le, bien: bien.name }
  }

  // ─── 1. LE DRAPEAU, D'ABORD ───────────────────────────────────────────────
  //
  // ⚠ `active_at` N'EST PAS EFFACE (decision de Thierry). C'est ce que fait
  // `transferer_bien`, et ca EFFACE le fait que le bien a ete actif : le trial
  // du compte demarre au PREMIER `active_at`, donc l'effacer reecrit une date
  // de debut. On pose une FIN, et l'historique reste lisible.
  const champs = { archive_le: t, archive_par: parQui || null, archive_motif: motif }
  if (bien.active_at && !bien.facturable_jusqu_au) champs.facturable_jusqu_au = t
  // ⚠ LE PILOTE TARIFAIRE S'ETEINT (decision de Thierry du 1er novembre 2026,
  // les DEUX cotes). Sans cela, YieldFlow continuerait de pousser des prix chez
  // le provider pour une annonce retiree. Le filtre de
  // `scripts/piloter-yieldflow.js` est la seconde ligne ; celle-ci dit
  // l'INTENTION dans la donnee, et c'est elle que l'ecran lit.
  // ⚠ ET LA REACTIVATION NE LE RALLUME PAS : remettre un bien en vente est un
  // geste de l'hote, remettre un moteur de prix en marche en est un autre. Les
  // confondre rouvrirait des nuits a des prix calcules pendant l'archivage.
  if (bien.pilote_tarifaire === 'yieldflow') {
    champs.pilote_tarifaire = 'calendrier'
    // ⚠ ET LA FENETRE PART AVEC LUI (constat 9 de la revue de 320aa4f8). Toute
    // desactivation par `api/yield-pilote.js` remet ces deux colonnes a `null` ;
    // ne pas le faire ici laissait un bien archive avec une fenetre configuree
    // et un pilote eteint. Si `pilote_tarifaire` etait repose a `yieldflow` — a
    // la main, ou par un chemin futur —, la fenetre d'AVANT l'archivage
    // s'appliquerait sans que personne l'ait choisie.
    champs.pilote_fenetre_type = null
    champs.pilote_fenetre_valeur = null
  }
  const { error: eMaj } = await sb.from('properties').update(champs).eq('id', bien.id).eq('user_id', compte)
  if (eMaj) return { ok: false, motif_refus: 'archive_refusee', detail: eMaj.message }

  // ─── 2. CE QUI RESTE EN VOL ───────────────────────────────────────────────
  //
  // ⚠ CHAQUE COUPURE A SON PROPRE `try`. C'est la lecon du 10 septembre 2026 :
  // une erreur dans le premier appel d'un `try` commun a emporte les codes
  // d'acces pendant 24 h. Ici, un marqueur d'import qui refuse de partir ne
  // doit pas laisser 35 taches IA dans « A valider ».
  const fait = { taches_closes: null, marqueur_retire: null }
  const rates = []

  const cle = bien.provider_property_id != null && String(bien.provider_property_id).trim() !== ''
    ? String(bien.provider_property_id)
    : null

  if (cle) {
    try {
      const { data, error } = await sb.from('agent_tasks')
        .update({ status: STATUT_TACHE_ARCHIVEE, updated_at: t })
        .eq('user_id', compte).eq('property_id', cle).in('status', TACHES_EN_VOL)
        .select('id')
      if (error) throw new Error(error.message)
      fait.taches_closes = (data || []).length
    } catch (e) { rates.push({ quoi: 'taches_ia', detail: e.message }) }

    // ⚠ LE MARQUEUR D'IMPORT EST RETIRE DE LA FILE, et c'est le defaut mesure
    // le 30 octobre 2026 : `ordonnerPourImport` met « jamais importe (`null`)
    // d'abord », donc un bien dont le marqueur reste a `null` passe EN TETE a
    // chaque cycle, avant les biens vivants. Le filtre de l'etape 1 l'ecarte
    // deja de la selection ; retirer le marqueur evite qu'il revienne en tete
    // le jour d'une reactivation, avec une anteriorite de trois mois.
    try {
      const { error } = await sb.from('cron_logs').delete().eq('id', marqueurImport(compte, cle))
      if (error) throw new Error(error.message)
      fait.marqueur_retire = true
    } catch (e) { rates.push({ quoi: 'marqueur_import', detail: e.message }) }
  }

  return {
    ok: true,
    bien: bien.name,
    archive_le: t,
    facturation_arretee_le: champs.facturable_jusqu_au || null,
    etait_facture: Boolean(bien.active_at),
    pilote_eteint: champs.pilote_tarifaire === 'calendrier',
    ...fait,
    // ⚠ UN ECHEC PARTIEL SE DIT. Le bien EST archive — donc hors des boucles —
    // mais l'appelant doit savoir ce qui n'a pas ete nettoye, pour le refaire
    // ou le signaler. Rendre `ok: true` en taisant les rates serait le « faux
    // vert » que ce depot paye depuis deux mois.
    rates: rates.length ? rates : null
  }
}

/**
 * Ranime un bien archive. ⚠ NE REOUVRE PAS LE PASSE : les taches IA closes par
 * l'archivage restent closes. Elles portaient des messages voyageurs d'il y a
 * des mois ; les rendre a « A valider » demanderait a l'hote de repondre a des
 * conversations terminees.
 */
async function reactiver (sb, { bienId, compte, maintenant = null } = {}) {
  if (!bienId || !compte) return { ok: false, motif_refus: 'bien_ou_compte_absent' }
  const { data: bien, error: eLire } = await sb
    .from('properties')
    .select('id, name, archive_le, active_at, facturable_jusqu_au')
    .eq('id', bienId).eq('user_id', compte).maybeSingle()
  if (eLire) return { ok: false, motif_refus: 'lecture_impossible', detail: eLire.message }
  if (!bien) return { ok: false, motif_refus: 'bien_introuvable' }
  if (!bien.archive_le) return { ok: true, deja_vivant: true, bien: bien.name }

  // ⚠ LA FIN DE FACTURATION PART AVEC L'ARCHIVE. Sans cela, un bien ranime
  // resterait hors de la quantite facturee : il serait exploite sans etre
  // facture, ce qui est un defaut dans l'autre sens.
  const { error } = await sb.from('properties')
    .update({ archive_le: null, archive_par: null, archive_motif: null, facturable_jusqu_au: null })
    .eq('id', bien.id).eq('user_id', compte)
  if (error) return { ok: false, motif_refus: 'reactivation_refusee', detail: error.message }

  return {
    ok: true,
    bien: bien.name,
    reactive_le: maintenant || new Date().toISOString(),
    etait_archive_depuis: bien.archive_le,
    refacturable: Boolean(bien.active_at)
  }
}

/**
 * Ce que l'archivage va faire, AVANT de le faire : la confirmation.
 *
 * ⚠ DECISION DE THIERRY DU 1er NOVEMBRE 2026, OPTION 2 : l'archivage est
 * AUTORISE avec des sejours a venir, et il l'annonce — « N sejours a venir :
 * leurs codes d'acces continueront de fonctionner ». Refuser bloquerait le cas
 * reel (« le provider a supprime l'annonce, les sejours sont perdus de toute
 * facon »), et ne rien dire laisserait l'hote croire que TOUT est coupe.
 *
 * ⚠ ET LES CODES D'ACCES NE SONT PAS COUPES. `refreshAccessCode` n'est pas
 * filtre, volontairement : couper le rafraichissement d'un code pour un sejour
 * reel laisserait un voyageur devant une porte, sans rejeu possible — c'est un
 * incident que ce depot a deja paye (10 septembre 2026, 24 h sans code). Ce que
 * l'archivage arrete, c'est la CREATION de nouveaux codes, parce qu'elle part
 * de `cron-channel-props`, qui est filtre.
 *
 * ⚠ CETTE FONCTION N'ECRIT RIEN. Elle est lue par un GET.
 */
async function compterAvantArchivage (sb, { bienId, compte, aujourdHui = null } = {}) {
  const auj = aujourdHui || new Date().toISOString().slice(0, 10)
  // ⚠ `null`, PAS `0` (constat 4 de la revue de 320aa4f8). Un zero affirme
  // « aucun sejour a venir » ; `listeDArchivage` n'affiche rien pour un zero,
  // donc la confirmation se taisait sur le seul chiffre de cette fenetre qui
  // engage un CODE D'ACCES. C'est le meme piege que `Number(null) === 0`, deja
  // paye dans ce lot, par l'autre bout.
  const vide = {
    deja_archive: null, sejours_a_venir: null, taches_en_vol: null,
    pilote_actif: null, etait_facture: null, annonce_en_ligne: null, canaux: []
  }
  if (!bienId || !compte) return vide

  const { data: bien, error } = await sb
    .from('properties')
    .select('id, provider, provider_property_id, active_at, pilote_tarifaire, archive_le, '
      + 'channel_ready, ota_listing_urls')
    .eq('id', bienId).eq('user_id', compte).maybeSingle()
  if (error || !bien) return vide

  // ⚠ L'ANNONCE EST-ELLE ENCORE EN LIGNE ? Decision de Thierry du 1er novembre
  // 2026 sur la dette 126 : ni ecriture chez le provider, ni refus — un
  // AVERTISSEMENT, et l'hote archive quand meme. Le cas qu'il couvre : un bien
  // archive mais encore en vente chez l'OTA recevrait une reservation sans code
  // d'acces ni menage, parce que l'archivage coupe ces deux chemins.
  // ⚠ LE SIGNAL EST `channel_ready`, ET C'EST UNE MESURE QUI L'A CHOISI. En
  // production (lecture seule du 1er novembre 2026), `ota_listing_urls` est
  // `null` sur les CINQ biens et `ota_connect_status` vaut `draft` partout :
  // fonder l'avertissement sur eux l'aurait rendu muet. `channel_ready` est
  // vrai sur trois biens, dont les deux a archiver.
  // ⚠ ET ON NE NOMME LE CANAL QUE SI ON LE CONNAIT. Le nom du partenaire
  // TECHNIQUE ne sort jamais a l'ecran (regle du 21 octobre 2026) : sans canal
  // de vente nomme, la phrase parle du « gestionnaire de canaux », pas de lui.
  const annonces = bien.ota_listing_urls && typeof bien.ota_listing_urls === 'object'
    ? Object.keys(bien.ota_listing_urls).filter(k => bien.ota_listing_urls[k])
    : []
  const out = {
    deja_archive: Boolean(bien.archive_le),
    pilote_actif: bien.pilote_tarifaire === 'yieldflow',
    etait_facture: Boolean(bien.active_at),
    annonce_en_ligne: Boolean(bien.channel_ready) || annonces.length > 0,
    // Les cles OTA brutes : c'est l'ECRAN qui les nomme, comme partout ailleurs.
    canaux: annonces,
    // ⚠ `null` TANT QU'ON N'A PAS COMPTE. Une valeur posee a 0 ici serait
    // indistinguable d'un compte reel a zero si la lecture echouait ensuite.
    sejours_a_venir: null,
    taches_en_vol: null
  }
  const cle = bien.provider_property_id != null && String(bien.provider_property_id).trim() !== ''
    ? String(bien.provider_property_id)
    : null
  // ⚠ LES SEJOURS A VENIR SE COMPTENT SUR LE DEPART, PAS L'ARRIVEE : un sejour
  // commence hier et qui finit demain est « a venir » pour un code d'acces.
  //
  // ⚠ ET PAS SUR LES COLONNES DERIVEES — constat 3 de la revue de 320aa4f8.
  // Une premiere version filtrait `property_uuid` et `statut_canonique`, tous
  // deux ECRITS PAR LE CRON DE DERIVATION (04:00, plafond 2 000 lignes) : tant
  // qu'une ligne n'est pas derivee, les deux valent NULL. `.eq('property_uuid')`
  // l'ecartait, et `.neq('statut_canonique', 'cancelled')` aussi — car
  // `NULL <> 'cancelled'` rend NULL, pas vrai. Scenario : un voyageur reserve
  // aujourd'hui, l'hote archive le bien dans la journee, et la confirmation ne
  // mentionne AUCUN sejour a venir — donc aucun mot sur les codes d'acces.
  // C'est le « constat GRAVE 1 » deja grave dans
  // `migrations/2026-10-26-revenus-calcul-incomplet.sql`.
  //
  // On lit donc la cle PROVIDER et le statut DANS le snapshot, comme le reste du
  // depot le fait (`isActiveStatus`). Le filtre de date reste en SQL — il porte
  // sur le JSON, dont `departure` est une date nue « YYYY-MM-DD », donc la
  // comparaison textuelle est exacte et ordonnee.
  if (cle) {
    try {
      const { data, error: e } = await sb.from('bookings_snapshot')
        // ⚠ `snapshot` SEUL, ET LE PROVIDER VIENT DU BIEN. Defaut BLOQUANT
        // trouve par Thierry en recette de staging le 2 novembre 2026 :
        // `sejours_a_venir` valait `null` sur TOUS les biens, y compris un bien
        // SANS AUCUNE reservation, et l'ecran disait « nous n'avons pas pu
        // compter ».
        // ⚠ LA CAUSE : `bookings_snapshot.provider` N'EXISTE PAS. La table porte
        // `canal` (le canal de VENTE), pas le provider. Le select echouait donc
        // en 42703 — PostgREST refuse la requete ENTIERE pour une colonne
        // inconnue —, `e` etait truthy, et le compte restait a `null`.
        // Verifie contre la production : `select=snapshot,provider` rend 400
        // « column bookings_snapshot.provider does not exist », `select=snapshot`
        // rend 200.
        // ⚠ ET C'EST UNE AFFIRMATION DE LA REVUE QUE J'AI APPLIQUEE SANS LA
        // VERIFIER (« `bookings_snapshot` porte une colonne `provider` : il
        // suffit de la selectionner »). Le provider du bien vit dans
        // `properties.provider` — c'est de la que `sync-menages-entite` le lit,
        // par `providerParBien`.
        .select('snapshot')
        .eq('user_id', compte)
        .eq('property_id', cle)
        .gte('snapshot->>departure', auj)
        // ⚠ BORNE EXPLICITE : PostgREST tronque a 1000 SANS erreur. Un compte
        // tronque dirait moins de sejours qu'il n'y en a, et la confirmation
        // promettrait moins de codes d'acces qu'elle ne doit.
        .limit(LOT_SEJOURS)
      if (!e) {
        const lignes = data || []
        // Une lecture tronquee ne se compte pas : elle reste « on ne sait pas ».
        if (lignes.length < LOT_SEJOURS) {
          out.sejours_a_venir = lignes.filter(l => isActiveStatus(l.snapshot, bien.provider || null)).length
        }
      }
      // ⚠ UNE LECTURE RATEE SE JOURNALISE. Sans cette ligne, le defaut du
      // 2 novembre 2026 etait INVISIBLE cote serveur : l'ecran disait « nous
      // n'avons pas pu compter » et rien n'expliquait pourquoi. Un `null` qui
      // ne dit pas sa cause coute une recette.
      if (e) console.error('[archive] comptage des sejours a venir echec :', e.message)
    } catch (e) {
      // reste `null` : la confirmation dira « nous n'avons pas pu compter »
      console.error('[archive] comptage des sejours a venir leve :', e.message)
    }
  } else {
    // Pas de cle provider : aucun sejour ne peut exister. C'est un RESULTAT.
    out.sejours_a_venir = 0
  }

  if (cle) {
    try {
      const { count, error: e } = await sb.from('agent_tasks')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', compte).eq('property_id', cle).in('status', TACHES_EN_VOL)
      if (!e) out.taches_en_vol = Number(count) || 0
    } catch { /* reste `null`, meme raison */ }
  } else {
    // Pas de cle provider : il n'y a pas de tache a compter, et c'est un
    // RESULTAT — zero, pas « on ne sait pas ».
    out.taches_en_vol = 0
  }
  return out
}

module.exports = {
  archiver, reactiver, compterAvantArchivage,
  STATUT_TACHE_ARCHIVEE, TACHES_EN_VOL, marqueurImport
}
