// tests/pilote-fenetre.test.js — lot 4.6.0, LA FENETRE ET LES TROIS ETATS.
// Spec : docs/specs/spec-yieldflow-v1.md §2 ter
//
// CE QUE CES TESTS DEFENDENT, dans l'ordre d'importance :
//   1. un bien SANS fenetre ne change pas d'un iota — la garantie du lot ;
//   2. « pas encore ouverte » n'est ni « fermee » ni « non renseignee » :
//      elle sort du calcul, ni au numerateur ni au denominateur ;
//   3. « N mois » se compte comme un humain, pas comme setMonth ;
//   4. l'ecran dit QUAND, pas seulement quoi.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const lire = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

const {
  FENETRE_TYPES, fenetreDuBien, finDeFenetre, estHorsFenetre, dateOuverture
} = require('../lib/pilote-tarifaire')
const { joursOuverts } = require('../lib/yield/capacite')

// ⚠ HORLOGE INJECTEE, DATES FIGEES — regle du depot.
const AUJ = '2026-09-20'
const PILOTE_JOURS = { id: 'b-1', provider: 'channex', base_price: 100,
  pilote_tarifaire: 'yieldflow', pilote_fenetre_type: 'jours', pilote_fenetre_valeur: 10 }
const PILOTE_MOIS = { ...PILOTE_JOURS, pilote_fenetre_type: 'mois', pilote_fenetre_valeur: 1 }
const CALENDRIER = { ...PILOTE_JOURS, pilote_tarifaire: 'calendrier' }
const SANS_FENETRE = { id: 'b-1', provider: 'channex', base_price: 100, pilote_tarifaire: 'yieldflow' }

// ─── 1. La garantie du lot ──────────────────────────────────────────────────
test('LE TEST QUI COMPTE : un bien sans fenetre n a PAS de « hors fenetre »', () => {
  // Mode calendrier avec des colonnes de fenetre remplies : elles sont
  // ignorees, la fenetre est une propriete du PILOTE.
  assert.equal(fenetreDuBien(CALENDRIER), null, 'mode calendrier : jamais de fenetre')
  assert.equal(finDeFenetre(CALENDRIER, AUJ), null)
  assert.equal(estHorsFenetre(CALENDRIER, '2030-01-01', AUJ), false)
  assert.equal(dateOuverture(CALENDRIER, '2030-01-01', AUJ), null)
  // Yieldflow sans fenetre reglee : pareil.
  assert.equal(fenetreDuBien(SANS_FENETRE), null, 'yieldflow non regle : pas de fenetre')
  assert.equal(estHorsFenetre(SANS_FENETRE, '2030-01-01', AUJ), false)
  // Une fenetre a moitie reglee, invalide ou absurde : pas de fenetre.
  for (const b of [
    { ...PILOTE_JOURS, pilote_fenetre_valeur: null },
    { ...PILOTE_JOURS, pilote_fenetre_type: null },
    { ...PILOTE_JOURS, pilote_fenetre_type: 'semaines' },
    { ...PILOTE_JOURS, pilote_fenetre_valeur: 0 },
    { ...PILOTE_JOURS, pilote_fenetre_valeur: -3 },
    { ...PILOTE_JOURS, pilote_fenetre_valeur: 2.5 },
    { ...PILOTE_JOURS, pilote_fenetre_valeur: 'dix' },
    // ⚠ `Number(true)` vaut 1 : une case cochee transmise par un formulaire
    // d'activation aurait donne une fenetre d'UN jour, valide. Releve en review.
    { ...PILOTE_JOURS, pilote_fenetre_valeur: true },
    { ...PILOTE_JOURS, pilote_fenetre_valeur: '10' }
  ]) assert.equal(fenetreDuBien(b), null, JSON.stringify(b))
  assert.deepEqual(FENETRE_TYPES, ['jours', 'mois'], 'deux types, pas trois')
})

