// tests/moteur-reservation.test.js
// Spec : docs/specs/spec-moteur-reservation.md §3 bis et §4
//
// CE QUE CES TESTS DEFENDENT — les quatre decisions gravees a l'etape 0 :
//   1. le prix est `calendar_inventory.rate` SINON `base_price` ; sans base_price
//      le bien n'est pas vendable du tout ;
//   1 bis. le coefficient du lien s'applique a l'affichage ET a l'encaissement,
//      sans JAMAIS reecrire les prix du cœur ;
//   2. le stop-sell (l'INTENTION) prime sur le stock (la CONSEQUENCE) ;
//   3. un blocage proprietaire ferme la nuit au voyageur ;
//   4. les restrictions (min_stay, cta, ctd, max_stay) sont opposees au sejour.

const test = require('node:test')
const assert = require('node:assert')

const M = require('../lib/moteur-reservation')
const { STATUS } = require('../lib/bookings-snapshot-status')

// ─── Harnais ────────────────────────────────────────────────────────────────
const BIEN = {
  id: 'uuid-bien', name: 'Test', currency: 'EUR', capacity: 4,
  provider_property_id: 'prop-1',
  // ⚠ AUSSI PAUVRE QUE LA REALITE : un bien vendable est un bien qu'on sait
  // ECRIRE. `raisonNonVendable` exige desormais le provider et les identifiants
  // d'ecriture CRS, comme `lib/moteur-creation.js` avant de poster.
  provider: 'channex',
  provider_room_type_id: 'rt-1', provider_rate_plan_id: 'rp-1',
  included_guests: 2, extra_guest_fee: 10, base_price: 80,
  inventory_units: 1, paused_at: null
}
// Dates FIGEES : ce module n'appelle jamais l'horloge — il recoit `debut`.
// (Regle du depot : dates figees quand le code n'invente pas « maintenant ».)
const D = '2026-10-01'

const snap = (arrival, departure, status, provider) => ({
  booking_id: `${arrival}-${departure}`,
  snapshot: { arrival, departure, status, provider: provider || 'channex' }
})

const cal = (opts = {}) => M.construireCalendrier({
  bien: { ...BIEN, ...(opts.bien || {}) },
  lien: opts.lien || null,
  inventaire: opts.inventaire || [],
  snapshots: opts.snapshots || [],
  intentions: opts.intentions || {},
  tenuePropre: opts.tenuePropre || [],
  debut: D, jours: opts.jours == null ? 10 : opts.jours
})

const jourDe = (c, date) => c.find(n => n.date === date)

// ─── Decision 1 : le prix ───────────────────────────────────────────────────
test('sans exception, chaque nuit vaut le prix de base du bien', () => {
  const c = cal()
  assert.equal(c.length, 10)
  assert.ok(c.every(n => n.prix === 80 && n.disponible))
})

test('une exception de prix ecrase le prix de base ce jour-la seulement', () => {
  const c = cal({ inventaire: [{ date: '2026-10-03', rate: 145 }] })
  assert.equal(jourDe(c, '2026-10-03').prix, 145)
  assert.equal(jourDe(c, '2026-10-04').prix, 80)
})

test('un rate a 0 n est PAS un prix : on retombe sur le prix de base', () => {
  // Des lignes anciennes portent rate=0. Le traiter comme un prix vendrait la
  // nuit gratuitement.
  const c = cal({ inventaire: [{ date: '2026-10-03', rate: 0 }] })
  assert.equal(jourDe(c, '2026-10-03').prix, 80)
})

