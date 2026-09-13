// tests/comparable-yield.test.js
// LE DEFAUT QU'IL EMPECHE : un hote qui compare le samedi de la Toussaint 2026
// a un mercredi ordinaire de 2025, et qui en conclut qu'il a baisse ses prix.
//
// La colonne « l'an dernier » est le seul chiffre auquel l'hote peut confronter
// sa memoire. Si l'appariement est faux, elle ment de façon CREDIBLE — ce qui
// est pire qu'une case vide.
//
// La cascade a quatre etages (a/b/c/d) est arbitree par Thierry le 13 septembre
// 2026. Spec : docs/specs/spec-yieldflow-v1.md §7.3 (etape 4, lot 4.4, passe 3).

const test = require('node:test')
const assert = require('node:assert')

const { nuitComparable, ALIGNEMENTS, ETAGES, ferieADateFixe } =
  require('../lib/yield/comparable')
const { construireContexte, jourDeSemaine, segmenterJour } =
  require('../lib/yield/reference')

// ⚠ LE CONTEXTE DOIT COUVRIR LES DEUX ANNEES. C'est la condition d'emploi du
// module, et l'oublier est le premier piege : un contexte borne a N rendrait
// « pas de comparable » partout sans que rien ne paraisse casse.
const ctx = (vacances = []) => construireContexte({
  zoneBien: 'C', vacances, debut: '2023-01-01', fin: '2027-12-31'
})

// ─── Vacances REELLES, avec leur glissement ─────────────────────────────────
// Toussaint : 16 jours en 2025, 16 en 2026, decalees d'un jour.
const TOUSSAINT = [
  { zone: 'C', nom: 'Vacances de la Toussaint', date_debut: '2025-10-18', date_fin: '2025-11-02' },
  { zone: 'C', nom: 'Vacances de la Toussaint', date_debut: '2026-10-17', date_fin: '2026-11-01' }
]
// Hiver : LE cas vicieux. La zone C part le 21 fevrier en 2026 et le 7 fevrier
// en 2025 — deux semaines de glissement, soit plus que le pas de 7 jours.
const HIVER = [
  { zone: 'C', nom: 'Vacances d\'hiver', date_debut: '2025-02-07', date_fin: '2025-02-23' },
  { zone: 'C', nom: 'Vacances d\'hiver', date_debut: '2026-02-21', date_fin: '2026-03-09' }
]

// ─── Etage a-bis : l'evenement de l'hote ────────────────────────────────────
// ⚠ CE CODE EST INERTE TANT QUE LA TABLE `yield_events` N'EXISTE PAS : aucun
// appelant ne passe encore d'evenements. Il est teste QUAND MEME — du code sans
// appelant est precisement celui dont personne ne remarque qu'il est faux.

const EVENEMENT = [
  { nom: 'Saison thermale', segment: 'evenement:saison_thermale',
    date_debut: '2025-04-05', date_fin: '2025-06-29', parent_segment: 'vacances_zone_du_bien' },
  { nom: 'Saison thermale', segment: 'evenement:saison_thermale',
    date_debut: '2026-04-11', date_fin: '2026-07-05', parent_segment: 'vacances_zone_du_bien' }
]
const ctxEv = () => construireContexte({ zoneBien: 'C', vacances: [],
  evenements: EVENEMENT, debut: '2023-01-01', fin: '2027-12-31' })

test('a-bis) un evenement de l\'hote passe AVANT toute regle de calendrier', () => {
  const c = ctxEv()
  // Samedi 25 avril 2026 : 3e samedi de la saison thermale 2026 (debut 11 avr).
  assert.strictEqual(jourDeSemaine('2026-04-25'), 'samedi')
  const r = nuitComparable('2026-04-25', { contexte: c })
  assert.strictEqual(r.etage, ETAGES.EVENEMENT_HOTE)
  assert.strictEqual(r.alignement, ALIGNEMENTS.EVENEMENT_HOTE_POSITION)
  assert.strictEqual(r.rang, 3)
  // Saison 2025 : debut samedi 5 avril. Samedis : 5, 12, 19… Le 3e est le 19.
  assert.strictEqual(r.date, '2025-04-19')
  assert.strictEqual(r.meme_jour, true)
  assert.strictEqual(r.meme_segment, true)
})

