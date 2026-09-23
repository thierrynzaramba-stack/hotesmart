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
// CONTRE-EPREUVE (REVIEW.md regle 19), faite le 23 septembre 2026 :
//   - contre la version (b) STRICTE (meme niveau exige, avant b′) : 3 rouges —
//     jeudi → vendredi, meme niveau, et la phrase de refus de la fourchette ;
//   - contre le code d'avant le point B (fourchette seule) : 7 rouges sur 8 ;
//     le 8e (samedi → dimanche refuse) y passait par accident, rien n'etant
//     releve ;
//   - contre une version SANS condition de jour (option a) : 4 rouges, dont
//     samedi → dimanche. Chaque test rougit donc contre au moins une version
//     fautive plausible.

const test = require('node:test')
const assert = require('node:assert')
const S = require('../lib/yield/suggestion')
const R = require('../lib/yield/reference')

const NIVEAUX = [115, 125, 140, 155, 165]
// Structure hors vacances du bien de test : dimanche-jeudi Base, vendredi
// Haut, samedi Exceptionnel (lue par `positions_jour`, comme en production).
function grille ({ plafond = 255, plafondBrut = 257 } = {}) {
  const niveaux = S.NIVEAUX.map((n, i) => ({ ...n, prix: NIVEAUX[i], prix_mesure: NIVEAUX[i], etire: false }))
  const pos = indice => ({ fiable: true, indice, niveau: niveaux[indice].nom, crans: 0, echantillon: 40, reservations: 20, mediane: NIVEAUX[indice] })
  return {
    base: { fiable: true, echantillon: 854, reservations: 400, niveaux, min: 35, max: 295, plafond, plafond_brut: plafondBrut },
    positions: new Map([['hors_vacances', { ...pos(0), crans: 0 }]]),
    positions_jour: new Map([['hors_vacances|samedi', pos(4)], ['hors_vacances|vendredi', pos(2)]])
  }
}
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
  assert.equal(s.niveau, 'Exceptionnel', 'le niveau affiche suit le prix')
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