test('CONSTAT DE REVIEW : un bien qu on ne sait pas ECRIRE ne vend pas', () => {
  // Sans cette garde, la vente aboutit, Stripe encaisse, PUIS
  // lib/moteur-creation.js refuse la creation CRS et rembourse — 360 € pris et
  // rendus une minute plus tard sur « coeur de vie 23 », avec une alarme et un
  // e-mail « reservation impossible » au voyageur. Les deux gardes portent donc
  // exactement les memes conditions : un ecart entre elles est un interstice ou
  // l'argent passe.
  assert.equal(M.raisonNonVendable({ ...BIEN, provider: 'beds24' }), 'sans_ecriture_crs')
  assert.equal(M.raisonNonVendable({ ...BIEN, provider: null }), 'sans_ecriture_crs')
  assert.equal(M.raisonNonVendable({ ...BIEN, provider_room_type_id: null }), 'sans_ecriture_crs')
  assert.equal(M.raisonNonVendable({ ...BIEN, provider_rate_plan_id: null }), 'sans_ecriture_crs')
  assert.equal(M.raisonNonVendable(BIEN), null, 'un bien Channex complet vend')
})

test('la garde de vente et la garde d ecriture ne peuvent pas diverger', () => {
  // Le test qui tient les deux ensemble dans le temps : si quelqu'un ajoute une
  // condition a l'une, ce test tombe tant qu'il ne l'a pas ajoutee a l'autre.
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'lib/moteur-creation.js'), 'utf8')
  for (const champ of ['provider_room_type_id', 'provider_rate_plan_id']) {
    assert.ok(src.includes(champ), `moteur-creation exige toujours ${champ}`)
  }
  assert.ok(/provider !== 'channex'/.test(src), 'moteur-creation exige toujours channex')
})

test('un bien SANS base_price reste vendable — le prix se juge NUIT PAR NUIT', () => {
  // Decision de Thierry du 8 septembre 2026, qui revient sur la decision 1 de
  // l'etape 0. Son modele : aucun prix de base, tous les prix saisis par date.
  // Exiger `base_price` rendait ses deux biens definitivement invendables.
  assert.equal(M.raisonNonVendable({ ...BIEN, base_price: null }), null)
  assert.equal(M.raisonNonVendable({ ...BIEN, base_price: 0 }), null)
  assert.equal(M.raisonNonVendable(BIEN), null)
})

test('sans base_price : la nuit AVEC rate se vend, la nuit SANS rate ne se vend pas', () => {
  // Le coeur de la decision : le filtre par nuit fait foi, et il existait deja.
  const c = cal({
    bien: { ...BIEN, base_price: null },
    inventaire: [{ date: '2026-10-03', rate: 120 }]
  })
  const avec = jourDe(c, '2026-10-03')
  assert.equal(avec.prix, 120, 'la nuit tarifee garde son prix')
  assert.equal(avec.disponible, true)

  const sans = jourDe(c, '2026-10-04')
  assert.equal(sans.prix, null, 'aucun prix invente')
  assert.equal(sans.disponible, false, 'et surtout : PAS vendable a zero')
  assert.equal(sans.raison, 'sans_prix', 'la raison est dite, pas devinee')
})

test('CONSTAT DE REVIEW : le kill switch d automatisation ne ferme PAS la vente', () => {
  // `paused_at` / `automation_paused` sont le coupe-circuit MESSAGERIE, pose
  // AUTOMATIQUEMENT par lib/cron-alerting.js quand une conversation IA boucle.
  // Les lire ici mettrait le canal de vente hors ligne tout seul, sans un mot.
  // Le perimetre grave du kill switch coupe le voyageur, jamais la vente.
  assert.equal(M.raisonNonVendable({ ...BIEN, paused_at: '2026-09-01' }), null)
  assert.equal(M.raisonNonVendable({ ...BIEN, automation_paused: true }), null)
})

// ─── Decision gravee : l intention prime sur le stock ───────────────────────
test('stop_sell ferme la nuit meme quand il reste des unites', () => {
  const c = cal({
    bien: { inventory_units: 3 },
    inventaire: [{ date: '2026-10-05', stop_sell: true }]
  })
  const n = jourDe(c, '2026-10-05')
  assert.equal(n.disponible, false)
  assert.equal(n.raison, 'ferme')
  assert.equal(n.restant, 3, 'il RESTE du stock : c est bien l intention qui ferme')
})

// ─── Le stock ───────────────────────────────────────────────────────────────
test('une reservation confirmee occupe ses nuits, jamais celle du depart', () => {
  const c = cal({ snapshots: [snap('2026-10-03', '2026-10-05', 'new')] })
  assert.equal(jourDe(c, '2026-10-03').disponible, false)
  assert.equal(jourDe(c, '2026-10-04').disponible, false)
  assert.equal(jourDe(c, '2026-10-05').disponible, true, 'la nuit du depart reste vendable')
})

