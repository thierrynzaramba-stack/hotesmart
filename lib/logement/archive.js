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
  if (bien.pilote_tarifaire === 'yieldflow') champs.pilote_tarifaire = 'calendrier'
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

module.exports = { archiver, reactiver, STATUT_TACHE_ARCHIVEE, TACHES_EN_VOL, marqueurImport }
