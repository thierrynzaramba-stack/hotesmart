// lib/migration-rekeying.js
// ETAPE « deplacer le bien vers son nouveau provider » — le re-keying.
// Spec : docs/specs/spec-migration-channex.md §5
// Plan : docs/specs/plan-bascule-jour-j.md, phase 2.8
//
// ⚠ LE DEPLACEMENT LUI-MEME VIT EN SQL, PAS ICI.
// `rekey_property` (migrations/2026-09-10-rekeying.sql) est une fonction
// plpgsql, donc une TRANSACTION : les 18 tables et le bien passent ensemble ou
// pas du tout. Dix-huit UPDATE lances depuis Node auraient ete dix-huit
// occasions de s'arreter au milieu — et un bien dont `provider` dit Channex
// tandis que ses tables enfants disent Beds24 est l'etat le plus dangereux du
// chantier. Ce module garde, montre, et appelle.
//
// ⚠ CE QUI REND LE GESTE REPRENABLE : la fonction refuse si le bien ne porte
// pas la cle source annoncee. Un second passage ne « re-deplace » donc rien, il
// echoue en le disant — mieux qu'un succes a zero ligne, qu'on lirait comme
// « c'etait deja fait » sans savoir si ce fut jamais fait.

const { estEnMigration } = require('./rate-sync')

// Le provider vers lequel on deplace. Explicite, jamais deduit de la forme de
// l'identifiant : « si la cible ressemble a un UUID, c'est Channex » marcherait
// aujourd'hui et se tromperait au provider suivant.
const PROVIDER_CIBLE = 'channex'

function raisonDeNePasDeplacer (bien) {
  if (!bien) return { raison: 'bien_inconnu', message: 'Bien introuvable.' }
  if (!estEnMigration(bien)) {
    return { raison: 'pas_en_migration',
      message: 'Ce logement n\'est pas en cours de migration : il n\'y a rien a deplacer. '
        + 'Soit la bascule est deja faite, soit sa propriete cible n\'existe pas encore.' }
  }
  if (!bien.provider_property_id || !bien.migration_target_property_id) {
    return { raison: 'identifiants_incomplets',
      message: 'La cle source ou la propriete cible manque : impossible de savoir ce qui bouge.' }
  }
  return null
}

// ─── L'ETAT : ce qui est encore a gauche, ce qui est deja a droite ───────────
async function auditRekeying (supabase, bien) {
  const refus = raisonDeNePasDeplacer(bien)
  if (refus) return { ok: false, ...refus }

  const { data, error } = await supabase.rpc('rekeying_compter', {
    p_source: String(bien.provider_property_id),
    p_cible: String(bien.migration_target_property_id),
    // Le compte est OBLIGATOIRE : la fonction est `security definer`, elle
    // contourne RLS, et `provider_property_id` n'a aucune unicite globale.
    p_user: bien.user_id
  })
  if (error) return { ok: false, raison: 'lecture_impossible', message: error.message }

  const tables = data || []
  const aDeplacer = tables.reduce((n, t) => n + Number(t.sous_source || 0), 0)
  const dejaCible = tables.reduce((n, t) => n + Number(t.sous_cible || 0), 0)
  return {
    ok: true,
    source: bien.provider_property_id,
    cible: bien.migration_target_property_id,
    lignes_a_deplacer: aDeplacer,
    lignes_deja_sous_la_cible: dejaCible,
    // Les tables vides sont dites aussi : « rien dans cette table » est une
    // information, pas un trou dans le rapport.
    par_table: tables.map(t => ({
      table: t.nom_table,
      // La colonne est dite : trois formes coexistent (`property_id`,
      // une colonne TEXT nommee autrement, un tableau de TEXT), et un rapport
      // qui ne dirait que la table laisserait croire a un doublon.
      colonne: t.colonne,
      source: Number(t.sous_source || 0),
      cible: Number(t.sous_cible || 0)
    }))
  }
}