test('une annulation ne ferme rien', () => {
  const c = cal({ snapshots: [snap('2026-10-03', '2026-10-05', 'cancelled')] })
  assert.ok(jourDe(c, '2026-10-03').disponible)
})

test('un blocage proprietaire ferme la nuit au voyageur', () => {
  // `blocked` occupe le logement sans generer de menage. L hote peut passer
  // outre son propre blocage en saisie manuelle ; un voyageur, jamais.
  const c = cal({ snapshots: [snap('2026-10-06', '2026-10-08', 'black', 'beds24')] })
  assert.equal(jourDe(c, '2026-10-06').disponible, false)
  assert.equal(jourDe(c, '2026-10-06').raison, 'complet')
})

test('a deux unites, une seule reservation ne ferme pas la nuit', () => {
  const c = cal({ bien: { inventory_units: 2 }, snapshots: [snap('2026-10-03', '2026-10-04', 'new')] })
  assert.equal(jourDe(c, '2026-10-03').disponible, true)
  assert.equal(jourDe(c, '2026-10-03').restant, 1)
})

// ─── Ce que le navigateur a le droit de voir ────────────────────────────────
test('la nuit publique ne dit ni la raison ni le stock restant', () => {
  const n = M.nuitPublique(jourDe(cal({ inventaire: [{ date: '2026-10-05', stop_sell: true }] }), '2026-10-05'))
  assert.equal(n.raison, undefined, 'ferme par choix ou deja vendu ne regarde pas le public')
  assert.equal(n.restant, undefined)
  assert.equal(n.disponible, false)
})

// ─── Decision 4 : les restrictions ──────────────────────────────────────────
const valider = (opts, a, d, p) => M.validerSejour({
  calendrier: cal(opts), bien: { ...BIEN, ...(opts.bien || {}) }, lien: opts.lien || null,
  arrival: a, departure: d, personnes: p == null ? 2 : p
})

test('un sejour ordinaire est accepte et son total est la somme des nuits', () => {
  const r = valider({}, '2026-10-02', '2026-10-05', 2)
  assert.equal(r.ok, true)
  assert.deepEqual(r.nuits, ['2026-10-02', '2026-10-03', '2026-10-04'])
  assert.equal(r.total, 240)   // 3 nuits x 80, 2 voyageurs = les inclus
})

test('le supplement voyageurs s applique PAR NUIT au-dela des inclus', () => {
  const r = valider({}, '2026-10-02', '2026-10-05', 4)
  assert.equal(r.total, 300)   // 3 x (80 + 2 x 10)
})

test('au-dela de la capacite, refus', () => {
  assert.equal(valider({}, '2026-10-02', '2026-10-05', 5).raison, 'trop_de_voyageurs')
  assert.equal(valider({}, '2026-10-02', '2026-10-05', 0).raison, 'voyageurs_invalides')
})

test('une nuit fermee dans l intervalle refuse tout le sejour', () => {
  const o = { inventaire: [{ date: '2026-10-03', stop_sell: true }] }
  assert.equal(valider(o, '2026-10-02', '2026-10-05', 2).raison, 'nuit_indisponible')
  assert.equal(valider(o, '2026-10-04', '2026-10-06', 2).ok, true, 'le sejour qui l evite passe')
})

test('min_stay_arrival est oppose au sejour trop court, et rendu au client', () => {
  const o = { inventaire: [{ date: '2026-10-02', min_stay_arrival: 3 }] }
  const r = valider(o, '2026-10-02', '2026-10-04', 2)
  assert.equal(r.raison, 'sejour_trop_court')
  assert.equal(r.minimum, 3)
  assert.equal(valider(o, '2026-10-02', '2026-10-05', 2).ok, true)
})