// ─── 2. La fenetre, en jours et en mois ─────────────────────────────────────
test('N jours glissants : la derniere nuit ouverte est aujourd hui + N', () => {
  assert.equal(finDeFenetre(PILOTE_JOURS, AUJ), '2026-09-30')
  assert.equal(estHorsFenetre(PILOTE_JOURS, '2026-09-30', AUJ), false, 'la borne est DANS la fenetre')
  assert.equal(estHorsFenetre(PILOTE_JOURS, '2026-10-01', AUJ), true, 'le lendemain est dehors')
  assert.equal(estHorsFenetre(PILOTE_JOURS, '2026-09-01', AUJ), false, 'le passe n est jamais hors fenetre')
  // Le changement d'annee ne casse rien.
  assert.equal(finDeFenetre({ ...PILOTE_JOURS, pilote_fenetre_valeur: 15 }, '2026-12-25'), '2027-01-09')
})

test('LE TEST QUI COMPTE : « N mois » se compte comme un humain, pas comme setMonth', () => {
  // Le 31 janvier + 1 mois : le 28 fevrier, JAMAIS le 3 mars. Un setMonth nu
  // deborde, et une fenetre « d'un mois » aurait fait 31 jours en janvier et
  // 34 en fevrier.
  assert.equal(finDeFenetre(PILOTE_MOIS, '2026-01-31'), '2026-02-28')
  assert.equal(finDeFenetre(PILOTE_MOIS, '2028-01-31'), '2028-02-29', 'annee bissextile')
  assert.equal(finDeFenetre(PILOTE_MOIS, '2026-03-31'), '2026-04-30')
  assert.equal(finDeFenetre(PILOTE_MOIS, '2026-09-20'), '2026-10-20', 'meme jour calendaire')
  assert.equal(finDeFenetre({ ...PILOTE_MOIS, pilote_fenetre_valeur: 6 }, '2026-09-20'), '2027-03-20')
  assert.equal(finDeFenetre({ ...PILOTE_MOIS, pilote_fenetre_valeur: 12 }, '2026-09-20'), '2027-09-20')
})

test('LE TEST QUI COMPTE : l ecran peut dire QUAND — la date d ouverture est celle ou la fenetre atteint la nuit', () => {
  // 10 jours de fenetre : la nuit du 15 octobre s'ouvre le 5 octobre.
  assert.equal(dateOuverture(PILOTE_JOURS, '2026-10-15', AUJ), '2026-10-05')
  // Et ce jour-la, elle est bien la derniere nuit de la fenetre.
  assert.equal(finDeFenetre(PILOTE_JOURS, '2026-10-05'), '2026-10-15', 'coherence des deux sens')
  // ⚠ LA DATE ANNONCEE EST UNE PROMESSE — releve en review. Ma premiere
  // version rendait « le 28 fevrier » pour la nuit du 31 mars, en excusant
  // l'ecart (« c'est le calendrier ») : or le 28 fevrier + 1 mois = le 28
  // mars, la nuit etait ENCORE hors fenetre ce jour-la, et l'hote revenu le
  // jour dit lisait toujours « pas encore ouverte » — la lecture « panne »
  // que la date existe pour empecher. La promesse se verifie dans l'autre
  // sens : le jour annonce, la fenetre ATTEINT la nuit.
  for (const [bien, nuit, auj] of [
    [PILOTE_MOIS, '2026-03-31', '2026-01-15'],
    [PILOTE_MOIS, '2026-03-30', '2026-01-15'],
    [PILOTE_MOIS, '2026-03-29', '2026-01-15'],
    [{ ...PILOTE_MOIS, pilote_fenetre_valeur: 3 }, '2026-05-31', '2026-01-15'],
    [{ ...PILOTE_MOIS, pilote_fenetre_valeur: 1 }, '2028-02-29', '2027-12-01'],
    [PILOTE_JOURS, '2026-12-31', AUJ]
  ]) {
    const o = dateOuverture(bien, nuit, auj)
    assert.ok(o, `${nuit} : une date`)
    assert.ok(finDeFenetre(bien, o) >= nuit, `${nuit} : le ${o}, la fenetre l atteint`)
    assert.equal(estHorsFenetre(bien, nuit, o), false, `${nuit} : plus hors fenetre le ${o}`)
    // Et c'est le PREMIER jour ou c'est vrai : la veille, elle etait encore dehors.
    const veille = new Date(`${o}T00:00:00Z`); veille.setUTCDate(veille.getUTCDate() - 1)
    const v = veille.toISOString().slice(0, 10)
    assert.equal(estHorsFenetre(bien, nuit, v), true, `${nuit} : la veille (${v}) elle etait encore dehors`)
  }
  assert.equal(dateOuverture(PILOTE_MOIS, '2026-03-31', '2026-01-15'), '2026-03-01',
    'le 31 mars s ouvre le 1er mars, pas le 28 fevrier')
  // Une nuit deja dans la fenetre n'a pas de date d'ouverture a venir.
  assert.equal(dateOuverture(PILOTE_JOURS, '2026-09-25', AUJ), null)
  assert.equal(dateOuverture(PILOTE_JOURS, '2026-09-01', AUJ), null, 'ni une nuit passee')
})

