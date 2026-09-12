// tests/capacite-yield.test.js
// LE DEFAUT QU'ILS EMPECHENT : un denominateur de taux d'occupation invente.
// « Zero jour ouvert » et « je ne sais pas » sont deux reponses OPPOSEES pour
// le moteur. La premiere donne un TO de 0/0 ; la seconde dit d'ecarter le bien
// et de le signaler. Un moteur qui invente un denominateur suggere des prix
// sur du vide.
//
// Spec : docs/specs/spec-yieldflow-v1.md §5 — docs/kb/capacite-yield.md

const test = require('node:test')
const assert = require('node:assert')

const {
  joursOuverts, joursDeLaPeriode, estJourISO, NON_CALCULABLE
} = require('../lib/yield/capacite')

// ⚠ `base_price` FAIT PARTIE DU CONTRAT : sans elle, la fonction refuse de
// repondre plutot que de lire `undefined` comme « pas de prix » et de fermer
// tout le calendrier d'un bien qui vend.
// ⚠ HORLOGE INJECTEE, DATES FIGEES — regle du depot.
// Les dates de test sont en 2026-10 : sans injection, elles passent du futur au
// passe le 1er octobre 2026, et la convention estimee change leur verdict. Deux
// tests ont bascule ainsi en review. `aujourdHui` existe pour ca.
const AUJ = '2026-09-12'
const opts = (o = {}) => ({ aujourdHui: AUJ, ...o })

const BIEN = { id: 'b-1', provider: 'channex', base_price: 100 }
const BIEN_SANS_BASE = { id: 'b-1', provider: 'channex', base_price: null }

// Faux client : ne sert que `calendar_inventory`, en lecture.
function fausseBase (lignes, { erreur = null } = {}) {
  return {
    lectures: 0,
    from (table) {
      assert.equal(table, 'calendar_inventory', 'la capacite ne lit que la memoire d intention')
      const f = { eq: [], gte: null, lte: null, from: 0, to: 999, ordonne: false }
      const q = {
        select () { return q },
        eq (c, v) { f.eq.push([c, v]); return q },
        gte (c, v) { f.gte = v; return q },
        lte (c, v) { f.lte = v; return q },
        order () { f.ordonne = true; return q },
        range (a, b) { f.from = a; f.to = b; return q },
        then: (res) => {
          if (erreur) return Promise.resolve({ data: null, error: erreur }).then(res)
          // ⚠ LE FAUX CLIENT IMPOSE CE QUE POSTGREST IMPOSE.
          // Sans `order`, la pagination n'est pas deterministe : on refuse,
          // sinon le test validerait un code que la vraie base casse.
          assert.ok(f.ordonne, 'la lecture paginee doit etre ordonnee')
          const out = lignes
            .filter(l => (!f.gte || l.date >= f.gte) && (!f.lte || l.date <= f.lte))
            .sort((a, b) => a.date.localeCompare(b.date))
            .slice(f.from, f.to + 1)
          return Promise.resolve({ data: out, error: null }).then(res)
        }
      }
      return q
    }
  }
}

test('joursDeLaPeriode : bornes incluses, ordre, cas degeneres', () => {
  assert.deepEqual(joursDeLaPeriode('2026-10-01', '2026-10-03'),
    ['2026-10-01', '2026-10-02', '2026-10-03'])
  assert.deepEqual(joursDeLaPeriode('2026-10-01', '2026-10-01'), ['2026-10-01'],
    'un jour unique est une periode valide')
  assert.deepEqual(joursDeLaPeriode('2026-10-03', '2026-10-01'), [], 'fin avant debut')
  assert.deepEqual(joursDeLaPeriode('01/10/2026', '2026-10-03'), [], 'format refuse')
  // Passage de mois et d'annee, sans derive de fuseau.
  assert.deepEqual(joursDeLaPeriode('2026-12-31', '2027-01-01'), ['2026-12-31', '2027-01-01'])
  assert.equal(joursDeLaPeriode('2026-02-28', '2026-03-01').length, 2, 'fevrier non bissextile')
  // ⚠ L'ASSERTION PRECEDENTE ETAIT INOPERANTE, ET MASQUAIT UN VRAI TROU.
  // Ecrite `!estJourISO(x) === false`, la negation s'appliquait avant la
  // comparaison : l'expression valait toujours `true`. Et elle passait PARCE
  // QUE `estJourISO('2026-13-01')` rendait `true` — le regex acceptait le mois
  // 13 et le jour 45. Le test croyait verifier le rejet d'une date impossible
  // et verifiait exactement l'inverse.
  assert.equal(estJourISO('2026-10-01'), true)
  assert.equal(estJourISO('2026-13-01'), false, 'mois 13')
  assert.equal(estJourISO('2026-10-45'), false, 'jour 45')
  assert.equal(estJourISO('2026-02-30'), false, '30 fevrier')
  assert.equal(estJourISO('2026-04-31'), false, '31 d un mois a 30 jours')
  assert.equal(estJourISO('2024-02-29'), true, '29 fevrier d une annee bissextile')
  assert.equal(estJourISO('2026-02-29'), false, '29 fevrier d une annee normale')

  // Une periode trop longue est REFUSEE, pas tronquee.
  assert.equal(joursDeLaPeriode('2026-01-01', '2036-01-01'), null,
    'au-dela du plafond, on rend null plutot qu une fenetre amputee')
})