// ─── LE GESTE ───────────────────────────────────────────────────────────────
// `dryRun` par defaut, comme toute action de l'assistant : il rend l'audit,
// c'est-a-dire exactement ce que le deplacement va toucher.
async function deplacerLeBien (supabase, bien, { dryRun = true } = {}) {
  const refus = raisonDeNePasDeplacer(bien)
  if (refus) return { ok: false, ...refus }

  const audit = await auditRekeying(supabase, bien)
  if (!audit.ok) return audit

  // ⚠ L'AUTOMATISATION DOIT ETRE EN PAUSE, ET CE N'EST PAS NEGOCIABLE.
  // Pendant le deplacement, une ligne peut etre lue sous son ancienne cle et
  // ecrite sous la nouvelle : un cron qui tourne au milieu enverrait un message
  // au voyageur, poserait un code d'acces ou notifierait un menage sur un etat
  // transitoire. Le plan l'exige en 2.1 ; on le VERIFIE ici plutot que d'y
  // compter.
  if (!dryRun && bien.automation_paused !== true) {
    return { ok: false, raison: 'automatisation_active',
      message: 'L\'automatisation de ce logement n\'est pas en pause. Le deplacement doit se '
        + 'faire pendant `automation_paused = true` (phase 2.1 du plan) : sinon un cron peut '
        + 'agir au milieu, sur un etat transitoire.' }
  }

  // ⚠ DES LIGNES DEJA SOUS LA CIBLE FONT ECHOUER TOUTE LA TRANSACTION.
  // Plusieurs tables portent une contrainte d'unicite incluant `property_id` —
  // `property_status (user_id, property_id)`, `menages` et `menage_done`
  // `(user_id, property_id, booking_id, departure_date)`,
  // `property_cleaning_providers (user_id, property_id, provider_id)`. Une seule
  // ligne deja presente a droite, et l'UPDATE leve une violation d'unicite : le
  // deplacement entier est annule, et l'operateur ne recoit qu'un message
  // Postgres brut apres un apercu qui annoncait « N lignes a deplacer » sans un
  // mot. On le DIT avant, table par table.
  const collisions = audit.par_table.filter(t => t.source > 0 && t.cible > 0)
  if (collisions.length) {
    return { ok: false, raison: 'collision_sous_la_cible',
      message: 'Des lignes existent DEJA sous la nouvelle cle sur : '
        + collisions.map(c => `${c.table}.${c.colonne} (${c.cible})`).join(', ')
        + '. Plusieurs de ces tables ont une contrainte d\'unicite sur `property_id` : '
        + 'le deplacement serait annule en bloc. A regarder avant tout geste — un '
        + 'passage precedent a pu s\'arreter, ou un import a pu ecrire a droite.',
      collisions }
  }

  if (dryRun) {
    return {
      ok: true, dry_run: true, audit,
      va_faire: [
        `sauvegarder les ${audit.lignes_a_deplacer} ligne(s) concernee(s) dans rekeying_backup`,
        `deplacer ces lignes de « ${audit.source} » vers « ${audit.cible} » sur ${audit.par_table.length} tables`,
        `passer le logement en provider « ${PROVIDER_CIBLE} » et promouvoir sa cle`
      ],
      deja_sous_la_cible: audit.lignes_deja_sous_la_cible,
      note: 'Rien n\'a ete touche. Le tout se fait dans UNE transaction : il passe '
        + 'entierement, ou pas du tout.'
        + (audit.lignes_deja_sous_la_cible
          ? ` ⚠ ${audit.lignes_deja_sous_la_cible} ligne(s) sont deja sous la nouvelle cle sur `
            + 'des tables sans collision — signe qu\'un passage a deja eu lieu.'
          : '')
    }
  }

  const { data, error } = await supabase.rpc('rekey_property', {
    p_bien: bien.id,
    p_source: String(bien.provider_property_id),
    p_cible: String(bien.migration_target_property_id),
    p_provider: PROVIDER_CIBLE
  })
  if (error) {
    // La transaction a ete annulee : rien n'a bouge. On le DIT, parce qu'un
    // echec de re-keying laisse sinon planer le doute le plus couteux du jour J.
    return { ok: false, raison: 'deplacement_refuse', message: error.message,
      note: 'La transaction a ete annulee : AUCUNE ligne n\'a bouge.' }
  }

  const parTable = (data || []).map(t => ({
    table: t.nom_table, colonne: t.colonne, deplacees: Number(t.deplacees || 0)
  }))
  const total = parTable.filter(t => t.table !== 'properties')
    .reduce((n, t) => n + t.deplacees, 0)

  // ⚠ ON RECOMPTE LA SOURCE APRES, ET C'EST LE SEUL CONTROLE QUI VAUT.
  // `automation_paused` ne couvre PAS les writers de synchro : `isAutomationPaused`
  // n'est consulte que par les crons de messages, de codes d'arrivee et de
  // classification. Le cron de 5 minutes qui ecrit `bookings_snapshot`,
  // `menages` et `menage_events` continue de tourner — il peut avoir lu la cle
  // source avant la transaction et inserer apres, sous une cle desormais morte.
  // Comparer au seul audit d'AVANT ne l'aurait jamais vu.
  const apres = await auditRekeying(supabase, bien)
  const restantSource = apres.ok ? apres.lignes_a_deplacer : null

  // Le controle qui compte : ce qui a bouge egale ce qui etait annonce, et il ne
  // reste rien a gauche.
  const conforme = total === audit.lignes_a_deplacer && restantSource === 0
  return {
    ok: true, dry_run: false,
    source: audit.source, cible: audit.cible,
    annonce: audit.lignes_a_deplacer,
    deplacees: total,
    conforme,
    par_table: parTable,
    restant_sous_la_source: restantSource,
    note: conforme
      ? `${total} ligne(s) deplacee(s), exactement ce que l'apercu annoncait, et plus rien sous `
        + `l'ancienne cle. Le logement est desormais chez « ${PROVIDER_CIBLE} ».`
      : `⚠ ECART : ${audit.lignes_a_deplacer} ligne(s) annoncee(s), ${total} deplacee(s), `
        + `${restantSource === null ? 'recomptage impossible' : restantSource + ' encore sous l\'ancienne cle'}. `
        + 'Le deplacement a reussi (la transaction est passee), mais l\'ecart doit etre '
        + 'explique AVANT de reprendre l\'automatisation : un cron de synchro a pu ecrire '
        + 'sous l\'ancienne cle pendant le geste — `automation_paused` ne l\'arrete pas.'
  }
}