// ─── 3. Le denominateur ─────────────────────────────────────────────────────
const ligne = (date, extra = {}) => ({ date, stop_sell: false, avail: 1, rate: 120, ...extra })

test('LE TEST QUI COMPTE : « pas encore ouverte » n est PAS comptee fermee', async () => {
  // Fenetre de 10 jours vue du 20 septembre : ouvertes jusqu'au 30, rien au-dela.
  const lignes = ['2026-09-21', '2026-09-22', '2026-09-23'].map(d => ligne(d))
  const r = await joursOuverts(null, PILOTE_JOURS, '2026-09-21', '2026-10-10',
    { aujourdHui: AUJ, estimerLePasse: false, lignes })
  assert.equal(r.calculable, true)
  assert.equal(r.jours_total, 20)
  assert.equal(r.jours_ouverts, 3, 'les trois nuits avec ligne')
  assert.equal(r.jours_hors_fenetre, 10, 'du 1er au 10 octobre : au-dela de la fenetre')
  // Du 24 au 30 septembre : DANS la fenetre, sans ligne — fermees (vrai), et
  // nommees comme anomalie (le moteur aurait du ouvrir).
  assert.equal(r.jours_fermes, 7, 'seules les nuits dans la fenetre sans ligne sont fermees')
  assert.equal(r.jours_sans_ligne, 7)
  assert.equal(r.jours_attendus_sans_ligne, 7, 'l anomalie est comptee, pas noyee')
  assert.equal(r.jours_ouverts + r.jours_fermes + r.jours_hors_fenetre, r.jours_total,
    'les trois etats partitionnent la periode')
})

test('LE TEST QUI COMPTE : le meme calcul sur un bien CALENDRIER ne change pas', async () => {
  // Memes lignes, meme periode, bien en mode calendrier : les 17 nuits sans
  // ligne sont fermees, comme avant le lot. Aucun compteur neuf ne tire.
  const lignes = ['2026-09-21', '2026-09-22', '2026-09-23'].map(d => ligne(d))
  const r = await joursOuverts(null, CALENDRIER, '2026-09-21', '2026-10-10',
    { aujourdHui: AUJ, estimerLePasse: false, lignes })
  assert.equal(r.jours_ouverts, 3)
  assert.equal(r.jours_fermes, 17, 'convention runFullSync inchangee : sans ligne = fermee')
  assert.equal(r.jours_hors_fenetre, 0)
  assert.equal(r.jours_attendus_sans_ligne, 0)
  // Et un bien yieldflow SANS fenetre reglee : identique.
  const r2 = await joursOuverts(null, SANS_FENETRE, '2026-09-21', '2026-10-10',
    { aujourdHui: AUJ, estimerLePasse: false, lignes })
  assert.deepEqual([r2.jours_fermes, r2.jours_hors_fenetre, r2.jours_attendus_sans_ligne], [17, 0, 0])
})

