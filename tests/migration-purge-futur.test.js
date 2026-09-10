// tests/migration-purge-futur.test.js
// NEUTRALISER LE FUTUR AU DEMAPPAGE — regle de Thierry.
//
// « Quand on demappe une propriete d'un OTA, les reservations a venir et en
// cours ne comptent plus. Seules les passees sont conservees. Comme ca, au
// remapping, pas de probleme. »
//
// Cette regle remplace tout un chantier : la spec prevoyait un dedoublonnage du
// carnet par `otaReservationCode`. Si le futur ne compte plus sous l'ancien
// identifiant, il n'y a plus rien a rapprocher — et le rapprochement est
// precisement ce qui se trompe.

const test = require('node:test')
const assert = require('node:assert')

const { purgerLeFutur, auditPurge, etatPurge } = require('../lib/migration-purge-futur')
const { STATUS, readStatus, isActiveStatus, estAnnulationVoyageur } = require('../lib/bookings-snapshot-status')

// ⚠ L'ETAT REEL AU MOMENT DE CETTE ETAPE : le re-keying est DEJA passe, donc le
// bien est chez Channex et sa cle a ete promue. La colonne cible garde la
// memoire du chantier — c'est elle qui rend l'etape « concernee ».
const BIEN = {
  id: 'uuid-bulle', user_id: 'uuid-hote', name: 'La bulle', provider: 'channex',
  provider_property_id: 'chx-cible', migration_target_property_id: 'chx-cible'
}
// Et le meme bien AVANT le re-keying : l'etape doit alors refuser d'agir.
const AVANT_REKEYING = {
  ...BIEN, provider: 'beds24', provider_property_id: '209413'
}
const AUJ = new Date('2026-09-10T12:00:00Z')

// ⚠ C'EST LA SOURCE QUI DIT SI UN CANAL RENDRA LE SEJOUR, pas le code : les
// reservations creees par HoteSmart portent un code elles aussi (`HS-…`).
// Un sejour d'OTA par defaut ; `sejourDirect` pour l'autre cas.
const sejour = (id, arrival, departure, status = 'confirmed') =>
  ({ booking_id: id, snapshot: { arrival, departure, status, source: 'airbnb',
    otaReservationCode: 'CODE-' + id } })

// Une reservation hors canal : celle qui doit se POURSUIVRE.
const sejourDirect = (id, arrival, departure, source = 'direct', code = null) =>
  ({ booking_id: id, snapshot: { arrival, departure, status: 'confirmed', source,
    otaReservationCode: code } })

// Faux client : pagine les snapshots, note les mises a jour.
function faux ({ sejours = [], codes = 0 } = {}) {
  const ecrits = []
  const filtres = {}
  let table = null
  const api = {
    from (t) { table = t; return api },
    select () { return api },
    eq (col, v) { filtres[col] = v; return api },
    order () { return api },
    // Le comptage des codes exclut ceux deja revoques.
    neq () { return api },
    range: async () => ({ data: table === 'bookings_snapshot' ? sejours : [], error: null }),
    limit: async () => ({ data: [], error: null, count: codes }),
    // ⚠ Le double resout par `booking_id`, comme postgrest : sinon le test
    // « le passe n'est JAMAIS touche » passerait a l'identique si la boucle
    // relisait et reecrivait la mauvaise ligne.
    maybeSingle: async () => ({
      data: sejours.find(x => x.booking_id === filtres.booking_id) || null, error: null
    }),
    update (patch) { ecrits.push({ table, patch, booking_id: filtres.booking_id }); return api },
    then (ok) { return Promise.resolve({ data: [], error: null, count: codes }).then(ok) }
  }
  return { api, ecrits }
}

// ─── Ce qui compte comme « du futur » ───────────────────────────────────────