test('a-bis) non declare l\'an dernier : PAS DE COMPARABLE, pas un repli', () => {
  // ⚠ ON NE DESCEND PAS D'UN CRAN EN SILENCE. Comparer une nuit de saison
  // thermale a un « 2e mardi de mai hors vacances » rendrait un chiffre
  // credible et faux.
  const seul = construireContexte({ zoneBien: 'C', vacances: [],
    evenements: [EVENEMENT[1]], debut: '2023-01-01', fin: '2027-12-31' })
  const r = nuitComparable('2026-04-25', { contexte: seul })
  assert.strictEqual(r.etage, ETAGES.AUCUN)
  assert.strictEqual(r.date, null)
  assert.strictEqual(r.raison, 'evenement_absent_de_l_an_dernier')
})

test('a-bis) l\'evenement ne se compare JAMAIS a une date posterieure', () => {
  const c = ctxEv()
  let jour = '2026-04-11'
  while (jour <= '2026-07-05') {
    const r = nuitComparable(jour, { contexte: c })
    if (r.date) assert.ok(r.date < jour, `${jour} -> ${r.date}`)
    jour = new Date(Date.parse(`${jour}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)
  }
})

test('a-bis) deux occurrences par an : c est celle de l AN DERNIER, pas la precedente', () => {
  // ⚠ RELEVE EN REVIEW. Le code ne filtrait que « anterieure » puis prenait la
  // plus recente : la brocante d'aout 2026 s'appariait a celle de MARS 2026 —
  // trois mois plus tot, dans la meme annee — pendant que celle d'aout 2025
  // existait. L'ecran publiait ce prix sous « le reel de l'an dernier ».
  const ev = [
    { nom: 'Brocante', segment: 'evenement:brocante', date_debut: '2025-08-08', date_fin: '2025-08-10' },
    { nom: 'Brocante', segment: 'evenement:brocante', date_debut: '2026-03-06', date_fin: '2026-03-08' },
    { nom: 'Brocante', segment: 'evenement:brocante', date_debut: '2026-08-07', date_fin: '2026-08-09' }
  ]
  const c = construireContexte({ zoneBien: 'C', vacances: [], evenements: ev,
    debut: '2023-01-01', fin: '2027-12-31' })
  const r = nuitComparable('2026-08-08', { contexte: c })
  assert.strictEqual(r.etage, ETAGES.EVENEMENT_HOTE)
  assert.ok(r.date.startsWith('2025-08'), `apparie a ${r.date}, attendu aout 2025`)
  assert.ok(Math.abs(r.ecart_jours) <= 40)

  // Et l'occurrence de mars, elle, n'a pas d'an dernier : on le DIT.
  const mars = nuitComparable('2026-03-07', { contexte: c })
  assert.strictEqual(mars.etage, ETAGES.AUCUN)
  assert.strictEqual(mars.raison, 'evenement_absent_de_l_an_dernier')
})

// ─── Etage a : les dates fixes ──────────────────────────────────────────────

test('a) le 31 decembre se compare au 31 decembre, pas au meme jour de semaine', () => {
  const noel = [
    { zone: 'C', nom: 'Vacances de Noël', date_debut: '2025-12-20', date_fin: '2026-01-05' },
    { zone: 'C', nom: 'Vacances de Noël', date_debut: '2026-12-19', date_fin: '2027-01-04' }
  ]
  const r = nuitComparable('2026-12-31', { contexte: ctx(noel) })
  assert.strictEqual(r.date, '2025-12-31')
  assert.strictEqual(r.etage, ETAGES.DATE_FIXE)
  assert.strictEqual(r.alignement, ALIGNEMENTS.REVEILLON)
  // 31 decembre 2026 = jeudi, 2025 = mercredi : la DATE a bien prime.
  assert.strictEqual(r.meme_jour, false)
})

test('a) un ferie FIXE garde sa date, meme en changeant de jour de semaine', () => {
  // Toussaint : dimanche 1er novembre 2026, samedi 1er novembre 2025.
  assert.strictEqual(jourDeSemaine('2026-11-01'), 'dimanche')
  assert.strictEqual(jourDeSemaine('2025-11-01'), 'samedi')
  const r = nuitComparable('2026-11-01', { contexte: ctx(TOUSSAINT) })
  assert.strictEqual(r.date, '2025-11-01')
  assert.strictEqual(r.etage, ETAGES.DATE_FIXE)
  assert.strictEqual(r.meme_jour, false)
})

test('a) le 14 juillet se compare au 14 juillet', () => {
  const r = nuitComparable('2026-07-14', { contexte: ctx() })
  assert.strictEqual(r.date, '2025-07-14')
  assert.strictEqual(r.etage, ETAGES.DATE_FIXE)
})

test('fixe ou mobile est DEDUIT de l\'annuaire, jamais d\'une liste recopiee', () => {
  assert.strictEqual(ferieADateFixe('2026-11-01', 'Toussaint').fixe, true)
  assert.strictEqual(ferieADateFixe('2026-04-06', 'Lundi de Pâques').fixe, false)
  assert.strictEqual(ferieADateFixe('2026-05-14', 'Ascension').fixe, false)
})

// ─── Etage b : les evenements mobiles ───────────────────────────────────────

test('b) Paques bouge de deux semaines, et le ferie est quand meme apparie', () => {
  // Lundi de Paques : 6 avril 2026, 21 avril 2025.
  const r = nuitComparable('2026-04-06', { contexte: ctx() })
  assert.strictEqual(r.date, '2025-04-21')
  assert.strictEqual(r.etage, ETAGES.EVENEMENT_MOBILE)
  assert.strictEqual(r.alignement, ALIGNEMENTS.FERIE_MOBILE)
  assert.strictEqual(r.meme_jour, true)   // un lundi de Paques reste un lundi
})

test('b) le samedi de la 1re semaine de Toussaint ↔ le meme samedi N-1', () => {
  const c = ctx(TOUSSAINT)
  // Vacances 2026 : 17 oct (samedi) → 1er nov. Le 1er samedi EST le 17.
  const r = nuitComparable('2026-10-17', { contexte: c })
  assert.strictEqual(r.etage, ETAGES.EVENEMENT_MOBILE)
  assert.strictEqual(r.alignement, ALIGNEMENTS.POSITION_VACANCES)
  assert.strictEqual(r.rang, 1)
  // Vacances 2025 : 18 oct (samedi) → 2 nov. Le 1er samedi est le 18.
  assert.strictEqual(r.date, '2025-10-18')
  assert.strictEqual(r.meme_jour, true)
  assert.strictEqual(r.meme_segment, true)
})

test('b) le 2e samedi de Toussaint ne tombe PAS sur le 1er', () => {
  const r = nuitComparable('2026-10-24', { contexte: ctx(TOUSSAINT) })
  assert.strictEqual(r.rang, 2)
  assert.strictEqual(r.date, '2025-10-25')
  // Sans l'etage b, 52 semaines auraient rendu le 25 aussi — mais par accident.
  // Le test qui compte est celui des vacances d'hiver, ou le glissement est
  // de deux semaines.
})

test('b) LES VACANCES D\'HIVER QUI GLISSENT DE DEUX SEMAINES', () => {
  const c = ctx(HIVER)
  // Samedi 28 fevrier 2026 : 2e samedi des vacances d'hiver (debut 21 fevrier).
  assert.strictEqual(jourDeSemaine('2026-02-28'), 'samedi')
  const r = nuitComparable('2026-02-28', { contexte: c })
  assert.strictEqual(r.etage, ETAGES.EVENEMENT_MOBILE)
  assert.strictEqual(r.rang, 2)
  // Vacances 2025 : 7 fevrier → 23. Samedis : 8, 15, 22. Le 2e est le 15.
  assert.strictEqual(r.date, '2025-02-15')
  assert.strictEqual(r.meme_segment, true)
  // ⚠ ET C'EST TOUT LE SUJET : 52 semaines en arriere donnaient le 1er mars
  // 2025, qui n'etait PAS en vacances. La comparaison aurait oppose une nuit
  // de plein hiver a une nuit ordinaire, en affichant un chiffre credible.
  const nominale = '2025-03-01'
  assert.notStrictEqual(r.date, nominale)
})

test('b) position absente en N-1 : on cede le rang, on ne cede pas l\'evenement', () => {
  // Des vacances N-1 plus courtes : un seul samedi.
  const court = [
    { zone: 'C', nom: 'Vacances d\'hiver', date_debut: '2025-02-08', date_fin: '2025-02-12' },
    { zone: 'C', nom: 'Vacances d\'hiver', date_debut: '2026-02-21', date_fin: '2026-03-09' }
  ]
  const r = nuitComparable('2026-03-07', { contexte: ctx(court) })   // 3e samedi
  assert.strictEqual(r.etage, ETAGES.EVENEMENT_MOBILE)
  assert.strictEqual(r.alignement, ALIGNEMENTS.JOUR_DANS_VACANCES)
  assert.strictEqual(r.rang, 3)
  assert.strictEqual(r.rang_n1, 1)
  assert.strictEqual(r.date, '2025-02-08')
  assert.strictEqual(r.meme_segment, true)
})

test('b) un ferie tombe DANS les vacances N-1 : la position prime, et le dit', () => {
  // CAS REEL, trouve par l'invariant sur 365 nuits — pas en relisant le code.
  // Samedi 31 octobre 2026 : 3e samedi des vacances de la Toussaint.
  // Le 3e samedi des vacances 2025 est le 1er novembre… qui EST la Toussaint.
  // Les deux nuits sont le meme samedi de pointe du meme evenement : c'est bien
  // la nuit comparable. Mais le segment differe (ferie contre vacances), donc
  // la grille de prix qui les porte n'est pas la meme.
  //
  // ⚠ ON GARDE L'APPARIEMENT ET ON LE DIT. Le refuser aurait prive l'hote de la
  // seule comparaison sensee ; le masquer lui aurait laisse croire a deux nuits
  // de meme nature. `meme_segment: false` est la pour que l'ecran le signale.
  const r = nuitComparable('2026-10-31', { contexte: ctx(TOUSSAINT) })
  assert.strictEqual(r.etage, ETAGES.EVENEMENT_MOBILE)
  assert.strictEqual(r.date, '2025-11-01')
  assert.strictEqual(r.rang, 3)
  assert.strictEqual(r.meme_jour, true)
  assert.strictEqual(r.meme_segment, false)
  assert.strictEqual(r.segment, 'ferie')
})

// ─── Etage c : le rang dans le mois ─────────────────────────────────────────

test('c) le 2e vendredi hors vacances ↔ le 2e vendredi hors vacances N-1', () => {
  const c = ctx()
  // Octobre 2026 sans vacances : vendredis 2, 9, 16, 23, 30. Le 2e est le 9.
  const r = nuitComparable('2026-10-09', { contexte: c })
  assert.strictEqual(r.etage, ETAGES.RANG_DANS_LE_MOIS)
  assert.strictEqual(r.alignement, ALIGNEMENTS.RANG_DANS_LE_MOIS)
  assert.strictEqual(r.rang, 2)
  // Octobre 2025 : vendredis 3, 10, 17, 24, 31. Le 2e est le 10.
  assert.strictEqual(r.date, '2025-10-10')
  assert.strictEqual(r.meme_jour, true)
  assert.strictEqual(r.meme_segment, true)
})

test('c) les comptes different : on prend le plus proche, et on le DIT', () => {
  // ⚠ COMPTES VERIFIES CONTRE LA SEGMENTATION REELLE, pas comptes de tete.
  // Janvier 2027 porte QUATRE dimanches hors vacances (10, 17, 24, 31) ;
  // janvier 2026 n'en porte que TROIS (11, 18, 25) — le 4 janvier 2026 tombe
  // dans le rayonnement du Jour de l'An, qui est un jeudi avec son pont.
  // La version precedente de ce test annonçait « 5 contre 4 » et passait par
  // accident : elle comptait les dimanches du calendrier, pas ceux que le
  // moteur classe hors vacances.
  const r = nuitComparable('2027-01-31', { contexte: ctx() })
  assert.strictEqual(r.etage, ETAGES.RANG_DANS_LE_MOIS)
  assert.strictEqual(r.alignement, ALIGNEMENTS.RANG_LE_PLUS_PROCHE)
  assert.strictEqual(r.rang, 4, 'le 31 janvier 2027 est le 4e dimanche hors vacances')
  assert.strictEqual(r.rang_n1, 3, 'janvier 2026 n\'en compte que 3')
  assert.strictEqual(r.date, '2026-01-25')
})

// ─── Etage d : « pas de comparable » est une reponse ─────────────────────────

test('d) des vacances qui n\'existaient pas l\'an dernier : PAS DE COMPARABLE', () => {
  const seul = [
    { zone: 'C', nom: 'Vacances de la Toussaint', date_debut: '2026-10-17', date_fin: '2026-11-01' }
  ]
  const r = nuitComparable('2026-10-24', { contexte: ctx(seul) })
  assert.strictEqual(r.etage, ETAGES.AUCUN)
  assert.strictEqual(r.alignement, ALIGNEMENTS.AUCUN)
  assert.strictEqual(r.date, null)
  // ⚠ AUCUN CHIFFRE FORCE. Le repli silencieux sur 52 semaines aurait rendu le
  // 25 octobre 2025, hors vacances : credible, et faux.
  assert.strictEqual(r.raison, 'vacances_absentes_de_l_an_dernier')
})

test('d) un contexte qui ne couvre pas le N-1 ne fabrique rien', () => {
  const court = construireContexte({ zoneBien: 'C', vacances: [],
    debut: '2026-01-01', fin: '2026-12-31' })
  const r = nuitComparable('2026-10-09', { contexte: court })
  assert.strictEqual(r.etage, ETAGES.AUCUN)
  assert.strictEqual(r.date, null)
})

test('une date invalide rend null, jamais une date inventee', () => {
  for (const d of [null, undefined, '2026-13-01', 'hier', '2026-2-3']) {
    assert.strictEqual(nuitComparable(d, { contexte: ctx() }), null, String(d))
  }
})

// ─── Invariants ─────────────────────────────────────────────────────────────

test('invariant : 365 nuits, aucun appariement aberrant', () => {
  const c = ctx([...TOUSSAINT, ...HIVER])
  let jour = '2026-01-01'
  let n = 0
  let sans = 0
  while (jour <= '2026-12-31') {
    const r = nuitComparable(jour, { contexte: c })
    assert.ok(r, `aucune reponse pour ${jour}`)
    if (r.date) {
      // ⚠ TOUJOURS ANTERIEURE, ET DANS L'ANNEE PRECEDENTE. Un appariement qui
      // partirait en avant comparerait une nuit a une nuit pas encore vendue.
      assert.ok(r.date < jour, `${jour} -> ${r.date} : pas anterieure`)
      assert.ok(Math.abs(r.ecart_jours) <= 40,
        `${jour} -> ${r.date} : ${r.ecart_jours} jours d'ecart au nominal`)
      // Hors etage a, le jour de semaine est TENU : c'est la promesse du module.
      // ⚠ SAUF LES PONTS, et c'est la definition qui le veut. Un pont n'a pas
      // de jour de semaine fixe : le 11 novembre 2026 est un mercredi et
      // produit quatre ponts, celui de 2025 tombait un mardi et n'en produisait
      // qu'un. Un pont reste plus comparable a un pont qu'a un jour ordinaire.
      if (r.etage !== 'a' && r.alignement !== ALIGNEMENTS.PONT) {
        assert.strictEqual(r.meme_jour, true, `${jour} -> ${r.date} (etage ${r.etage})`)
      }
      // ⚠ A L'ETAGE c, LE SEGMENT EST LE CRITERE : il ne peut pas lacher.
      // A l'etage b, le critere est la POSITION dans l'evenement, et le segment
      // peut differer — voir le test du 31 octobre juste au-dessus.
      if (r.etage === 'c') {
        assert.strictEqual(r.meme_segment, true, `${jour} -> ${r.date} : segment`)
      }
    } else sans++
    jour = new Date(Date.parse(`${jour}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)
    n++
  }
  assert.strictEqual(n, 365)
  // Sur une annee complete avec un contexte complet, « pas de comparable » doit
  // rester l'exception — sinon la colonne serait vide et le module inutile.
  assert.ok(sans < 20, `${sans} nuits sans comparable, c'est trop`)
})

test('un pont s\'apparie au pont du MEME ferie, meme en changeant de jour', () => {
  // ⚠ CAS REEL, trouve par l'invariant sur 365 nuits.
  // 11 novembre 2026 = mercredi -> ponts lundi 9, mardi 10, jeudi 12, vendredi 13.
  // 11 novembre 2025 = mardi    -> un seul pont, le lundi 10.
  // Le mardi 10 novembre 2026 n'a donc aucun pont du meme jour de semaine en
  // 2025 : il s'apparie au lundi 9... pardon, au lundi 10, qui EST un pont du
  // meme ferie. C'est la bonne reponse — un vendredi ordinaire ne l'aurait pas
  // ete.
  const c = ctx()
  const r = nuitComparable('2026-11-10', { contexte: c })
  assert.strictEqual(r.alignement, ALIGNEMENTS.PONT)
  assert.strictEqual(r.date, '2025-11-10')
  assert.strictEqual(r.meme_segment, true)
  assert.strictEqual(r.meme_jour, false)

  // Quand le meme jour de semaine EXISTE, c'est lui qui est retenu.
  // Jeudi 12 novembre 2026 : pas de jeudi pont en 2025 non plus, donc on
  // verifie sur l'Ascension, dont le pont est un vendredi les deux annees.
  const asc = nuitComparable('2026-05-15', { contexte: c })
  assert.strictEqual(asc.alignement, ALIGNEMENTS.PONT)
  assert.strictEqual(asc.date, '2025-05-30')
  assert.strictEqual(asc.meme_jour, true)
})

test('invariant : seul « hors vacances » atteint l\'etage c', () => {
  // ⚠ CE QUE LA CONTRE-EPREUVE A REVELE : a l'etage c, comparer `segment` ou
  // `detail` donne exactement le meme resultat — parce que feries, ponts et
  // vacances ont tous ete tranches plus haut dans la cascade. Ce n'est donc pas
  // une garde non testee, c'est une distinction sans difference. Ce test
  // verrouille la raison plutot que la ligne.
  const c = ctx([...TOUSSAINT, ...HIVER])
  let jour = '2026-01-01'
  while (jour <= '2026-12-31') {
    const r = nuitComparable(jour, { contexte: c })
    if (r.etage === ETAGES.RANG_DANS_LE_MOIS) {
      // ⚠ DEUX SEGMENTS ATTEIGNENT L'ETAGE c, PAS UN. Feries, ponts, vacances
      // et evenements sont tranches plus haut dans la cascade ; restent les
      // nuits ordinaires ET les week-ends prolonges (segment derive, ajoute le
      // 13 septembre 2026). Pour les deux, comparer `segment` ou `detail`
      // donne le meme resultat : la distinction reste sans difference.
      assert.ok(['hors_vacances', 'week_end_prolonge']
        .includes(segmenterJour(jour, c).segment),
      `${jour} atteint l'etage c avec un segment inattendu`)
    }
    jour = new Date(Date.parse(`${jour}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)
  }
})

test('invariant : deterministe, deux appels rendent la meme nuit', () => {
  const c = ctx([...TOUSSAINT, ...HIVER])
  for (const d of ['2026-02-28', '2026-10-24', '2026-11-01', '2026-10-09',
    '2026-12-31', '2026-04-06']) {
    assert.strictEqual(nuitComparable(d, { contexte: c }).date,
      nuitComparable(d, { contexte: c }).date, d)
  }
})