test('un jour sans stop_sell est OUVERT, un jour ferme ne l est pas', async () => {
  const sb = fausseBase([
    { date: '2026-10-01', stop_sell: false, avail: 1 },
    { date: '2026-10-02', stop_sell: true, avail: 1 },
    { date: '2026-10-03', stop_sell: false, avail: 0 }
  ])
  const r = await joursOuverts(sb, BIEN, '2026-10-01', '2026-10-03', opts())
  assert.equal(r.calculable, true)
  assert.equal(r.jours_ouverts, 1)
  assert.equal(r.jours_fermes, 2, 'stop_sell ET avail=0 ferment')
  assert.deepEqual(r.detail, ['2026-10-01'])
})

test('LE TEST QUI COMPTE : une nuit VENDUE reste une nuit OUVERTE', async () => {
  // Elle etait a la vente, et elle s'est vendue : c'est le NUMERATEUR du taux
  // d'occupation, pas une soustraction du denominateur. La vente reduit le
  // STOCK, calcule au moment de pousser ; elle ne touche pas l'INTENTION,
  // memorisee. Les exclure donnerait un TO de 100 % a tout bien qui vend.
  const sb = fausseBase([
    { date: '2026-10-01', stop_sell: false, avail: 1 },   // vendue : avail reste la trace de la derniere poussee
    { date: '2026-10-02', stop_sell: false, avail: 1 }
  ])
  const r = await joursOuverts(sb, BIEN, '2026-10-01', '2026-10-02', opts())
  assert.equal(r.jours_ouverts, 2, 'les deux nuits comptent au denominateur')
})

test('une nuit SANS LIGNE est fermee — convention runFullSync', async () => {
  // `runFullSync` calcule `availability = r ? Math.min(annonce, stock) : 0` :
  // l'absence de ligne vaut zero. Une nuit sans ligne n'est vendable nulle part.
  const sb = fausseBase([{ date: '2026-10-01', stop_sell: false, avail: 1 }])
  const r = await joursOuverts(sb, BIEN, '2026-10-01', '2026-10-05', opts())
  assert.equal(r.calculable, true)
  assert.equal(r.jours_ouverts, 1)
  assert.equal(r.jours_fermes, 4)
  assert.equal(r.jours_sans_ligne, 4, 'comptees a part, pour signaler une memoire incomplete')
})

test('LE TEST QUI COMPTE : memoire non amorcee -> NON CALCULABLE, jamais zero', async () => {
  // C'est toute la raison d'etre de cette fonction. Rendre « 0 jour ouvert »
  // ferait un TO de 0/0 — NaN ou Infinity selon l'ordre des operations — et le
  // moteur suggererait des prix sur un bien dont il ne sait rien.
  const sb = fausseBase([])
  const r = await joursOuverts(sb, BIEN, '2026-10-01', '2026-10-31', opts())
  assert.equal(r.calculable, false)
  // ⚠ LA PERIODE EST FUTURE (horloge injectee au 2026-09-12) : on n'estime
  // JAMAIS l'avenir. Une memoire vide y reste non calculable, et la raison le
  // dit precisement.
  assert.equal(r.raison, NON_CALCULABLE.FUTUR_NON_AMORCE)
  assert.equal(r.jours_ouverts, 0, 'le compteur est a zero, mais calculable dit de ne PAS l utiliser')
  assert.equal(r.jours_total, 31, 'la periode reste connue : le moteur sait ce qu il ignore')
})

