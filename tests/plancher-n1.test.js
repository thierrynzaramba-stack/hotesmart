// tests/plancher-n1.test.js — lot V2.0.8, point B (23 septembre 2026).
//
// LE DEFAUT QU'ILS EMPECHENT : une nuit affichee MOINS CHER que ce que sa nuit
// comparable a obtenu l'an dernier. Sur La bulle, 51 nuits ; le reveillon 2026
// a 155 € quand le 31/12/2025 s'etait vendu 257 €.
//
// CE QU'ILS DEFENDENT (arbitrages de Thierry) :
//   1. au moins le prix prouve l'an dernier, a TOUS les niveaux — memes
//      conditions que la fourchette (meme segment, nuit passee, hors reference
//      ecartee, deux pas d'ecart, arrondi au pas superieur, retrait par la
//      pression) ;
//   2. LE TYPE DE NUIT, option b′ : la preuve vient d'un jour qui se vend au
//      MEME niveau ou MOINS BIEN dans la structure hors vacances du bien — egal
//      accepte, strictement superieur refuse (« le plancher est un plancher ») ;
//   3. le plafond BORNE le cliquet ; sans plafond, le haut de la grille ;
//   4. le niveau affiche suit le prix ; la preuve d'un autre jour se DIT.
//
// CONTRE-EPREUVE (REVIEW.md regle 19) — refaite en review, chiffres corriges :
//   - contre la version (b) STRICTE (egalite exigee) : 1 rouge, « jeudi →
//     vendredi » — c'est la seule difference entre b et b′ (l'egalite est
//     acceptee par les deux) ;
//   - contre une version « meme jour de semaine exige » : « jeudi → vendredi »
//     et « meme niveau » rougissent ;
//   - contre une version SANS condition de jour (option a) : les refus
//     rougissent (samedi → dimanche, fourchette, jour non mesure) ;
//   - contre le repli global fautif (avant la review) : « jour non mesure »
//     rougit ;
//   - contre le code d'avant le point B (fourchette seule) : les tests de
//     relevement rougissent.
// Chaque test rougit donc contre au moins une version fautive plausible.
// Arbitrages d'apres la review : « delai » et « reglage qui BAISSE » rougissent
// contre 487aef0 ; « reglage qui MONTE » decrit un comportement deja juste (point
// de verification de Thierry) et rougit contre un plancher NAIF qui pose la
// preuve meme plus basse.

const test = require('node:test')
const assert = require('node:assert')
const S = require('../lib/yield/suggestion')
const R = require('../lib/yield/reference')

const NIVEAUX = [115, 125, 140, 155, 165]
// Structure hors vacances du bien de test : dimanche, mercredi, jeudi Base,
// vendredi Haut, samedi Exceptionnel — CHAQUE jour avec sa position PROPRE dans
// `positions_jour`. ⚠ La premiere version n'en posait que deux (vendredi,
// samedi) et annoncait les autres « lus par positions_jour » : ils passaient par
// le repli global, que la review a trouve fautif — le jeu d'essai figeait le
// defaut (regle 17). Le mardi, lui, n'a PAS de position propre : jour non mesure.
function grille ({ plafond = 255, plafondBrut = 257, jours = null } = {}) {
  const niveaux = S.NIVEAUX.map((n, i) => ({ ...n, prix: NIVEAUX[i], prix_mesure: NIVEAUX[i], etire: false }))
  const pos = indice => ({ fiable: true, indice, niveau: niveaux[indice].nom, crans: 0, echantillon: 40, reservations: 20, mediane: NIVEAUX[indice] })
  return {
    base: { fiable: true, echantillon: 854, reservations: 400, niveaux, min: 35, max: 295, plafond, plafond_brut: plafondBrut },
    positions: new Map([['hors_vacances', { ...pos(0), crans: 0 }]]),
    positions_jour: new Map(Object.entries(jours || { dimanche: 0, mercredi: 0, jeudi: 0, vendredi: 2, samedi: 4 })
      .map(([j, i]) => [`hors_vacances|${j}`, pos(i)]))
  }
}
// Le jeu d'essai se verifie par assertion (regle 19, point 4).
for (const j of ['dimanche', 'mercredi', 'jeudi', 'vendredi', 'samedi']) {
  assert.ok(grille().positions_jour.get(`hors_vacances|${j}`).fiable, `jeu d essai : ${j} mesure`)
}
assert.equal(grille().positions_jour.get('hors_vacances|mardi'), undefined, 'jeu d essai : mardi NON mesure')
const CTX = R.construireContexte({ zoneBien: 'C', vacances: [], debut: '2025-01-01', fin: '2027-12-31' })
const JOUR = { dimanche: '2026-11-22', mercredi: '2026-11-18', jeudi: '2026-11-19', vendredi: '2026-11-20' }
for (const [j, d] of Object.entries(JOUR)) {
  assert.equal(R.segmenterJour(d, CTX).segment, 'hors_vacances', `jeu d essai : ${d} hors vacances`)
  assert.equal(R.jourDeSemaine(d), j)
}
// Des preuves N-1 posees un jour de semaine choisi.
const PREUVE = { samedi: '2025-11-22', jeudi: '2025-11-20', mardi: '2025-11-18' }
for (const [j, d] of Object.entries(PREUVE)) assert.equal(R.jourDeSemaine(d), j)
const preuve = (jour, prix, extra = {}) => ({ date: PREUVE[jour], prix, ventes: 1, meme_segment: true, hors_reference: false, ...extra })
const nuit = (date, opts = {}) => S.suggerer({ date, grille: grille(opts.g), contexte: CTX, ouverte: true,
  delaiJours: 30, bien: { prix_minimum: 1 }, ...opts })

