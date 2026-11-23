const { supabase } = require('./cron-shared')
const billing = require('./billing')
const { clesMigrees } = require('./cles-migrees')
const { clesArchivees, cleDuBien } = require('./biens-vivants')
const { adresseDeLaFiche } = require('./balises')

// ─── Materialisation des biens Beds24 en table 'properties' ──────────────────
// Les biens Beds24 sont normalement fetchs LIVE a chaque cron (pas de ligne DB).
// Pour la facturation (quantite = biens avec active_at non null), on les persiste :
// une ligne properties par bien Beds24, provider='beds24'. active_at est pose a la
// PREMIERE apparition du bien dans un cron reussi, et jamais reecrit ensuite.
//
// Choix "select puis insert" (pas d'upsert) : on ne depend d'aucune contrainte unique
// (user_id, provider_property_id) cote schema, et active_at reste first-write-wins.
// Idempotent : au 2e passage le bien existe deja -> on ne touche pas active_at.
// ─── L'adresse de la FICHE, posee sur l'objet Beds24 ────────────────────────
// Spec « Accueil du voyageur », S2 : une seule adresse, celle de la fiche
// (`properties.address`). Sur le chemin Beds24, le cron lit l'objet rendu par
// l'API, dont `address` est celle de Beds24 — et la fiche, l'hote la modifie
// sans que rien ne la renvoie a Beds24. On pose donc `adresseFiche`, que
// `replisDuBien` (lib/balises.js) prend seule quand elle existe.
// ⚠ UNE LECTURE DEDIEE, AVANT TOUTE GARDE (constat 3 de la review 2). Posee
// dans la boucle de materialisation, elle manquait aux biens ARCHIVES (sautes
// avant), a tout le compte quand la liste des archives ou des cles migrees
// etait illisible, et au bien dont la lecture tombait : l'ancienne adresse
// Beds24 repartait au voyageur, alors que l'hote l'avait corrigee. Cout : une
// requete par compte Beds24 et par cycle, bornee aux biens rendus par l'API.
// Ne leve JAMAIS : sans elle, l'adresse Beds24 reste le repli, comme avant.
const LOT_ADRESSES = 200
async function poserAdresseDeLaFiche (userId, properties) {
  try {
    const parRef = new Map()
    for (const p of properties || []) if (p && p.id != null) parRef.set(String(p.id), p)
    const refs = [...parRef.keys()]
    for (let i = 0; i < refs.length; i += LOT_ADRESSES) {
      const lot = refs.slice(i, i + LOT_ADRESSES)
      const { data, error } = await supabase.from('properties')
        .select('provider_property_id, address, zip_code, city')
        .eq('user_id', userId).eq('provider', 'beds24').in('provider_property_id', lot)
      if (error) {
        console.error('[beds24-props] adresses de fiche illisibles, repli sur Beds24 :', error.message)
        return
      }
      for (const row of data || []) {
        const p = parRef.get(String(row.provider_property_id))
        if (p) p.adresseFiche = adresseDeLaFiche(row)
      }
    }
  } catch (e) {
    console.error('[beds24-props] adresses de fiche, exception :', e.message)
  }
}