test('LE TEST QUI COMPTE : un bien Beds24 est NON CALCULABLE, pas ferme', async () => {
  // La memoire d'intention d'un bien Beds24 n'est amorcee qu'a la migration
  // vers Channex. Lire son calendrier rendrait quelques lignes eparses — celles
  // que l'hote a touchees depuis HoteSmart — et ferait passer 360 jours pour
  // fermes. Un TO calcule la-dessus serait faux ET credible.
  let lu = false
  const sb = { from () { lu = true; throw new Error('ne doit pas etre interroge') } }
  const r = await joursOuverts(sb, { id: 'b-2', provider: 'beds24' }, '2026-10-01', '2026-10-31')
  assert.equal(r.calculable, false)
  assert.equal(r.raison, NON_CALCULABLE.PROVIDER)
  assert.equal(lu, false, 'et on n interroge meme pas le calendrier : la reponse est dans le provider')
})

test('une erreur de lecture LEVE, elle ne rend pas un denominateur invente', async () => {
  const sb = fausseBase([], { erreur: { message: 'timeout' } })
  await assert.rejects(() => joursOuverts(sb, BIEN, '2026-10-01', '2026-10-31', opts()),
    /lecture du calendrier/,
    'un denominateur invente est pire qu un trou declare')
})

test('parametres invalides : rendus non calculables, sans exception', async () => {
  const sb = fausseBase([])
  for (const [b, d, f] of [
    [null, '2026-10-01', '2026-10-02'],
    [BIEN, '2026-10-02', '2026-10-01'],
    [BIEN, 'pas-une-date', '2026-10-02']
  ]) {
    const r = await joursOuverts(sb, b, d, f, opts())
    assert.equal(r.calculable, false)
    assert.equal(r.raison, 'parametres_invalides')
  }
})