test('LE TEST QUI COMPTE : samedi vers dimanche — REFUSE (la preuve surestimerait)', () => {
  const s = nuit(JOUR.dimanche, { preuveN1: preuve('samedi', 250) })
  assert.equal(s.niveau, 'Base')
  assert.equal(s.prix, 115, 'un samedi (Exceptionnel chez ce bien) ne prouve rien pour un dimanche (Base)')
  assert.equal(s.releve_n1, undefined)
})

test('LE TEST QUI COMPTE : jeudi vers vendredi — ACCEPTE, et dit « minimum prudent »', () => {
  const s = nuit(JOUR.vendredi, { preuveN1: preuve('jeudi', 190) })
  assert.equal(s.prix, 190, 'un jeudi (Base) vendu 190 € prouve au moins 190 € pour un vendredi (Haut)')
  assert.equal(s.niveau_effectif, 'Exceptionnel', 'le niveau affiche suit le prix')
  assert.equal(s.niveau, 'Haut', 'le niveau du pipeline reste le sien (niveau_choisi)')
  assert.equal(s.deplacement_effectif, 2, 'le deplacement effectif suit le prix (Haut → Exceptionnel)')
  assert.ok(s.fourchette.max >= s.prix, 'le contrat fourchette.max ne ment pas')
  assert.equal(s.releve_n1.niveau_avant, 'Haut')
  assert.equal(s.releve_n1.resume, 'Relevé à 190 € — prix obtenu le jeudi 20/11/2025 sur la nuit comparable'
    + ' (Haut → Exceptionnel) ; un jeudi se vend au niveau Base, un vendredi au niveau Haut : ce prix est donc un minimum prudent')
  assert.equal(s.releve_n1.preuve_autre_jour.prudent, true)
})

test('LE TEST QUI COMPTE : meme niveau — ACCEPTE (deux jours au meme niveau se prouvent l un l autre)', () => {
  const s = nuit(JOUR.mercredi, { preuveN1: preuve('jeudi', 150) })
  assert.equal(s.prix, 150)
  assert.match(s.releve_n1.resume, /; jeudi et mercredi se vendent au même niveau chez vous \(Base\)$/)
  assert.equal(s.releve_n1.preuve_autre_jour.prudent, false)
})