async function materializeBeds24Properties(userId, properties, results) {
  if (!Array.isArray(properties) || !properties.length) return
  // Avant les gardes : elles peuvent renoncer au cycle, l'envoi, lui, continue.
  await poserAdresseDeLaFiche(userId, properties)

  // ⚠ UN BIEN MIGRE NE SE MATERIALISE PLUS, ET SURTOUT NE SE FACTURE PLUS.
  // Mesure du 10 septembre 2026 : la fiche Beds24 de La bulle, supprimee apres
  // son transfert vers Channex, s'est RECREEE au cycle suivant sous un nouvel
  // uuid — avec `active_at` repose, donc le bien recompte dans la quantite
  // facturee alors qu'il est deja facture sous sa fiche Channex. Le bien reste
  // volontairement dans le compte Beds24 (filet de rollback), donc
  // `fetchProperties` le rend toujours : c'est ICI qu'il faut l'ecarter.
  const migrees = await clesMigrees(supabase, userId, 'beds24')

  // ⚠ LES BIENS ARCHIVES DE CE COMPTE, lus une fois. Et une lecture INCOMPLETE
  // fait renoncer au cycle, comme la garde des cles migrees juste en dessous :
  // materialiser un bien archive CREE UN BIEN FACTURE, et c'est irreversible
  // sans geste manuel.
  const arch = await clesArchivees(supabase, [userId])
  if (!arch.complet) {
    // ⚠ ICI ON RENONCE, ET LA SYNCHRO DES MENAGES, ELLE, CONTINUE — deux
    // politiques pour le meme signal, et c'est voulu (constat 5 de la revue de
    // 26339835) : recreer un menage se defait, materialiser un bien CREE UN
    // BIEN FACTURE, ce que le dépôt qualifie d'irreversible sans geste manuel.
    // Le cout d'une abstention n'est pas le meme des deux cotes.
    console.error('[beds24-props] liste des biens archives INCOMPLETE : aucune materialisation ce cycle')
    results?.errors?.push({ context: 'beds24_props', error: 'archives illisibles' })
    // Le drapeau que la supervision lit, de la MEME forme que la garde soeur
    // des cles migrees : deux formes pour « on n'a rien materialise » se
    // compteraient comme deux pannes differentes.
    if (results) results.beds24MaterializationSkipped = true
    return
  }

  // ⚠ SI LA GARDE EST AVEUGLE, ON NE MATERIALISE RIEN — MESURE DU 12 SEPTEMBRE.
  // (Depuis le 14 septembre, TOUS les appelants s'abstiennent sur une lecture
  // en echec — voir [cles-migrees]. Ce refus-ci est anterieur et reste ecrit
  // ici parce qu'il porte sa propre raison, plus lourde.) Materialiser CREE UN
  // BIEN FACTURE : le 12 septembre, deux fiches migrees sont revenues a
  // 03:00:58 et 06:00:39 — deux cycles isoles sur une centaine — avec un
  // `active_at` neuf, faisant passer la facturation de 2 a 4 biens.
  // Un bien non materialise pendant un cycle ne coute rien : le suivant le
  // rattrape. Un bien refacture, si.
  if (migrees.lectureEnEchec) {
    console.error('[beds24-props] table des cles migrees ILLISIBLE : aucune materialisation '
      + 'ce cycle (un bien migre serait recree et refacture). Compte ' + userId)
    if (results) results.beds24MaterializationSkipped = true
    return
  }

  // ⚠ TROIS CAS, ET IL FAUT LES DISTINGUER — RELEVE EN REVIEW.
  // Mon `if (ignorees > 0)` ne se declenchait ni quand rien n'est migre, ni
  // quand la lecture a echoue (les deux donnent 0), alors que le commentaire
  // pretendait justement les distinguer. « 0 ignore » peut vouloir dire « la
  // garde n'a rien filtre parce qu'elle est aveugle » — l'ensemble rendu est
  // vide dans les deux cas, seul `lectureEnEchec` les separe. On le dit.
  if (!migrees.size) {
    console.log(`[beds24-props] aucune cle migree connue pour le compte ${userId} `
      + `(soit aucune migration, soit lecture en echec — voir [cles-migrees])`)
  }

  let newlyActive = 0
  let ignorees = 0
  for (const p of properties) {
    const propId = p?.id != null ? String(p.id) : null
    if (!propId) continue
    if (migrees.has(propId)) { ignorees++; continue }
    // ⚠ UN BIEN ARCHIVE SE SAUTE, IL NE SE FILTRE PAS — constat 5 de la revue
    // de 320aa4f8, et c'est MON correctif precedent qui etait faux. Mettre
    // `.is('archive_le', null)` dans le SELECT ci-dessous ne saute pas le bien :
    // il le rend INTROUVABLE, donc la branche `if (!existing)` prend le dessus
    // et tente un INSERT avec `active_at` — rejete par
    // `properties_user_provider_unique`, et donc une erreur A CHAQUE CYCLE DE
    // CINQ MINUTES, indefiniment, pour tout bien archive encore present chez
    // Beds24. Le geste juste est celui qu'emploie la ligne du dessus.
    // ⚠ POURQUOI IL FAUT LE SAUTER : cette boucle POSE `active_at`, et
    // `active_at` non nul est exactement ce que `lib/billing.js` compte comme
    // bien facturable. Un bien archive re-materialise serait remis a la
    // facturation en silence.
    // ⚠ ON COMPARE LA CLE COMPOSITE, ON NE LA DECOUPE PAS (constat 4 de la
    // revue de 26339835). Reconstruire la cle nue par `slice(userId.length + 1)`
    // supposait que `String(userId)` ait exactement la longueur du `user_id`
    // rendu par PostgREST — qui normalise un uuid pour la comparaison. Un
    // decalage d'un caractere rendait le Set INOPERANT, donc un bien Beds24
    // archive re-materialise avec un `active_at` neuf : remis a la facturation,
    // irreversible sans geste manuel.
    if (arch.cles.has(cleDuBien(userId, propId))) { ignorees++; continue }

    try {
      const { data: existing, error: selErr } = await supabase
        .from('properties')
        .select('id, active_at')
        .eq('user_id', userId)
        .eq('provider', 'beds24')
        .eq('provider_property_id', propId)
        .maybeSingle()
      // Erreur de lecture (ex. colonne active_at absente) : on n'insere pas a l'aveugle.
      if (selErr) { console.error('[beds24-props] select echec', propId, selErr.message); continue }


      if (!existing) {
        // Premiere apparition : materialisation + active_at = maintenant.
        const { error: insErr } = await supabase.from('properties').insert({
          user_id:              userId,
          provider:             'beds24',
          provider_property_id: propId,
          name:                 p.name || ('Bien ' + propId),
          inventory_type:       'whole',
          city:                 p.city || null,
          country:              p.country || null,
          zip_code:             p.postcode || null,
          address:              p.address || null,
          currency:             p.currency || null,
          active_at:            new Date().toISOString()
        })
        if (insErr) console.error('[beds24-props] insert echec', propId, insErr.message)
        else {
          newlyActive++
          if (results) results.totalBeds24Materialized = (results.totalBeds24Materialized || 0) + 1
        }
      } else if (!existing.active_at) {
        // Bien deja materialise avant l'existence de active_at : on le pose maintenant.
        const { error: updErr } = await supabase
          .from('properties')
          .update({ active_at: new Date().toISOString() })
          .eq('id', existing.id)
          .is('active_at', null)
        if (updErr) console.error('[beds24-props] active_at update echec', propId, updErr.message)
        else newlyActive++
      }
      // Heures d'arrivee/depart du bien, telles que Beds24 les connait. Persistees
      // pour que le code metier n'ait jamais besoin d'appeler le provider : le
      // dispatcher (lib/booking-changes-dispatch.js) lit `properties` uniquement.
      // Le formulaire Connaissances reste prioritaire a la lecture.
      //
      // Mise a jour SEPAREE et non bloquante, hors de l'insert principal : si la
      // migration n'est pas encore appliquee, la materialisation du bien (et donc
      // la facturation) ne doit pas echouer pour autant.
      await syncPropertyHours(userId, propId, p)
    } catch (err) {
      console.error('[beds24-props] Erreur bien', propId, err.message)
    }
  }

  // ⚠ ON DIT COMBIEN ONT ETE IGNORES. Un filtre muet aurait rendu indiscernable
  // « aucun bien migre » de « la lecture des cles migrees a echoue » : les deux
  // rendent un ensemble vide.
  if (ignorees > 0) {
    console.log(`[beds24-props] ${ignorees} bien(s) migre(s) ignore(s) pour le compte ${userId}`)
    if (results) results.beds24MigratedSkipped = (results.beds24MigratedSkipped || 0) + ignorees
  }

  // De nouveaux biens sont devenus actifs ce cycle -> aligne la facturation une seule
  // fois pour le compte (no-op si beta, si aucun prix Stripe, ou si deja a jour).
  if (newlyActive > 0) {
    try { await billing.syncAccountBilling(userId) }
    catch (e) { console.error('[beds24-props] billing sync echec', userId, e.message) }
  }
}