test('LE TEST QUI COMPTE : une periode ENTIEREMENT hors fenetre a son propre motif, pas « calendrier non enregistre »', async () => {
  // Releve en review : la garde « aucune ligne + futur » tirait AVANT la
  // fenetre. Un mois affiche a +6 mois n'a aucune ligne : la tuile disait
  // « son calendrier n'a pas encore ete enregistre » pendant que chaque ligne
  // du meme mois disait « pas encore ouverte ». Deux verites dans une page.
  const { NON_CALCULABLE } = require('../lib/yield/capacite')
  const r = await joursOuverts(null, PILOTE_JOURS, '2026-11-01', '2026-11-30',
    { aujourdHui: AUJ, estimerLePasse: false, lignes: [] })
  assert.equal(r.calculable, false, 'ni au numerateur ni au denominateur : 0/0, non calculable')
  assert.equal(r.raison, NON_CALCULABLE.HORS_FENETRE)
  assert.equal(r.jours_hors_fenetre, 30, 'et le compteur dit que c est la fenetre, pas un oubli')
  assert.equal(r.detail_hors_fenetre.length, 30, 'chaque nuit est nommee, pour l endpoint')
  // Le meme mois pour un bien CALENDRIER : la garde historique, inchangee.
  const r2 = await joursOuverts(null, CALENDRIER, '2026-11-01', '2026-11-30',
    { aujourdHui: AUJ, estimerLePasse: false, lignes: [] })
  assert.equal(r2.raison, NON_CALCULABLE.FUTUR_NON_AMORCE)
  assert.equal(r2.jours_hors_fenetre, 0)
  // Et le motif est TRADUIT : la liste de l'ecran derive du moteur.
  const motifs = lire('shared/yield-motifs.js')
  assert.ok(/periode_hors_fenetre: \{/.test(motifs), 'le motif a sa traduction')
})

test('la classification par nuit est PORTEE par le resultat : l endpoint ne la redecide pas', async () => {
  // Releve en review : « sans ligne et au-dela » etait recalcule dans
  // l'endpoint. Deux endroits encodaient « une ligne reelle prime sur la
  // fenetre » — trois recopies, trois verites.
  const lignes = [ligne('2026-10-05')]
  const r = await joursOuverts(null, PILOTE_JOURS, '2026-10-01', '2026-10-10',
    { aujourdHui: AUJ, estimerLePasse: false, lignes })
  assert.deepEqual(r.detail_hors_fenetre,
    ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-06',
     '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10'],
    'toutes sauf le 5, qui porte une ligne reelle')
  assert.equal(r.jours_hors_fenetre, r.detail_hors_fenetre.length)
  // Un bien sans fenetre rend une liste vide, jamais null sur un calcul reussi.
  const r2 = await joursOuverts(null, CALENDRIER, '2026-10-01', '2026-10-10',
    { aujourdHui: AUJ, estimerLePasse: false, lignes })
  assert.deepEqual(r2.detail_hors_fenetre, [])
})

test('une ligne REELLE hors fenetre fait foi : la bascule ne change pas', async () => {
  // L'hote a touche une nuit au-dela de la fenetre (fermee a la main, ou
  // ouverte) : c'est SA ligne, elle prime. Seule l'absence de ligne est lue
  // « pas encore ouverte ».
  const lignes = [ligne('2026-10-05'), ligne('2026-10-06', { stop_sell: true })]
  const r = await joursOuverts(null, PILOTE_JOURS, '2026-10-01', '2026-10-10',
    { aujourdHui: AUJ, estimerLePasse: false, lignes })
  assert.equal(r.jours_ouverts, 1, 'le 5 : ligne ouverte, hors fenetre ou pas')
  assert.equal(r.jours_fermes, 1, 'le 6 : fermee par l hote, hors fenetre ou pas')
  assert.equal(r.jours_hors_fenetre, 8, 'les huit autres, sans ligne')
})

test('le passe n est jamais « hors fenetre », meme pour un bien pilote', async () => {
  const r = await joursOuverts(null, PILOTE_JOURS, '2026-09-01', '2026-09-10',
    { aujourdHui: AUJ, estimerLePasse: true, lignes: [] })
  assert.equal(r.calculable, true)
  assert.equal(r.jours_hors_fenetre, 0)
  assert.equal(r.jours_estimes_ouverts, 10, 'convention estimee du passe, inchangee')
})