test('LE TEST QUI COMPTE : un jour NON MESURE refuse la preuve — « je ne sais pas » n est pas « oui »', () => {
  // Review du point B : sans position propre, deux jours recevaient la meme
  // position globale et « samedi et dimanche se vendent au meme niveau »
  // s'affirmait sans mesure. Ici : preuve un mardi (non mesure) pour un jeudi.
  const s = nuit(JOUR.jeudi, { preuveN1: { date: PREUVE.mardi, prix: 200, ventes: 1, meme_segment: true } })
  assert.equal(s.prix, 115)
  assert.equal(s.releve_n1, undefined)
  // Et un bien SANS aucune mesure par jour : samedi → dimanche refuse aussi.
  const maigre = nuit(JOUR.dimanche, { g: { jours: {} }, preuveN1: preuve('samedi', 250) })
  assert.equal(maigre.prix, 115, 'bien maigre : la b′ ne redevient pas l option a')
  // Meme jour de semaine : pas besoin de mesure, la preuve vaut.
  assert.equal(nuit(JOUR.jeudi, { g: { jours: {} }, preuveN1: preuve('jeudi', 150) }).prix, 150)
})

test('meme jour de semaine : aucune mention d un autre jour', () => {
  const s = nuit(JOUR.jeudi, { preuveN1: preuve('jeudi', 150) })
  assert.equal(s.prix, 150)
  assert.equal(s.releve_n1.preuve_autre_jour, null)
  assert.equal(s.releve_n1.resume, 'Relevé à 150 € — prix obtenu le 20/11/2025 sur la nuit comparable (Base → Haut)')
})

test('LE TEST QUI COMPTE : le plafond borne le cliquet — et sans plafond, le haut de la grille', () => {
  const s = nuit(JOUR.jeudi, { preuveN1: preuve('jeudi', 400) })
  assert.equal(s.prix, 255)
  assert.equal(s.releve_n1.plafonne, true)
  assert.match(s.releve_n1.resume, /^Plafonné à 255 € — le 20\/11\/2025 s’est vendu 400 €, mais une seule réservation a atteint ce prix/)
  const sans = nuit(JOUR.jeudi, { g: { plafond: null, plafondBrut: null }, preuveN1: preuve('jeudi', 400) })
  assert.equal(sans.prix, 165, 'sans plafond : jamais au-dessus du haut de la grille')
  assert.match(sans.releve_n1.resume, /^Plafonné à 165 €, le haut de votre grille/)
})

test('memes conditions que la fourchette : seuil de deux pas, autre segment, hors reference, a venir', () => {
  assert.equal(nuit(JOUR.jeudi, { preuveN1: preuve('jeudi', 124.99) }).prix, 115, 'moins de 10 € : on ne bouge pas')
  assert.equal(nuit(JOUR.jeudi, { preuveN1: preuve('jeudi', 125) }).prix, 125)
  assert.equal(nuit(JOUR.jeudi, { preuveN1: preuve('jeudi', 127.2) }).prix, 130, 'arrondi au pas superieur')
  assert.equal(nuit(JOUR.jeudi, { preuveN1: preuve('jeudi', 200, { meme_segment: false }) }).prix, 115)
  assert.equal(nuit(JOUR.jeudi, { preuveN1: preuve('jeudi', 200, { hors_reference: true }) }).prix, 115)
  assert.equal(nuit(JOUR.jeudi, { preuveN1: { date: PREUVE.jeudi, prix: null, pas_encore_passee: true, meme_segment: true } }).prix, 115)
  // Rien ne bouge : B reste muet (pas de couche, pas d'objet).
  const muet = nuit(JOUR.jeudi, { preuveN1: null })
  assert.equal(muet.releve_n1, undefined)
  assert.equal(muet.couches.find(c => c.nom === 'releve_n1'), undefined)
})

test('LE TEST QUI COMPTE : la pression retire le relevement, et le dit', () => {
  const s = nuit(JOUR.jeudi, { delaiJours: 90, preuveN1: preuve('jeudi', 200), pression: { ecart: -0.3, fiable: true } })
  assert.equal(s.prix, 115, 'Base, −1 +1 : Base ; pas de relevement quand le mois s effondre')
  assert.equal(s.releve_n1.motif_sans_prime, S.MOTIFS_SANS_PRIME.PRIME_RETIREE)
  assert.match(s.releve_n1.resume, /^Relèvement retiré — ce mois se vend 30 % moins bien que l’an dernier/)
})