test('LE TEST QUI COMPTE : le passe n est JAMAIS touche', async () => {
  const f = faux({ sejours: [
    sejour('vieux', '2024-02-20', '2024-02-21'),
    sejour('futur', '2026-09-20', '2026-09-21')
  ] })
  const r = await auditPurge(f.api, BIEN, { maintenant: AUJ })
  assert.equal(r.a_annuler, 1)
  assert.equal(r.passes, 1)
  assert.deepEqual(r.sejours.map(s => s.booking_id), ['futur'])

  // Et l ECRITURE ne touche que lui : le double resout par `booking_id`.
  const w = await purgerLeFutur(f.api, BIEN, { dryRun: false, maintenant: AUJ })
  assert.equal(w.ok, true)
  const cibles = f.ecrits.filter(e => e.table === 'bookings_snapshot').map(e => e.booking_id)
  assert.deepEqual(cibles, ['futur'], 'le sejour passe n est pas reecrit')
})

test('un sejour EN COURS compte comme du futur, et est signale comme tel', async () => {
  const f = faux({ sejours: [sejour('encours', '2026-09-09', '2026-09-12')] })
  const r = await auditPurge(f.api, BIEN, { maintenant: AUJ })
  assert.equal(r.a_annuler, 1)
  assert.equal(r.en_cours, 1)
  assert.equal(r.sejours[0].en_cours, true)
})

test('LE TEST QUI COMPTE : un depart AUJOURD HUI n est PAS neutralise', async () => {
  // Sinon `sync-menages-entite` annulait, au passage suivant, le menage de ce
  // depart — deja attribue, peut-etre en cours. La prestataire aurait vu
  // disparaitre de son planning un menage de sortie du jour.
  const f = faux({ sejours: [sejour('partaujourdhui', '2026-09-08', '2026-09-10')] })
  const r = await auditPurge(f.api, BIEN, { maintenant: AUJ })
  assert.equal(r.a_annuler, 0)
})

test('LE TEST QUI COMPTE : un BLOCAGE proprietaire futur n est PAS neutralise', async () => {
  // `lib/nuits-occupees.js` compte `confirmed` ET `blocked`. Neutraliser un
  // blocage l aurait fait cesser d occuper, et la poussee ARI aurait REMIS EN
  // VENTE les nuits que l hote s etait reservees.
  const f = faux({ sejours: [sejour('bloque', '2026-12-15', '2026-12-20', 'blocked')] })
  const r = await auditPurge(f.api, BIEN, { maintenant: AUJ })
  assert.equal(r.a_annuler, 0)
})

test('une simple DEMANDE non confirmee n est pas neutralisee non plus', async () => {
  const f = faux({ sejours: [sejour('demande', '2026-09-20', '2026-09-21', 'request')] })
  const r = await auditPurge(f.api, BIEN, { maintenant: AUJ })
  assert.equal(r.a_annuler, 0)
})

test('LE TEST QUI COMPTE : AVANT le re-keying, le geste est REFUSE', async () => {
  // Le cron */5 reecrirait le snapshot en « confirme », et le produit le lirait
  // comme un sejour neuf : menage recree et re-notifie, message d arrivee et
  // code d acces rejoues. Exactement ce que cette etape existe pour eviter.
  const f = faux({ sejours: [sejour('futur', '2026-09-20', '2026-09-21')] })
  const r = await purgerLeFutur(f.api, AVANT_REKEYING, { dryRun: false, maintenant: AUJ })
  assert.equal(r.ok, false)
  assert.equal(r.raison, 'avant_le_re_keying')
  assert.equal(f.ecrits.length, 0, 'aucune ecriture')
})

test('mais l APERCU reste possible avant le re-keying : montrer n est pas agir', async () => {
  const f = faux({ sejours: [sejour('futur', '2026-09-20', '2026-09-21')] })
  const r = await purgerLeFutur(f.api, AVANT_REKEYING, { maintenant: AUJ })
  assert.equal(r.ok, true)
  assert.equal(r.dry_run, true)
})

test('LE TEST QUI COMPTE : hors migration, l etape est SANS OBJET', async () => {
  // Sans ce repli, tout bien du compte ressortait « a faire » avec l action
  // exposee : un clic mettait son carnet futur entier en `demapped`.
  const f = faux({ sejours: [sejour('futur', '2026-09-20', '2026-09-21')] })
  const vif = { ...BIEN, migration_target_property_id: null }
  const r = await etatPurge(f.api, vif, { maintenant: AUJ })
  assert.equal(r.etat, 'sans_objet')
  assert.equal(r.action, undefined, 'aucun geste propose')
})