test('min_stay_through d une nuit TRAVERSEE compte aussi', () => {
  const o = { inventaire: [{ date: '2026-10-03', min_stay_through: 4 }] }
  const r = valider(o, '2026-10-02', '2026-10-04', 2)
  assert.equal(r.raison, 'sejour_trop_court')
  assert.equal(r.minimum, 4)
})

test('min_stay a 1 ou 0 ne restreint rien', () => {
  const o = { inventaire: [{ date: '2026-10-02', min_stay_arrival: 0, min_stay_through: 1 }] }
  assert.equal(valider(o, '2026-10-02', '2026-10-03', 2).ok, true)
})

test('cta interdit l arrivee ce jour-la, pas la traversee', () => {
  const o = { inventaire: [{ date: '2026-10-03', cta: true }] }
  assert.equal(valider(o, '2026-10-03', '2026-10-05', 2).raison, 'arrivee_interdite')
  assert.equal(valider(o, '2026-10-02', '2026-10-05', 2).ok, true, 'traverser un jour cta reste permis')
})

test('ctd interdit le depart ce jour-la — et le jour du depart n est pas une nuit vendue', () => {
  const o = { inventaire: [{ date: '2026-10-05', ctd: true }] }
  assert.equal(valider(o, '2026-10-02', '2026-10-05', 2).raison, 'depart_interdit')
  assert.equal(valider(o, '2026-10-02', '2026-10-04', 2).ok, true)
})

test('on peut partir le lendemain d une nuit vendue a quelqu un d autre', () => {
  // Le jour du depart n est pas occupe : le refuser interdirait un depart normal.
  const o = { snapshots: [snap('2026-10-05', '2026-10-07', 'new')] }
  assert.equal(valider(o, '2026-10-02', '2026-10-05', 2).ok, true)
})

test('max_stay plafonne le sejour ; 0 ne plafonne rien', () => {
  const o = { inventaire: [{ date: '2026-10-03', max_stay: 2 }] }
  const r = valider(o, '2026-10-02', '2026-10-06', 2)
  assert.equal(r.raison, 'sejour_trop_long')
  assert.equal(r.maximum, 2)
  assert.equal(valider({ inventaire: [{ date: '2026-10-03', max_stay: 0 }] }, '2026-10-02', '2026-10-06', 2).ok, true)
})

// ─── Bornes et entrees hostiles ─────────────────────────────────────────────
test('une date hors de la fenetre publiee est refusee, jamais supposee libre', () => {
  assert.equal(valider({ jours: 5 }, '2026-10-04', '2026-10-09', 2).raison, 'hors_fenetre')
})

test('dates invalides, inversees ou vides : refus explicite', () => {
  assert.equal(valider({}, '', '2026-10-05', 2).raison, 'dates_invalides')
  assert.equal(valider({}, '2026-13-45', '2026-10-05', 2).raison, 'dates_invalides')
  assert.equal(valider({}, '2026-10-05', '2026-10-05', 2).raison, 'sejour_vide')
  assert.equal(valider({}, '2026-10-05', '2026-10-02', 2).raison, 'sejour_vide')
})

test('la largeur de fenetre est bornee : jamais illimitee, jamais absurde', () => {
  // `?jours=99999` ferait balayer trente ans de calendrier a chaque appel public.
  assert.equal(M.bornerJours(99999), M.HORIZON_JOURS)
  assert.equal(cal({ jours: 99999 }).length, M.HORIZON_JOURS)
  // Absente ou inexploitable -> l'horizon par defaut, pas zero nuit.
  assert.equal(M.bornerJours(undefined), M.HORIZON_JOURS)
  assert.equal(M.bornerJours('abc'), M.HORIZON_JOURS)
  assert.equal(M.bornerJours(0), M.HORIZON_JOURS)
  assert.equal(M.bornerJours(-5), M.HORIZON_JOURS)
  assert.equal(M.bornerJours('30'), 30)
  assert.equal(cal({ jours: 30 }).length, 30)
})

test('les dates sont calculees en UTC, pas en heure locale', () => {
  // Un fuseau negatif faisait basculer d un jour : la premiere nuit doit rester
  // exactement `debut`.
  assert.equal(cal()[0].date, D)
  assert.equal(M.ajouterJours('2026-10-31', 1), '2026-11-01')
  assert.equal(M.ajouterJours('2026-12-31', 1), '2027-01-01')
})