// ─── 4. L endpoint et l ecran ───────────────────────────────────────────────
test('l endpoint LIT detail_hors_fenetre, il ne recalcule pas la fenetre par nuit', () => {
  // Le comportement est teste en EXECUTANT la capacite (tests ci-dessus) ;
  // ici on ne verifie que le branchement — et qu'aucune seconde decision n'y
  // survit. Releve en review : le test precedent verrouillait la forme exacte
  // d'une ligne, et aurait rougi sur une factorisation sans changement.
  const src = lire('api/yield-prix.js')
  assert.ok(/detail_hors_fenetre/.test(src), 'la classification vient de la capacite')
  assert.ok(!/estHorsFenetre\(/.test(src), 'aucune seconde decision « hors fenetre » dans l endpoint')
  assert.ok(/dateOuverture\(/.test(src), 'seule la DATE est demandee a la regle, et seulement pour une nuit hors fenetre')
})

test('LE TEST QUI COMPTE : l ecran dit « pas encore ouverte », jamais « fermee » ni « non renseignee »', () => {
  const src = lire('apps/yield/prix.html')
  // L'etat est teste AVANT « inconnue » : les deux ont ouverte == null.
  const iAttente = src.indexOf("else if (n.hors_fenetre) etat = 'e-attente'")
  const iInconnue = src.indexOf("else if (n.ouverte == null) etat = 'e-inconnue'")
  assert.ok(iAttente > 0 && iInconnue > 0 && iAttente < iInconnue,
    'hors fenetre se decide avant « inconnue », sinon elle serait « non renseignee »')
  // Le libelle porte la DATE.
  assert.ok(/s’ouvrira le \$\{q\}/.test(src), 'le libelle dit quand')
  assert.ok(/pas encore ouverte/.test(src))
  // Le resume compte a part, et « non renseignee » exclut les hors fenetre.
  assert.ok(/const attente = aVenir\.filter\(n => n\.hors_fenetre && !n\.vendue\)/.test(src))
  assert.ok(/n\.ouverte == null && !n\.vendue && !n\.hors_fenetre/.test(src),
    'une nuit hors fenetre n est pas comptee « non renseignee »')
  // La legende l'explique une fois pour le mois — et SEULEMENT si l'etat peut
  // apparaitre : un hote en mode calendrier n'a pas de fenetre a lire.
  assert.ok(/\$\{a \? b\('#B5C9DA', 'pas encore ouverte'/.test(src), 'legende conditionnelle')
  assert.ok(/const a = \(d\.nuits \|\| \[\]\)\.some\(n => n\.hors_fenetre\)/.test(src))
  // Et son style existe : un etat sans style est invisible (lecon des trois
  // defauts de mise en page du chantier prestataires).
  assert.ok(/\.yp-table tr\.e-attente \{/.test(src), 'la classe a un style')
})

// ─── 5. La migration ────────────────────────────────────────────────────────
test('la migration pose des fenetres NULLES par defaut, et trois contraintes', () => {
  const sql = lire('migrations/2026-09-20-pilote-fenetre.sql')
  assert.ok(/add column if not exists pilote_fenetre_type text;/.test(sql))
  assert.ok(/add column if not exists pilote_fenetre_valeur int;/.test(sql))
  assert.ok(!/default/.test(sql.split('begin;')[1].split('commit;')[0].replace(/--[^\n]*/g, '')),
    'AUCUN defaut : nulles, c est la garantie du lot')
  assert.ok(/in \('jours', 'mois'\)/.test(sql))
  assert.ok(/pilote_fenetre_valeur > 0/.test(sql))
  assert.ok(/\(pilote_fenetre_type is null\)\s*=\s*\(pilote_fenetre_valeur is null\)/.test(sql),
    'les deux ensemble, ou aucune')
  const trop = sql.split('\n').filter(l => l.length > 60)
  assert.deepEqual(trop, [], 'aucune ligne de plus de 60 caracteres (collage manuel)')
})