test('une annulation VOYAGEUR est hors sujet : on ne la retouche pas', async () => {
  // La retoucher brouillerait la trace d'une annulation reelle.
  const f = faux({ sejours: [sejour('annule', '2026-09-20', '2026-09-21', 'cancelled')] })
  const r = await auditPurge(f.api, BIEN, { maintenant: AUJ })
  assert.equal(r.a_annuler, 0)
})

test('un sejour DEJA demappe n est pas retouche non plus', async () => {
  const f = faux({ sejours: [sejour('deja', '2026-09-20', '2026-09-21', 'demapped')] })
  const r = await auditPurge(f.api, BIEN, { maintenant: AUJ })
  assert.equal(r.a_annuler, 0)
})

// ─── Le statut pose, et pourquoi il est distinct ────────────────────────────

test('LE TEST QUI COMPTE : le statut pose est `demapped`, JAMAIS `cancelled`', async () => {
  // Demande explicite de Thierry : les annulations alimentent les statistiques.
  // Ranger sous le meme mot « le voyageur s'est decommande » et « nous avons
  // debranche ce logement » aurait fausse ces chiffres pour toujours, sans
  // aucun moyen de les separer apres coup.
  const f = faux({ sejours: [sejour('futur', '2026-09-20', '2026-09-21')] })
  const r = await purgerLeFutur(f.api, BIEN, { dryRun: false, maintenant: AUJ })
  assert.equal(r.ok, true)
  const patch = f.ecrits.find(e => e.table === 'bookings_snapshot')
  assert.ok(patch, 'le snapshot est mis a jour')
  assert.equal(patch.patch.snapshot.status, 'demapped')
  assert.notEqual(patch.patch.snapshot.status, 'cancelled')
})

test('le statut d avant est GARDE : le geste se defait', async () => {
  const f = faux({ sejours: [sejour('futur', '2026-09-20', '2026-09-21')] })
  await purgerLeFutur(f.api, BIEN, { dryRun: false, maintenant: AUJ })
  const patch = f.ecrits.find(e => e.table === 'bookings_snapshot')
  assert.equal(patch.patch.snapshot.demappage.statut_avant, 'confirmed')
  assert.ok(patch.patch.snapshot.demappage.neutralise_le)
})

test('rien n est SUPPRIME : aucune destruction de ligne', async () => {
  const f = faux({ sejours: [sejour('futur', '2026-09-20', '2026-09-21')] })
  await purgerLeFutur(f.api, BIEN, { dryRun: false, maintenant: AUJ })
  assert.ok(!f.ecrits.some(e => e.patch === 'DELETE'), 'aucun delete')
  assert.ok(f.ecrits.every(e => e.patch && e.patch.snapshot), 'que des mises a jour de statut')
})

test('dry run par defaut : rien n est ecrit', async () => {
  const f = faux({ sejours: [sejour('futur', '2026-09-20', '2026-09-21')] })
  const r = await purgerLeFutur(f.api, BIEN, { maintenant: AUJ })
  assert.equal(r.dry_run, true)
  assert.equal(f.ecrits.length, 0)
})

// ─── Ce que `demapped` fait, et ne fait pas ─────────────────────────────────

test('LE TEST QUI COMPTE : `demapped` n occupe rien et ne genere pas de menage', () => {
  // C'est ce qui fait tenir toute la mecanique : `sync-menages-entite` construit
  // ses sejours « vivants » avec `isActiveStatus`, qui ne reconnait que
  // `confirmed`. Un `demapped` en sort, et son menage est annule tout seul.
  const snap = { status: 'demapped', arrival: '2026-09-20', departure: '2026-09-21' }
  assert.equal(readStatus(snap, 'beds24'), 'demapped', 'le statut est IDEMPOTENT a la relecture')
  assert.equal(isActiveStatus(snap, 'beds24'), false, 'il n occupe pas le logement')
})