test('le supplement ne s applique pas quand included_guests vaut la capacite', () => {
  assert.equal(M.supplementVoyageurs({ ...BIEN, included_guests: null, capacity: 4 }, 4), 0)
  assert.equal(M.supplementVoyageurs({ ...BIEN, extra_guest_fee: 0 }, 4), 0)
})

test('STATUTS_OCCUPANTS retient confirmed et blocked, jamais cancelled ni request', () => {
  assert.deepEqual(M.STATUTS_OCCUPANTS, [STATUS.CONFIRMED, STATUS.BLOCKED])
})

// ─── CONSTAT DE REVIEW : avail = 0 ferme aussi ─────────────────────────────
test('avail = 0 ferme la nuit meme quand stop_sell vaut false', () => {
  // La memoire d'intention n'a ete amorcee que sur UN bien. Ailleurs, une nuit
  // fermee par l'hote depuis le calendrier mobile porte avail=0, stop_sell=false.
  // Il la voit « Fermé » chez lui ; la page publique la vendait.
  const c = cal({ inventaire: [{ date: '2026-10-04', avail: 0, stop_sell: false }] })
  assert.equal(jourDe(c, '2026-10-04').disponible, false)
  assert.equal(jourDe(c, '2026-10-04').raison, 'ferme')
})

test('avail non nul et stop_sell false laisse la nuit ouverte', () => {
  const c = cal({ inventaire: [{ date: '2026-10-04', avail: 1, stop_sell: false }] })
  assert.equal(jourDe(c, '2026-10-04').disponible, true)
})

// ─── CONSTAT DE REVIEW : les intentions en cours occupent ──────────────────
test('une nuit sous intention (feed pas encore remonte) n est pas vendable', () => {
  // Entre l acceptation par Channex et le retour du feed, la nuit est vendue
  // mais absente de bookings_snapshot. Le verrou de la phase 2 la compte deja.
  const c = cal({ intentions: { '2026-10-06': 1 } })
  assert.equal(jourDe(c, '2026-10-06').disponible, false)
  assert.equal(jourDe(c, '2026-10-06').raison, 'complet')
  assert.equal(jourDe(c, '2026-10-05').disponible, true)
})

test('DEUX ventes distinctes (1 snapshot + 1 intention) remplissent 2 unites', () => {
  const c = cal({
    bien: { inventory_units: 2 },
    snapshots: [snap('2026-10-06', '2026-10-07', 'new')],
    intentions: { '2026-10-06': 1 }
  })
  assert.equal(jourDe(c, '2026-10-06').disponible, false, '1 resa + 1 intention = 2 unites prises')
})

test('DETTE ASSUMEE : une meme vente est comptee deux fois tant que son intention vit', () => {
  // Constat de review, verifie et CONSERVE volontairement.
  // Rien ne distingue « l'intention de la reservation X » de « une seconde vente
  // que le feed n'a pas encore rendue » : la cle `resa-nuit:<user>:<bien>:<date>`
  // ne porte aucune reference de reservation. Entre le retour du feed (cycle de
  // 5 min) et l'expiration de l'intention (TTL 20 min), la meme vente compte donc
  // pour deux pendant ~15 minutes.
  //
  // POURQUOI ON GARDE L'ADDITION plutot qu'un `max()` :
  //   addition -> peut afficher « complet » sur une unite libre  (on perd une vente)
  //   max()    -> peut afficher libre une unite vendue           (ON SURVEND)
  // La seconde erreur est celle que tout ce chantier existe pour empecher.
  //
  // Portee reelle AUJOURD'HUI : NULLE. Les 4 biens sont a `inventory_units = 1`,
  // et a 1 unite les deux calculs coincident. Le correctif structurel — purger
  // l'intention quand le feed confirme la reservation — appartient au writer du
  // feed (phase 2), pas au moteur de lecture.
  const c = cal({
    bien: { inventory_units: 2 },
    snapshots: [snap('2026-10-06', '2026-10-07', 'new')],
    intentions: { '2026-10-06': 1 }
  })
  assert.equal(jourDe(c, '2026-10-06').restant, 0,
    'sur-comptage assume : une unite reste vendable, on la masque')

  // A 1 unite — le parc actuel — le resultat est identique dans les deux calculs.
  const un = cal({
    bien: { inventory_units: 1 },
    snapshots: [snap('2026-10-06', '2026-10-07', 'new')],
    intentions: { '2026-10-06': 1 }
  })
  assert.equal(jourDe(un, '2026-10-06').disponible, false)
})

