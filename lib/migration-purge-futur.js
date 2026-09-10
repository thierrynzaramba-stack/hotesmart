// lib/migration-purge-futur.js
// ETAPE « neutraliser le futur au demappage » — assistant de migration.
//
// ⚠ REGLE DE THIERRY, ET ELLE REMPLACE UN CHANTIER ENTIER.
// « Quand on demappe une propriete d'un OTA, les reservations a venir et en
// cours ne comptent plus. Seules les passees sont conservees. Comme ca, au
// remapping, pas de probleme. »
//
// Ce que cette regle evite : la spec (§5) prevoyait un DEDOUBLONNAGE du carnet
// par `otaReservationCode`, parce que l'OTA rend les sejours a venir avec de
// NOUVEAUX identifiants alors que le coeur les detient sous les anciens. Sans
// rapprochement : menage en double, message envoye deux fois, code d'acces pose
// deux fois. Si le futur ne compte plus sous l'ancien identifiant, il n'y a plus
// rien a rapprocher — et le rapprochement est precisement ce qui se trompe.
//
// ⚠ ON NEUTRALISE, ON NE SUPPRIME PAS — seconde idee de Thierry, et elle est
// meilleure que la premiere version de ce fichier, qui detruisait les lignes.
//
// ⚠ ET LE STATUT EST `demapped`, PAS `cancelled` — troisieme precision de
// Thierry, et elle evite un degat definitif : les annulations alimentent les
// STATISTIQUES. Ranger sous le meme mot « le voyageur s'est decommande » et
// « nous avons debranche ce logement d'un OTA » aurait fausse ces chiffres pour
// toujours, sans aucun moyen de les separer apres coup.
//
// Un sejour `demapped` se comporte comme un annule partout ou ca compte :
//   - n'occupe aucune nuit (`lib/nuits-occupees.js` ne compte que `confirmed`
//     et `blocked`), donc le stock pousse aux OTA reste juste ;
//   - fait annuler son menage TOUT SEUL, par le chemin normal du produit :
//     `sync-menages-entite` construit ses sejours « vivants » avec
//     `isActiveStatus`, qui ne reconnait que `confirmed` — un `demapped` en sort
//     donc, et son menage est annule (« Reservation annulee ou date de depart
//     deplacee ») ;
//   - mais NE COMPTE PAS comme une annulation voyageur : `estAnnulationVoyageur`
//     (lib/bookings-snapshot-status.js) existe pour cette distinction ;
//   - ne genere plus ni message ni code d'acces ;
//   - et LAISSE LA TRACE. Rien n'est detruit, rien n'est orphelin, et le geste
//     se defait en remettant le statut — `snapshot.demappage.statut_avant` le
//     garde en memoire.
//
// ⚠ QUAND LE FAIRE : APRES LE RE-KEYING, ET C'EST IMPORTANT.
// Tant que le bien est encore `provider = 'beds24'`, le cron de synchronisation
// le voit et REECRIT ses snapshots depuis Beds24 — il remettrait `confirmed` au
// cycle suivant, en silence. Apres le re-keying, le bien est chez Channex : plus
// aucun cron Beds24 ne le lit, et l'annulation tient. La pause de
// l'automatisation ne suffit PAS : `isAutomationPaused` ne couvre pas les
// writers de synchro.

const { readStatus, STATUS } = require('./bookings-snapshot-status')