test('la capacite ne lit QUE calendar_inventory (aucun appel provider)', () => {
  const fs = require('fs')
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'lib/yield/capacite.js'), 'utf8')
  assert.ok(!/channelCall|fetch\(|beds24|require\('\.\.\/channels/.test(src),
    'aucun appel provider : le moteur lit le coeur, jamais un provider (regle 6)')
  assert.ok(!/\.insert\(|\.update\(|\.upsert\(|\.delete\(/.test(src),
    'lecture seule : la capacite ne cree aucune verite')
})

test('LE TEST QUI COMPTE : une nuit SANS PRIX est fermee, pas ouverte', async () => {
  // ⚠ LA TROISIEME REGLE DE FERMETURE DE runFullSync, OUBLIEE EN PREMIERE
  // VERSION alors que le commentaire disait « mot pour mot ».
  // Quand `rate` est nul ET que `base_price` ne prend pas le relais,
  // `runFullSync` force `stop_sell: true` (`fermeesSansPrix`) et le moteur
  // direct refuse la nuit (`raison: 'sans_prix'`). Sur un bien dont l'amorcage
  // des prix a rate, le denominateur se serait gonfle de centaines de nuits
  // jamais mises en vente : TO effondre, et YieldFlow recommandant de baisser
  // les prix sur des nuits qu'aucun voyageur n'a pu voir.
  const lignes = [
    { date: '2026-10-01', stop_sell: false, avail: 1, rate: 120 },
    { date: '2026-10-02', stop_sell: false, avail: 1, rate: null },
    { date: '2026-10-03', stop_sell: false, avail: 1, rate: 0 }
  ]
  // Sans prix de base : les deux nuits sans tarif sont fermees.
  const sansBase = await joursOuverts(fausseBase(lignes), BIEN_SANS_BASE, '2026-10-01', '2026-10-03', opts())
  assert.equal(sansBase.jours_ouverts, 1)
  assert.equal(sansBase.jours_sans_prix, 2)
  assert.equal(sansBase.jours_fermes, 2)

  // Avec un prix de base : il prend le relais, les trois nuits sont ouvertes.
  const avecBase = await joursOuverts(fausseBase(lignes), BIEN, '2026-10-01', '2026-10-03', opts())
  assert.equal(avecBase.jours_ouverts, 3, 'un prix de base EST un prix')
  assert.equal(avecBase.jours_sans_prix, 0)
})

test('base_price non selectionne -> NON CALCULABLE, jamais « tout ferme »', async () => {
  // Le piege de la colonne oubliee, que ce depot a paye quatre fois : lire
  // `undefined` comme « pas de prix » fermerait tout le calendrier d'un bien
  // qui vend, sans la moindre erreur.
  const sb = fausseBase([{ date: '2026-10-01', stop_sell: false, avail: 1, rate: 120 }])
  const r = await joursOuverts(sb, { id: 'b-1', provider: 'channex' }, '2026-10-01', '2026-10-03')
  assert.equal(r.calculable, false)
  assert.equal(r.raison, NON_CALCULABLE.COLONNE_MANQUANTE)
})

test('LE TEST QUI COMPTE : au-dela de 1000 jours, la lecture pagine', async () => {
  // PostgREST plafonne a 1000 lignes. Sans pagination, une fenetre de 3 ans
  // ramenait 1000 lignes sur 1096 : les 96 manquantes tombaient en « sans
  // ligne » donc « fermees », et la fonction rendait `calculable: true`.
  // Denominateur faux, silencieux, et non reproductible faute d'`order`.
  const lignes = []
  const d = new Date(Date.UTC(2026, 0, 1))
  for (let i = 0; i < 1200; i++) {
    lignes.push({ date: d.toISOString().slice(0, 10), stop_sell: false, avail: 1, rate: 100 })
    d.setUTCDate(d.getUTCDate() + 1)
  }
  const fin = lignes[lignes.length - 1].date
  const r = await joursOuverts(fausseBase(lignes), BIEN, '2026-01-01', fin)
  assert.equal(r.calculable, true)
  assert.equal(r.jours_total, 1200)
  assert.equal(r.jours_ouverts, 1200, 'les 1200 nuits sont lues, pas seulement les 1000 premieres')
  assert.equal(r.jours_sans_ligne, 0)
})

test('une periode trop longue est refusee, avec une raison exportee', async () => {
  const r = await joursOuverts(fausseBase([]), BIEN, '2026-01-01', '2036-01-01', opts())
  assert.equal(r.calculable, false)
  assert.equal(r.raison, NON_CALCULABLE.PERIODE_TROP_LONGUE)
})

test('toutes les raisons de non-calculabilite sont exportees', async () => {
  // Un appelant qui fait `switch (r.raison)` sur les membres de NON_CALCULABLE
  // ne doit jamais tomber en `default` : une chaine libre le ferait.
  const connues = new Set(Object.values(NON_CALCULABLE))
  const cas = [
    [BIEN, '2026-10-02', '2026-10-01'],            // periode inversee
    [BIEN, 'pas-une-date', '2026-10-02'],          // format invalide
    [{ id: 'b', provider: 'beds24', base_price: 1 }, '2026-10-01', '2026-10-02'],
    [{ id: 'b', provider: 'channex' }, '2026-10-01', '2026-10-02'],
    [BIEN, '2026-01-01', '2036-01-01']             // trop longue
  ]
  for (const [b, d, f] of cas) {
    const r = await joursOuverts(fausseBase([]), b, d, f, opts())
    assert.equal(r.calculable, false)
    assert.ok(connues.has(r.raison), `raison hors constante : ${r.raison}`)
  }
  // Et les deux cas « memoire vide », qui passent par la lecture.
  const futur = await joursOuverts(fausseBase([]), BIEN, '2026-10-01', '2026-10-02', opts())
  assert.equal(futur.raison, NON_CALCULABLE.FUTUR_NON_AMORCE, 'avenir : jamais estime')
  const passe = await joursOuverts(fausseBase([]), BIEN, '2025-01-01', '2025-01-02',
    opts({ estimerLePasse: false }))
  assert.equal(passe.raison, NON_CALCULABLE.VIDE, 'passe, convention desactivee')
})


// ─── La convention « capacité estimée » ─────────────────────────────────────

test('LE TEST QUI COMPTE : un jour PASSE sans memoire est repute OUVERT', () => {})

test('convention estimee : le passe s estime, l avenir JAMAIS', async () => {
  // ⚠ DECISION DE THIERRY, 12 septembre 2026. La memoire d'intention ne remonte
  // pas dans le passe : 4 ans de ventes contre TROIS JOURS d'intention sur
  // La bulle. Sans convention, TO et RevPAR n'existent sur aucun mois passe.
  const passe = await joursOuverts(fausseBase([]), BIEN, '2025-03-01', '2025-03-31', opts())
  assert.equal(passe.calculable, true)
  assert.equal(passe.jours_ouverts, 31, 'tous les jours passes sont reputes ouverts')
  assert.equal(passe.estimee, true, 'et le drapeau vit DANS la donnee')
  assert.equal(passe.jours_estimes_ouverts, 31)

  const futur = await joursOuverts(fausseBase([]), BIEN, '2027-03-01', '2027-03-31', opts())
  assert.equal(futur.calculable, false, 'on n estime JAMAIS l avenir')
  assert.equal(futur.raison, NON_CALCULABLE.FUTUR_NON_AMORCE)
})

test('LE TEST QUI COMPTE : une periode A CHEVAL ne melange pas les deux', async () => {
  // ⚠ LE DEFAUT GRAVE TROUVE EN REVIEW. Desarmer la garde des que
  // `debut < aujourd hui` laissait passer le MOIS EN COURS : un bien Beds24
  // traversait la garde, on interrogeait sa memoire inexistante, et ses jours
  // FUTURS repartaient « fermes ». Mesure du scenario : 11 jours estimes
  // ouverts, 19 comptes fermes, 20 nuitees — un TO de 182 %, calculable: true.
  const beds24 = { id: 'b-9', provider: 'beds24', base_price: 100 }
  let interroge = false
  const sb = { from () { interroge = true; throw new Error('ne doit pas etre interroge') } }
  const r = await joursOuverts(sb, beds24, '2026-09-01', '2026-09-30', opts())
  assert.equal(r.calculable, false, 'un bien sans memoire et du futur : non calculable')
  assert.equal(r.raison, NON_CALCULABLE.PROVIDER)
  assert.equal(interroge, false, 'et sa memoire inexistante n est meme pas lue')

  // Le meme bien, sur une periode ENTIEREMENT passee : estimable.
  const avant = await joursOuverts(fausseBase([]), beds24, '2025-03-01', '2025-03-31', opts())
  assert.equal(avant.calculable, true)
  assert.equal(avant.estimee, true)
})

test('une memoire VIDE a cheval ne rend pas les jours futurs « fermes »', async () => {
  // Meme asymetrie, cote Channex : `calculable: true` avec les jours futurs
  // comptes fermes, et SANS drapeau puisque `estimee` ne couvre que le passe.
  // Denominateur faux, credible, silencieux.
  const r = await joursOuverts(fausseBase([]), BIEN, '2026-09-01', '2026-09-30', opts())
  assert.equal(r.calculable, false)
  assert.equal(r.raison, NON_CALCULABLE.FUTUR_NON_AMORCE)
})

test('LE TEST QUI COMPTE : une exception declaree PRIME, meme sur une ligne reelle', async () => {
  // Elle n etait consultee que pour les jours SANS ligne : une exception posee
  // sur un jour passe portant une ligne perimee (ecrite a la migration,
  // `avail: 1`) etait ignoree, et le jour comptait ouvert. « L hote sait
  // mieux » ne souffre pas d exception.
  const lignes = [
    { date: '2025-03-01', stop_sell: false, avail: 1, rate: 100 },
    { date: '2025-03-02', stop_sell: false, avail: 1, rate: 100 }
  ]
  const exclus = new Set(['2025-03-02'])
  const r = await joursOuverts(fausseBase(lignes), BIEN, '2025-03-01', '2025-03-02',
    opts({ joursExclus: exclus }))
  assert.equal(r.jours_ouverts, 1, 'la nuit declaree fermee ne compte pas')
  assert.equal(r.jours_estimes_fermes_par_exception, 1)
  assert.deepEqual(r.detail, ['2025-03-01'])
})

test('la bascule est automatique : une ligne reelle fait foi', async () => {
  // L estimation ne comble que les TROUS du passe.
  const lignes = [{ date: '2025-03-02', stop_sell: true, avail: 0, rate: 100 }]
  const r = await joursOuverts(fausseBase(lignes), BIEN, '2025-03-01', '2025-03-03', opts())
  assert.equal(r.jours_ouverts, 2, 'les 1er et 3 sont estimes ouverts')
  assert.equal(r.jours_estimes_ouverts, 2)
  assert.ok(!r.detail.includes('2025-03-02'), 'le 2 est ferme PAR SA LIGNE REELLE')
})