test('la fourchette suit la meme regle de jour : samedi vers dimanche refuse a Exceptionnel aussi', () => {
  // Un dimanche pousse a Exceptionnel par un reglage de l'hote, preuve un samedi.
  const s = nuit(JOUR.dimanche, { reglage: { crans: 4, cle: 'hors_vacances' }, preuveN1: preuve('samedi', 250) })
  assert.equal(s.niveau, 'Exceptionnel')
  assert.equal(s.prix, 165)
  assert.equal(s.prime_exceptionnel.motif_sans_prime, S.MOTIFS_SANS_PRIME.AUTRE_TYPE_DE_NUIT)
  assert.match(s.prime_exceptionnel.resume, /était un samedi, qui se vend Exceptionnel chez vous, contre Base pour un dimanche : son prix surestimerait cette nuit/)
})

// ─── Arbitrages de Thierry apres la review du point B (23 septembre 2026) ───

test('LE TEST QUI COMPTE : a 14 jours ou moins, le delai retire le relevement — le prix N-1 a ete obtenu a un delai inconnu', () => {
  // Le cas reel : La bulle, vendredi 02/10/2026 a 9 jours, Haut −1 = Moyen
  // 125 €, preuve 150 € (le vendredi 03/10/2025).
  const s = nuit(JOUR.vendredi, { delaiJours: 9, preuveN1: { date: '2025-11-21', prix: 150, ventes: 1, meme_segment: true } })
  assert.equal(s.niveau, 'Moyen', 'le delai descend la nuit d un niveau')
  assert.equal(s.prix, 125, 'et le relevement ne la remonte pas')
  assert.equal(s.releve_n1.motif_sans_prime, S.MOTIFS_SANS_PRIME.RETIREE_DELAI)
  assert.equal(s.releve_n1.resume, 'Relèvement retiré — la nuit approche : 125 € au lieu de 150 € (prix obtenu le 21/11/2025, à un délai inconnu)')
  // Et a 15 jours, le relevement s'applique.
  assert.equal(nuit(JOUR.vendredi, { delaiJours: 15, preuveN1: { date: '2025-11-21', prix: 150, ventes: 1, meme_segment: true } }).prix, 150)
  // La fourchette suit la meme regle : un samedi Exceptionnel, delai −1 mais
  // pression +1, reste Exceptionnel — et n'a pas de prime.
  const a = nuit('2026-11-21', { delaiJours: 9, pression: { ecart: 0.4, fiable: true }, preuveN1: preuve('samedi', 200) })
  assert.equal(a.niveau, 'Exceptionnel')
  assert.equal(a.prix, 165)
  assert.match(a.prime_exceptionnel.resume, /^Prime retirée — la nuit approche : 165 € au lieu de 200 €/)
})

test('LE TEST QUI COMPTE : un reglage de l hote qui BAISSE n est pas defait — le detail montre le prix N-1 non repris', () => {
  const s = nuit(JOUR.vendredi, { reglage: { crans: -2, cle: 'hors_vacances' }, preuveN1: preuve('jeudi', 190) })
  assert.equal(s.niveau, 'Base', 'vendredi Haut, −2 crans de l hote : Base')
  assert.equal(s.prix, 115, 'la main de l hote prime')
  assert.equal(s.releve_n1.motif_sans_prime, S.MOTIFS_SANS_PRIME.REGLAGE_HOTE)
  assert.equal(s.releve_n1.resume, 'Prix de l’an dernier : 190 € le 20/11/2025 — non repris : votre réglage (-2 crans sur « hors_vacances ») fixe ce niveau')
})

test('LE TEST QUI COMPTE : un reglage de l hote qui MONTE n est jamais ecrase — le plancher est un minimum, jamais un maximum', () => {
  // Jeudi Base, +4 crans : Exceptionnel 165 € ; preuve un jeudi a 140 €.
  const s = nuit(JOUR.jeudi, { reglage: { crans: 4, cle: 'hors_vacances' }, preuveN1: preuve('jeudi', 140) })
  assert.equal(s.niveau, 'Exceptionnel')
  assert.equal(s.prix, 165, 'la preuve plus basse ne descend pas le prix')
  // Et a Tres haut (+3), une preuve plus basse ne bouge rien non plus.
  const t = nuit(JOUR.jeudi, { reglage: { crans: 3, cle: 'hors_vacances' }, preuveN1: preuve('jeudi', 130) })
  assert.equal(t.prix, 155)
  assert.equal(t.releve_n1, undefined)
})