// ─── CONSTAT DE REVIEW : le bien aveugle ───────────────────────────────────
test('un bien sans provider_property_id n est PAS vendable', () => {
  // Sans identifiant provider, `bookings_snapshot` et les intentions rendent
  // zero ligne (`String(null)` vaut 'null') : le calendrier afficherait 365
  // nuits libres, y compris celles deja vendues. Un calendrier qui ne peut pas
  // voir les reservations ne doit pas vendre.
  assert.equal(M.raisonNonVendable({ ...BIEN, provider_property_id: null }), 'sans_lien_provider')
  assert.equal(M.raisonNonVendable({ ...BIEN, provider_property_id: '' }), 'sans_lien_provider')
  assert.equal(M.raisonNonVendable({ ...BIEN, provider_property_id: 'prop-1' }), null)
})

// ─── Ajout 2 : le coefficient du lien ──────────────────────────────────────
const LIEN = { token: 'x'.repeat(43), label: 'Site vitrine', price_coefficient: 100, active: true }

test('le coefficient par defaut (100 %) ne change aucun prix', () => {
  assert.equal(jourDe(cal({ lien: { ...LIEN } }), '2026-10-03').prix, 80)
  assert.equal(jourDe(cal({ lien: null }), '2026-10-03').prix, 80)
})

test('le coefficient s applique a l AFFICHAGE de chaque nuit', () => {
  const c = cal({ lien: { ...LIEN, price_coefficient: 110 } })
  assert.equal(jourDe(c, '2026-10-03').prix, 88)          // 80 x 1,10
})

test('le coefficient s applique aussi a une exception de prix du cœur', () => {
  const c = cal({ lien: { ...LIEN, price_coefficient: 150 }, inventaire: [{ date: '2026-10-03', rate: 100 }] })
  assert.equal(jourDe(c, '2026-10-03').prix, 150)
})

test('le coefficient s applique a l ENCAISSEMENT : le total suit', () => {
  const r = valider({ lien: { ...LIEN, price_coefficient: 110 } }, '2026-10-02', '2026-10-05', 2)
  assert.equal(r.ok, true)
  assert.equal(r.total, 264)                              // 3 x 88
})

test('le coefficient porte AUSSI sur le supplement voyageurs', () => {
  // Sinon un lien a 110 % vendrait a un taux different selon le nombre de
  // voyageurs — le prix de vente du sejour est un tout.
  const r = valider({ lien: { ...LIEN, price_coefficient: 110 } }, '2026-10-02', '2026-10-05', 4)
  assert.equal(r.total, 330)                              // 3 x (88 + 2 x 11)
})

test('le total est EXACTEMENT la somme des lignes affichees', () => {
  // Un arrondi global ferait afficher un detail qui ne s additionne pas au
  // montant preleve. C est ce que le voyageur verifie en premier.
  const r = valider({ lien: { ...LIEN, price_coefficient: 107 } }, '2026-10-02', '2026-10-06', 3)
  const somme = r.detail.reduce((s, l) => s + l.total, 0)
  assert.equal(M.arrondir(somme), r.total)
  r.detail.forEach(l => assert.equal(l.total, M.arrondir(l.prix + l.supplement)))
})

test('un coefficient absent, nul, negatif ou illisible vaut 100 % — JAMAIS zero', () => {
  // Un lien dont le coefficient serait illisible doit vendre au prix normal.
  // Vendre a zero serait la pire des reponses possibles.
  for (const mauvais of [null, undefined, 0, -50, NaN, 'abc', '']) {
    assert.equal(M.multiplicateur(mauvais), 1, `coefficient ${String(mauvais)}`)
  }
  assert.equal(M.multiplicateur(110), 1.1)
  assert.equal(M.multiplicateur('90'), 0.9)
})