// L'etat de l'etape, pour l'assistant.
//
// ⚠ IL NE COMPTE PAS, ET C'EST DELIBERE. `rekeying_compter` fait deux `count(*)`
// sur chacune des 21 tables — dont `bookings_snapshot` et `messages`, les plus
// volumineuses. `GET /api/migration` boucle sur tous les biens du compte : 42
// comptages par bien en migration, sur l'endpoint qu'on rafraichit le plus le
// jour J. Le comptage appartient a l'APERCU de l'action, pas a l'affichage.
function etatRekeying (bien) {
  if (!bien || !bien.migration_target_property_id) {
    return { etat: 'sans_objet',
      message: 'Ce logement n\'a pas encore de propriete cible : rien a deplacer.' }
  }
  // ⚠ APRES LA BASCULE, L'ETAPE DIT « FAIT » — PAS « SANS OBJET ».
  // Elle sortait sinon du decompte, et le succes du geste le plus irreversible
  // du chantier n'etait confirme nulle part.
  if (!estEnMigration(bien)) {
    return { etat: 'fait', action: 're_keying',
      message: 'La bascule est faite : ce logement et ses donnees sont chez le nouveau provider '
        + `(${bien.provider_property_id}).` }
  }
  return { etat: 'a_faire', action: 're_keying',
    message: `Les donnees de ce logement sont encore sous « ${bien.provider_property_id} » et `
      + `doivent passer sous « ${bien.migration_target_property_id} ». A faire pendant la pause `
      + 'de l\'automatisation, en une fois. L\'apercu de l\'action donne le compte exact.' }
}

module.exports = { deplacerLeBien, auditRekeying, etatRekeying, raisonDeNePasDeplacer, PROVIDER_CIBLE }