function ymd (d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Un sejour est-il « du futur » au sens de la regle ? Son depart est
// STRICTEMENT posterieur a aujourd'hui — donc a venir, ou en cours.
//
// ⚠ LE DEPART DU JOUR EST EXCLU, ET C'EST DELIBERE. Avec `>=`, un sejour qui
// part aujourd'hui etait neutralise : `sync-menages-entite` annulait alors, au
// passage suivant, le menage de ce depart — deja attribue, peut-etre en cours.
// La prestataire aurait vu disparaitre de son planning un menage de sortie du
// jour. Un sejour qui part aujourd'hui est de toute facon fini pour l'OTA : il
// ne sera pas reimporte, donc il ne peut pas faire doublon.
function estDuFutur (snapshot, aujourdhui) {
  const dep = snapshot && snapshot.departure
  if (!dep) return false
  return String(dep) > aujourdhui
}

// Et « en cours » : le voyageur est dans les murs.
function estEnCours (snapshot, aujourdhui) {
  const arr = snapshot && snapshot.arrival
  const dep = snapshot && snapshot.departure
  if (!arr || !dep) return false
  return String(arr) <= aujourdhui && String(dep) >= aujourdhui
}

// ─── L'INVENTAIRE : ce qui serait annule, et ce qui merite un regard ─────────
async function auditPurge (supabase, bien, { maintenant = new Date() } = {}) {
  if (!bien || !bien.provider_property_id) {
    return { ok: false, raison: 'bien_inconnu', message: 'Bien introuvable.' }
  }
  const aujourdhui = ymd(maintenant)
  const cle = String(bien.provider_property_id)

  // Pagination explicite : un bien de Bagneres porte 786 snapshots.
  const sejours = []
  let offset = 0
  for (;;) {
    const { data, error } = await supabase
      .from('bookings_snapshot')
      .select('booking_id, snapshot')
      .eq('user_id', bien.user_id)
      .eq('property_id', cle)
      .order('booking_id')
      .range(offset, offset + 499)
    if (error) return { ok: false, raison: 'lecture_impossible', message: error.message }
    for (const r of data || []) sejours.push(r)
    if (!data || data.length < 500) break
    offset += 500
  }

  // ⚠ LES DEJA ANNULEES SONT HORS SUJET : elles n'occupent rien, ne generent
  // rien, et l'OTA ne les reimportera pas en double. Les retoucher ne ferait que
  // brouiller la trace d'une annulation reelle.
  const duFutur = sejours.filter(r => estDuFutur(r.snapshot, aujourdhui)
    // ⚠ SEULS LES `confirmed` SONT CONCERNES, ET L'OUBLI DE `blocked` COUTAIT CHER.
    //   - `cancelled` / `demapped` : deja hors jeu, les retoucher brouillerait
    //     la trace d'une annulation reelle ;
    //   - `request` : n'occupe rien, ne sera pas reimporte comme un sejour ;
    //   - `blocked` : UN BLOCAGE PROPRIETAIRE N'EST PAS UNE RESERVATION D'OTA.
    //     Il n'est pas reimporte au remapping, donc ne peut pas faire doublon —
    //     et le neutraliser aurait REMIS EN VENTE les nuits que l'hote s'etait
    //     reservees. `lib/nuits-occupees.js` compte `confirmed` ET `blocked` :
    //     un blocage passe en `demapped` cesse d'occuper, et la poussee ARI le
    //     vend. Trouve en review.
    && readStatus(r.snapshot, bien.provider) === STATUS.CONFIRMED)
  const enCours = duFutur.filter(r => estEnCours(r.snapshot, aujourdhui))

  // Les codes d'acces DEJA POSES sur un sejour en cours : le seul point qui
  // demande une decision humaine. On ne les touche pas — on les NOMME.
  // ⚠ PAS DE FILTRE `user_id` ICI, ET C'EST LA SEULE FACON QUE CA MARCHE.
  // Aucun des deux writers de codes ne renseigne cette colonne — c'est le
  // bloquant (d) de CLAUDE.md, « user_id dans INSERT serrures » : 23 lignes
  // sur 119 seulement. Le filtre rendait donc `count = 0` TOUJOURS, et
  // l'information que Thierry a explicitement voulu conserver n'etait jamais
  // affichee. Le cadrage est porte par `property_id` + `booking_id`, tous deux
  // issus d'un bien deja resolu pour ce compte.
  const avecCode = []
  for (const r of enCours) {
    const { count, error } = await supabase.from('access_codes')
      .select('id', { count: 'exact', head: true })
      .eq('property_id', cle).eq('booking_id', r.booking_id)
      // Un code deja revoque ne compte pas : il n'est plus sur la serrure.
      .neq('status', 'deleted')
    // Une lecture en echec ne doit pas se lire comme « aucun code ».
    if (error) {
      avecCode.push({ booking_id: r.booking_id, arrivee: r.snapshot.arrival,
        depart: r.snapshot.departure, codes: null, lecture: 'echec : ' + error.message })
      continue
    }
    if (count) avecCode.push({ booking_id: r.booking_id, arrivee: r.snapshot.arrival,
      depart: r.snapshot.departure, codes: count })
  }

  // ⚠ « passes » NE COMPTE QUE LE PASSE. `sejours.length - duFutur.length` y
  // rangeait les annulations voyageur et les deja-`demapped` du FUTUR (exclus de
  // `duFutur` plus haut) : le chiffre sur lequel l'operateur decide etait
  // surevalue.
  const vraimentPasses = sejours.filter(r => !estDuFutur(r.snapshot, aujourdhui)).length
  return {
    ok: true,
    aujourdhui,
    passes: vraimentPasses,
    hors_jeu_au_futur: sejours.length - vraimentPasses - duFutur.length,
    a_annuler: duFutur.length,
    en_cours: enCours.length,
    sejours: duFutur.map(r => ({
      booking_id: r.booking_id,
      arrivee: r.snapshot.arrival,
      depart: r.snapshot.departure,
      statut: readStatus(r.snapshot, bien.provider),
      en_cours: estEnCours(r.snapshot, aujourdhui)
    })),
    codes_deja_poses: avecCode
  }
}

// ─── LE GESTE ───────────────────────────────────────────────────────────────
async function purgerLeFutur (supabase, bien, { dryRun = true, maintenant = new Date() } = {}) {
  // ⚠ ON VERIFIE L'ORDRE, ON N'Y COMPTE PAS.
  // L'en-tete de ce fichier grave « APRES le re-keying, jamais avant », et rien
  // ne le verifiait : lance pendant que le bien est encore chez Beds24, le cron
  // */5 reecrit le snapshot en `confirmed`, et `detectChange` lit
  // `demapped → confirmed` comme un sejour NEUF — menages annules puis recrees
  // et re-notifies, message d'arrivee et code d'acces rejoues. Exactement ce que
  // cette etape existe pour eviter. `deplacerLeBien` verifie bien
  // `automation_paused` ; celle-ci doit verifier le provider.
  const { estRelieAuCanal } = require('./rate-sync')
  if (!dryRun && !estRelieAuCanal(bien)) {
    return { ok: false, raison: 'avant_le_re_keying',
      message: 'Ce logement est encore chez son ancien provider : la neutralisation serait '
        + 'defaite au prochain cycle de synchronisation (le snapshot repasserait en '
        + '« confirme », et le produit le lirait comme un sejour neuf — menage recree, '
        + 'message et code rejoues). Faire d\'abord le deplacement des donnees (re-keying).' }
  }

  const audit = await auditPurge(supabase, bien, { maintenant })
  if (!audit.ok) return audit

  if (!audit.a_annuler) {
    return { ok: true, dry_run: !!dryRun, audit,
      note: 'Aucun sejour a venir ou en cours a neutraliser : rien ne peut faire doublon au '
        + `remapping. Les ${audit.passes} sejours passes restent intacts.` }
  }

  // ⚠ UN CODE DEJA POSE N'EST PAS UN OBSTACLE — ARBITRAGE DE THIERRY
  // (10 septembre 2026). J'avais mis un refus ici : un voyageur dans les murs
  // dont le code est pose sur la serrure, et qui pourrait en recevoir un second
  // au remapping. Sa reponse : « il l'a deja, et impossible de le supprimer,
  // donc pas d'impact ». C'est juste — un code supplementaire n'empeche pas
  // d'entrer, et pendant la fenetre de migration le suivi se fait a la main.
  //
  // On garde l'information (elle est dite, dans l'apercu comme dans l'etat) et
  // on ne bloque pas : un refus qui protege d'un risque ecarte ne protege plus
  // rien, il empeche seulement d'avancer.

  if (dryRun) {
    return { ok: true, dry_run: true, audit,
      codes_deja_poses: audit.codes_deja_poses,
      va_faire: [
        `passer ${audit.a_annuler} sejour(s) en « demappe » (statut distinct de « annule », `
          + 'pour ne pas polluer les statistiques d\'annulation)',
        'le menage de chacun sera annule tout seul au prochain passage du sync',
        `les ${audit.passes} sejours passes ne sont PAS touches`
      ],
      note: 'Rien n\'a ete modifie. Aucune ligne n\'est supprimee : on neutralise, la trace '
        + 'reste, et le geste se defait en remettant le statut.'
        + (audit.codes_deja_poses.length
          ? ` ⚠ ${audit.codes_deja_poses.length} sejour(s) EN COURS portent un code deja pose `
            + 'sur la serrure : le voyageur le garde (la base ne commande pas la serrure), et '
            + 'pourrait en recevoir un second au remapping. Sans consequence sur son acces.'
          : '') }
  }

  // ⚠ ECRITURE DIRECTE SUR `bookings_snapshot`, ET C'EST L'EXCEPTION ASSUMEE.
  // La regle du depot veut que cette table soit ecrite par la couche sync
  // uniquement. Ici on ne synchronise rien : on marque une decision de l'hote,
  // ponctuelle et bornee au futur d'un seul bien. Passer par le writer aurait
  // demande de fabriquer un faux payload provider — bien pire.
  const horodatage = new Date(maintenant).toISOString()
  const annules = []
  for (const s of audit.sejours) {
    const { data: ligne, error: eLire } = await supabase
      .from('bookings_snapshot')
      .select('snapshot')
      .eq('user_id', bien.user_id)
      .eq('property_id', String(bien.provider_property_id))
      .eq('booking_id', s.booking_id)
      .maybeSingle()
    if (eLire || !ligne) continue

    const nouveau = {
      ...(ligne.snapshot || {}),
      // ⚠ `demapped`, PAS `cancelled` — demande explicite de Thierry. Les
      // annulations alimentent les STATISTIQUES : ranger sous le meme mot « le
      // voyageur s'est decommande » et « nous avons debranche ce logement »
      // fausserait ces chiffres pour toujours, sans moyen de les separer apres
      // coup. Voir lib/bookings-snapshot-status.js.
      status: STATUS.DEMAPPED,
      demappage: { neutralise_le: horodatage, statut_avant: s.statut }
    }
    const { error } = await supabase.from('bookings_snapshot')
      .update({ snapshot: nouveau, updated_at: horodatage })
      .eq('user_id', bien.user_id)
      .eq('property_id', String(bien.provider_property_id))
      .eq('booking_id', s.booking_id)
    if (error) {
      return { ok: false, raison: 'annulation_partielle', booking_id: s.booking_id,
        message: error.message, annules,
        note: `${annules.length} sejour(s) deja neutralise(s). Rien n'est detruit : relancer `
          + 'reprend la ou on s\'est arrete.' }
    }
    annules.push(s.booking_id)
  }

  return { ok: true, dry_run: false, audit, neutralises: annules.length,
    note: `${annules.length} sejour(s) passe(s) en « demappe » — un statut distinct de `
      + '« annule », pour que les statistiques d\'annulation restent justes. Leur menage sera annule tout '
      + 'seul au prochain passage du sync, et ils n\'occupent plus aucune nuit. '
      + `Les ${audit.passes} sejours passes sont intacts. Au remapping, l'OTA rendra ces `
      + 'sejours avec ses propres identifiants : plus rien a rapprocher, donc aucun doublon.' }
}

// L'etat de l'etape, pour l'assistant.
//
// ⚠ SANS OBJET HORS MIGRATION, ET C'EST UNE GARDE, PAS UN CONFORT.
// Sans ce repli, TOUT bien du compte — y compris un bien Channex vif qui n'a
// jamais migre — ressortait avec « N sejours a venir a neutraliser » et l'action
// exposee : un clic mettait tout son carnet futur en `demapped`. Il ne comptait
// pas non plus dans `pretes/total`, qui n'atteignait jamais son total sur un
// bien sain. Et l'etat paginait 786 snapshots par bien a chaque affichage.
async function etatPurge (supabase, bien, { maintenant = new Date() } = {}) {
  if (!bien || !bien.migration_target_property_id) {
    return { etat: 'sans_objet',
      message: 'Ce logement n\'est pas concerne par une migration : rien a neutraliser.' }
  }

  const audit = await auditPurge(supabase, bien, { maintenant })
  if (!audit.ok) return { etat: 'bloque', message: audit.message }
  if (!audit.a_annuler) {
    return { etat: 'fait',
      message: 'Aucun sejour a venir : rien ne peut faire doublon au remapping. '
        + `${audit.passes} sejour(s) passe(s) conserves.` }
  }
  const alerte = audit.codes_deja_poses.length
    ? ` ⚠ ${audit.codes_deja_poses.length} sejour(s) EN COURS portent un code deja pose sur la `
      + 'serrure : le voyageur le garde, sans consequence sur son acces.'
    : ''
  return { etat: 'a_faire', action: 'purger_le_futur',
    message: `${audit.a_annuler} sejour(s) a venir ou en cours a neutraliser (dont `
      + `${audit.en_cours} en cours). A faire APRES le re-keying : avant, le cron Beds24 `
      + `remettrait « confirme » au cycle suivant.${alerte}` }
}

module.exports = { purgerLeFutur, auditPurge, etatPurge, estDuFutur, estEnCours }