test('LE TEST QUI COMPTE : `demapped` NE COMPTE PAS comme une annulation voyageur', () => {
  // Le point de Thierry, verifie par le code qui portera les statistiques.
  assert.equal(estAnnulationVoyageur({ status: 'cancelled' }, 'beds24'), true)
  assert.equal(estAnnulationVoyageur({ status: 'demapped' }, 'beds24'), false)
})

test('`demapped` survit a une relecture : il n est pas ramene a `confirmed`', () => {
  // `canonicalStatus` ramene tout statut INCONNU a `confirmed` avec un warn.
  // Sans l ajout de `demapped` aux statuts canoniques, la neutralisation se
  // serait defaite d elle-meme a la premiere relecture.
  const { canonicalStatus } = require('../lib/bookings-snapshot-status')
  assert.equal(canonicalStatus('demapped', 'beds24'), 'demapped')
  assert.equal(canonicalStatus('demapped', 'channex'), 'demapped')
})

// ─── Le refus qui protege un voyageur reel ──────────────────────────────────

test('LE TEST QUI COMPTE : un code deja pose est DIT, mais ne bloque PAS', async () => {
  // Arbitrage de Thierry : « il l'a deja, et impossible de le supprimer, donc
  // pas d'impact ». Un refus qui protege d'un risque ecarte ne protege plus
  // rien — mais ne pas bloquer n'est pas la meme chose que ne pas dire.
  const f = faux({ sejours: [sejour('encours', '2026-09-09', '2026-09-12')], codes: 1 })
  const apercu = await purgerLeFutur(f.api, BIEN, { maintenant: AUJ })
  assert.equal(apercu.ok, true)
  assert.equal(apercu.codes_deja_poses.length, 1, 'l information est rendue')
  assert.match(apercu.note, /code deja pose/)

  const r = await purgerLeFutur(f.api, BIEN, { dryRun: false, maintenant: AUJ })
  assert.equal(r.ok, true, 'et le geste passe')
  assert.ok(f.ecrits.length, 'le sejour est bien neutralise')
})

// ─── L'etat ─────────────────────────────────────────────────────────────────

test('l etat dit QUAND le faire : apres le re-keying, jamais avant', async () => {
  // Tant que le bien est chez Beds24, le cron de synchro reecrit ses snapshots
  // et remettrait « confirme » au cycle suivant, en silence.
  const f = faux({ sejours: [sejour('futur', '2026-09-20', '2026-09-21')] })
  const r = await etatPurge(f.api, BIEN, { maintenant: AUJ })
  assert.equal(r.etat, 'a_faire')
  assert.match(r.message, /APRES le re-keying/)
})

test('aucun sejour a venir : l etape est FAITE', async () => {
  const f = faux({ sejours: [sejour('vieux', '2024-02-20', '2024-02-21')] })
  const r = await etatPurge(f.api, BIEN, { maintenant: AUJ })
  assert.equal(r.etat, 'fait')
})

// ─── Les reservations DIRECTES se poursuivent ───────────────────────────────

test('LE TEST QUI COMPTE : une reservation DIRECTE a venir n est PAS neutralisee', async () => {
  // Regle de Thierry : « les reservations en direct doivent tout simplement
  // rester en base et se poursuivre ». Aucun canal ne les rendra, donc elles ne
  // peuvent pas faire doublon — et les neutraliser aurait supprime une
  // reservation VIVANTE du planning : nuits remises en vente, menage annule,
  // voyageur oublie.
  const f = faux({ sejours: [sejourDirect('directe', '2026-09-24', '2026-09-27')] })
  const r = await auditPurge(f.api, BIEN, { maintenant: AUJ })
  assert.equal(r.a_annuler, 0)
  assert.equal(r.directes_conservees.length, 1)
  assert.equal(r.directes_conservees[0].booking_id, 'directe')
})