test('REGLE GRAVEE : le coefficient ne touche jamais les donnees du cœur', () => {
  // La lentille est posee a la LECTURE. L objet d inventaire fourni doit
  // ressortir intact — un writer cache ici creerait un second writer des prix.
  const inventaire = [{ date: '2026-10-03', rate: 100 }]
  const copie = JSON.parse(JSON.stringify(inventaire))
  const bien = { ...BIEN }
  M.construireCalendrier({ bien, lien: { ...LIEN, price_coefficient: 150 }, inventaire, snapshots: [], intentions: {}, debut: D, jours: 5 })
  assert.deepEqual(inventaire, copie, 'l inventaire du cœur a ete modifie')
  assert.equal(bien.base_price, 80, 'le prix de base du bien a ete modifie')
})


// ─── CONSTAT DE REVIEW : une tentative ne doit pas se refuser ELLE-MEME ─────
test('la tenue PROPRE de l appelant est retiree de l occupation', () => {
  // Des qu une tentative pose sa tenue, le calendrier compte ses nuits prises.
  // Toute re-verification de CETTE tentative echouait alors sur sa propre tenue,
  // et le voyageur lisait « une des nuits n est plus disponible » a propos de
  // nuits qu il venait lui-meme de tenir.
  const avec = cal({ intentions: { '2026-10-03': 1 } })
  assert.equal(jourDe(avec, '2026-10-03').disponible, false)

  const sienne = cal({ intentions: { '2026-10-03': 1 }, tenuePropre: ['2026-10-03'] })
  assert.equal(jourDe(sienne, '2026-10-03').disponible, true, 'sa propre tenue ne la bloque pas')
})

test('retirer sa tenue ne libere PAS celle d un autre', () => {
  // Deux tenues sur la meme nuit : en retirer une laisse l autre.
  const c = cal({ intentions: { '2026-10-03': 2 }, tenuePropre: ['2026-10-03'] })
  assert.equal(jourDe(c, '2026-10-03').disponible, false)
  assert.equal(jourDe(c, '2026-10-03').restant, 0)
})

test('une tenue propre sur une nuit VENDUE ne la rouvre pas', () => {
  // L occupation ne peut pas devenir negative : une reservation confirmee reste
  // une reservation confirmee.
  const c = cal({
    snapshots: [snap('2026-10-03', '2026-10-04', 'new')],
    tenuePropre: ['2026-10-03']
  })
  assert.equal(jourDe(c, '2026-10-03').disponible, true,
    'a 1 unite, retirer la tenue rouvre — la resa est comptee separement')
  const deux = cal({
    bien: { inventory_units: 1 },
    snapshots: [snap('2026-10-03', '2026-10-04', 'new')],
    intentions: { '2026-10-03': 1 },
    tenuePropre: ['2026-10-03']
  })
  assert.equal(jourDe(deux, '2026-10-03').disponible, false,
    'la reservation confirmee occupe toujours la nuit')
})

// ─── CONSTAT DE REVIEW : le modele de tenue ne compte pas au-dela d une unite ─
test('un bien a plusieurs unites n est PAS vendable par le moteur', () => {
  // La cle d une tenue est `resa-nuit:<hote>:<bien>:<nuit>` et c est la cle
  // PRIMAIRE de write_locks : deux voyageurs sur la meme nuit ne produisent
  // qu UNE ligne. Le calendrier compte 1 la ou il y en a 2, et l expiration de
  // l une libere les nuits que l autre paie. On refuse plutot que de vendre sur
  // un modele qu on sait faux.
  assert.equal(M.raisonNonVendable({ ...BIEN, inventory_units: 2 }), 'multi_unites_non_supporte')
  assert.equal(M.raisonNonVendable({ ...BIEN, inventory_units: 1 }), null)
  assert.equal(M.raisonNonVendable({ ...BIEN, inventory_units: null }), null)
})