// Aligne properties.checkin_time / checkout_time sur ce que renvoie Beds24.
// N'ecrit que si la valeur a change (evite une ecriture par bien a chaque cycle).
// Fail-safe : ne throw jamais, ne bloque pas la materialisation.
async function syncPropertyHours(userId, propId, p) {
  const checkin  = p?.checkInStart || null
  const checkout = p?.checkOutEnd  || null
  if (!checkin && !checkout) return

  try {
    const { data: row, error: selErr } = await supabase
      .from('properties')
      .select('id, checkin_time, checkout_time')
      .eq('user_id', userId)
      .eq('provider', 'beds24')
      // Les horaires d'un bien archive n'ont plus de voyageur a informer.
      .is('archive_le', null)
      .eq('provider_property_id', propId)
      .maybeSingle()
    // Colonnes absentes (migration non appliquee) : no-op silencieux.
    if (selErr || !row) return
    if (row.checkin_time === checkin && row.checkout_time === checkout) return

    const { error: updErr } = await supabase
      .from('properties')
      .update({ checkin_time: checkin, checkout_time: checkout })
      .eq('id', row.id)
    if (updErr) console.error('[beds24-props] heures update echec', propId, updErr.message)
  } catch (e) {
    console.error('[beds24-props] heures exception', propId, e.message)
  }
}

module.exports = { materializeBeds24Properties, syncPropertyHours, poserAdresseDeLaFiche }