test('LE TEST QUI COMPTE : une reservation CREEE PAR HOTESMART porte un code, et reste', async () => {
  // Le defaut de ma premiere version : le critere etait « a-t-il un code OTA ».
  // Or `api/reservation-directe.js` et `lib/moteur-creation.js` en posent un
  // (`HS-…`, `HSM-…`), et Channex les rend en `ota_name: "Offline"`. Elles
  // auraient donc ete neutralisees, contre la regle meme qu'on venait de graver.
  const f = faux({ sejours: [
    sejourDirect('crs1', '2026-09-24', '2026-09-27', 'Offline', 'HS-1788765359046-J2XC0'),
    sejourDirect('crs2', '2026-09-28', '2026-09-29', 'Offline', 'HSM-98BCBDBC8A084978')
  ] })
  const r = await auditPurge(f.api, BIEN, { maintenant: AUJ })
  assert.equal(r.a_annuler, 0, 'aucune neutralisation')
  assert.equal(r.directes_conservees.length, 2)
})

test('un import iCal n est pas rendu par CE canal : il reste aussi', async () => {
  const f = faux({ sejours: [sejourDirect('ical1', '2026-09-24', '2026-09-27', 'iCal import 1', '1785788531-6a7')] })
  const r = await auditPurge(f.api, BIEN, { maintenant: AUJ })
  assert.equal(r.a_annuler, 0)
})

test('un sejour d OTA, lui, est bien neutralise', async () => {
  const f = faux({ sejours: [sejour('airbnb1', '2026-09-20', '2026-09-21')] })
  const r = await auditPurge(f.api, BIEN, { maintenant: AUJ })
  assert.equal(r.a_annuler, 1)
  assert.equal(r.directes_conservees.length, 0)
})

test('LE TEST QUI COMPTE : une source INCONNUE est conservee, et SIGNALEE', async () => {
  // Le doute profite a la reservation vivante : ne pas neutraliser un sejour
  // d'OTA produit un doublon, visible et reparable ; neutraliser une
  // reservation vivante remet ses nuits en vente et annule son menage, en
  // silence. Mais l'inconnue doit se VOIR, sinon personne ne tranche.
  const f = faux({ sejours: [sejourDirect('mystere', '2026-09-20', '2026-09-21', 'Expedia_v2', 'XYZ')] })
  const r = await auditPurge(f.api, BIEN, { maintenant: AUJ })
  assert.equal(r.a_annuler, 0, 'conservee')
  assert.deepEqual(r.sources_inconnues, ['Expedia_v2'], 'et signalee')

  const apercu = await purgerLeFutur(f.api, BIEN, { maintenant: AUJ })
  assert.match(apercu.note, /non classee/)
})

test('les conservees sont dites PARTOUT, pas seulement en apercu', async () => {
  // Apres un passage reussi, `a_annuler` tombe a 0 : dire « aucun sejour a
  // venir » aurait fait passer les directes pour inexistantes.
  const f = faux({ sejours: [sejourDirect('directe', '2026-09-24', '2026-09-27')] })

  const apercu = await purgerLeFutur(f.api, BIEN, { maintenant: AUJ })
  assert.match(apercu.note, /se poursuivent/)
  assert.match(apercu.note, /2026-09-24→2026-09-27/)

  const etat = await etatPurge(f.api, BIEN, { maintenant: AUJ })
  assert.equal(etat.etat, 'fait')
  assert.match(etat.message, /se poursuivent/, 'l etat aussi')
  assert.ok(!/Aucun sejour a venir/.test(etat.message), 'et il ne dit plus « aucun sejour a venir »')
})

test('une directe VIVANTE n est pas comptee comme « hors jeu »', async () => {
  // `hors_jeu_au_futur` veut dire « deja annule ou demappe » : y ranger une
  // reservation reelle faisait annoncer « 1 hors jeu » pour un sejour bien vivant.
  const f = faux({ sejours: [sejourDirect('directe', '2026-09-24', '2026-09-27')] })
  const r = await auditPurge(f.api, BIEN, { maintenant: AUJ })
  assert.equal(r.hors_jeu_au_futur, 0)
  assert.equal(r.directes_conservees.length, 1)
})
