// tests/yield-exceptions.test.js
// LE DEFAUT QU'ILS EMPECHENT : une periode declaree « hors reference » qui
// rentre quand meme dans la reference. Silencieusement — le moteur croirait
// que la demande s'effondre a cette saison et suggererait de brader.
//
// Spec : docs/specs/spec-yieldflow-v1.md §5 (lot 2.2)

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const {
  exceptionsDuBien, joursExclus, creerException, supprimerException, periodeValide
} = require('../lib/yield/exceptions')

const BIEN = 'b-1'
const HOTE = 'u-1'

function fausseBase (lignes = []) {
  const table = [...lignes]
  let seq = 0
  return {
    table,
    from (t) {
      assert.equal(t, 'yield_exceptions', 'le writer ne touche que sa table')
      const f = { eq: [], lte: null, gte: null }
      let action = 'select'
      let charge = null
      const q = {
        select () { return q },
        insert (r) { action = 'insert'; charge = r; return q },
        delete () { action = 'delete'; return q },
        eq (c, v) { f.eq.push([c, v]); return q },
        lte (c, v) { f.lte = [c, v]; return q },
        gte (c, v) { f.gte = [c, v]; return q },
        order () { return q },
        single () { q._single = true; return q },
        then (res) { return Promise.resolve(exec(q._single)).then(res) }
      }
      function filtre (l) {
        for (const [c, v] of f.eq) if (l[c] !== v) return false
        if (f.lte && !(l[f.lte[0]] <= f.lte[1])) return false
        if (f.gte && !(l[f.gte[0]] >= f.gte[1])) return false
        return true
      }
      function exec (single) {
        if (action === 'insert') {
          // La base refuse ce que la migration refuse.
          if (charge.date_fin < charge.date_debut) {
            return { data: null, error: { message: 'violates check constraint periode_valide' } }
          }
          if (!String(charge.motif || '').trim()) {
            return { data: null, error: { message: 'violates check constraint motif_non_vide' } }
          }
          const l = { id: `e${++seq}`, created_at: new Date().toISOString(), ...charge }
          table.push(l)
          return { data: single ? l : [l], error: null }
        }
        if (action === 'delete') {
          const touchees = table.filter(filtre)
          for (const l of touchees) table.splice(table.indexOf(l), 1)
          return { data: touchees.map(l => ({ id: l.id })), error: null }
        }
        const out = table.filter(filtre).sort((a, b) => a.date_debut.localeCompare(b.date_debut))
        return { data: out, error: null }
      }
      return q
    }
  }
}

test('periodeValide : bornes incluses, dates impossibles refusees', () => {
  assert.equal(periodeValide('2026-06-01', '2026-06-30'), true)
  assert.equal(periodeValide('2026-06-01', '2026-06-01'), true, 'un jour unique est une periode')
  assert.equal(periodeValide('2026-06-30', '2026-06-01'), false, 'fin avant debut')
  assert.equal(periodeValide('2026-13-01', '2026-13-05'), false, 'mois impossible')
  assert.equal(periodeValide('2026-02-30', '2026-03-01'), false, '30 fevrier')
})

test('LE TEST QUI COMPTE : une exception qui DEBORDE la fenetre ressort quand meme', async () => {
  // ⚠ CROISEMENT, PAS INCLUSION.
  // Une exception du 1er au 30 juin doit ressortir quand le moteur interroge la
  // seule semaine du 15 au 21. La tester par inclusion
  // (`date_debut >= debut AND date_fin <= fin`) la manquerait, et la semaine
  // entrerait dans la reference alors qu'elle en est explicitement exclue.
  const sb = fausseBase([
    { id: 'e1', property_id: BIEN, date_debut: '2026-06-01', date_fin: '2026-06-30', motif: 'travaux' }
  ])
  const dedans = await exceptionsDuBien(sb, BIEN, '2026-06-15', '2026-06-21')
  assert.equal(dedans.length, 1, 'une exception englobante ressort')

  const avant = await exceptionsDuBien(sb, BIEN, '2026-05-01', '2026-06-01')
  assert.equal(avant.length, 1, 'un chevauchement d un seul jour suffit (bornes incluses)')

  const apres = await exceptionsDuBien(sb, BIEN, '2026-06-30', '2026-07-15')
  assert.equal(apres.length, 1, 'idem a l autre borne')

  const disjointe = await exceptionsDuBien(sb, BIEN, '2026-07-01', '2026-07-31')
  assert.equal(disjointe.length, 0, 'une periode disjointe ne ressort pas')
})

test('joursExclus : l union des jours, bornee a la fenetre demandee', async () => {
  const sb = fausseBase([
    { id: 'e1', property_id: BIEN, date_debut: '2026-06-01', date_fin: '2026-06-30', motif: 'travaux' },
    // Chevauchement volontaire : deux faits distincts, tous deux vrais.
    { id: 'e2', property_id: BIEN, date_debut: '2026-06-15', date_fin: '2026-07-05', motif: 'fermeture' }
  ])
  const exclus = await joursExclus(sb, BIEN, '2026-06-10', '2026-06-20')
  assert.equal(exclus.size, 11, 'du 10 au 20 inclus')
  assert.ok(exclus.has('2026-06-10') && exclus.has('2026-06-20'))
  // Une exception qui deborde n'elargit PAS la reponse.
  assert.ok(!exclus.has('2026-06-09'))
  assert.ok(!exclus.has('2026-06-21'))
  // Un jour couvert par DEUX exceptions n'est exclu qu'une fois.
  assert.equal([...exclus].length, new Set([...exclus]).size)
})

test('le chevauchement est AUTORISE : deux motifs distincts coexistent', async () => {
  const sb = fausseBase()
  await creerException(sb, { userId: HOTE, propertyId: BIEN, debut: '2026-06-01', fin: '2026-06-30', motif: 'travaux' })
  await creerException(sb, { userId: HOTE, propertyId: BIEN, debut: '2026-06-15', fin: '2026-06-20', motif: 'fermeture personnelle' })
  const toutes = await exceptionsDuBien(sb, BIEN, '2026-06-01', '2026-06-30')
  assert.equal(toutes.length, 2, 'les fusionner perdrait le motif de l une')
})

test('la creation refuse ce que la base refuse', async () => {
  const sb = fausseBase()
  await assert.rejects(() => creerException(sb, { userId: HOTE, propertyId: BIEN, debut: '2026-06-30', fin: '2026-06-01', motif: 'x' }),
    /periode invalide/)
  await assert.rejects(() => creerException(sb, { userId: HOTE, propertyId: BIEN, debut: '2026-06-01', fin: '2026-06-30', motif: '   ' }),
    /motif requis/)
  await assert.rejects(() => creerException(sb, { userId: HOTE, propertyId: BIEN, debut: '2026-06-01', fin: '2026-06-30', motif: 'x'.repeat(501) }),
    /motif trop long/)
  await assert.rejects(() => creerException(sb, { userId: null, propertyId: BIEN, debut: '2026-06-01', fin: '2026-06-30', motif: 'x' }),
    /requis/)
  assert.equal(sb.table.length, 0, 'aucune ligne ecrite')
})

test('le motif est nettoye, jamais stocke avec ses espaces', async () => {
  const sb = fausseBase()
  const c = await creerException(sb, { userId: HOTE, propertyId: BIEN, debut: '2026-06-01', fin: '2026-06-30', motif: '  travaux  ' })
  assert.equal(c.motif, 'travaux')
})

test('la suppression exige le BIEN, pas seulement l id', async () => {
  // Sans ce second filtre, un id devine suffirait a supprimer l exception d un
  // autre compte. L endpoint verifie deja le droit sur le bien ; cette ceinture
  // rend l erreur impossible ici aussi.
  // ⚠ UN ID REELLEMENT UUID : la colonne est de type `uuid`, et le writer
  // refuse desormais tout ce qui n'en est pas un — sinon la requete echouerait
  // au lieu de rendre zero ligne.
  const ID = '11111111-1111-4111-8111-111111111111'
  const sb = fausseBase([
    { id: ID, property_id: BIEN, date_debut: '2026-06-01', date_fin: '2026-06-30', motif: 'travaux' }
  ])
  const autre = await supprimerException(sb, { propertyId: 'b-AUTRE', id: ID })
  assert.equal(autre.supprimees, 0, 'un autre bien ne supprime rien')
  assert.equal(sb.table.length, 1)

  const bon = await supprimerException(sb, { propertyId: BIEN, id: ID })
  assert.equal(bon.supprimees, 1)
  assert.equal(sb.table.length, 0)
})

test('LE TEST QUI COMPTE : une fenetre invalide LEVE, elle ne rend pas une liste vide', async () => {
  // ⚠ C'ETAIT UNE CONTRADICTION INTERNE, RELEVEE EN REVIEW.
  // Ce module justifie son `throw` sur erreur de lecture par « une exception
  // manquee fait entrer dans la reference une periode ecartee, silencieusement »
  // — puis rendait `[]` sur une borne mal formee. Un `debut=2026-6-1` (mois non
  // padde), ou un parametre repete que Vercel rend en TABLEAU, produisait un
  // 200 « aucune exception declaree » a un hote qui en a declare.
  const sb = fausseBase([
    { id: 'e1', property_id: BIEN, date_debut: '2026-06-01', date_fin: '2026-06-30', motif: 'travaux' }
  ])
  for (const [d, f] of [
    ['2026-6-1', '2026-06-30'],        // mois non padde
    ['2026-06-30', '2026-06-01'],      // inversee
    ['2026-13-01', '2026-13-05'],      // mois impossible
    [['a', 'b'], '2026-06-30']         // parametre repete -> tableau
  ]) {
    await assert.rejects(() => exceptionsDuBien(sb, BIEN, d, f), /periode invalide/,
      `${JSON.stringify(d)} -> ${f} doit lever`)
  }
})

test('joursExclus REFUSE une fenetre demesuree au lieu de l enumerer', async () => {
  // 1900-2999 — la paire exacte des anciennes valeurs par defaut du GET, donc
  // facile a copier — produisait 400 000 iterations et un Set de 400 000
  // entrees A CHAQUE appel du moteur.
  const sb = fausseBase()
  await assert.rejects(() => joursExclus(sb, BIEN, '1900-01-01', '2999-12-31'),
    /fenetre trop longue/)
})

test('un id non-UUID ne supprime rien, et ne fait pas echouer la requete', async () => {
  // `.eq('id', 'abc')` sur une colonne `uuid` fait ECHOUER la requete, pas
  // rendre zero ligne : l'erreur remontait jusqu'au 503 « service
  // indisponible » et partait dans les logs comme une panne d'infra.
  const sb = fausseBase([
    { id: '11111111-1111-4111-8111-111111111111', property_id: BIEN, date_debut: '2026-06-01', date_fin: '2026-06-30', motif: 'x' }
  ])
  const r = await supprimerException(sb, { propertyId: BIEN, id: 'abc' })
  assert.equal(r.supprimees, 0)
  assert.equal(sb.table.length, 1, 'rien supprime, et aucune exception levee')
})

test('une erreur de lecture LEVE : une exception manquee est silencieuse', async () => {
  const sb = { from () { return { select () { return this }, eq () { return this }, lte () { return this }, gte () { return this }, order () { return this }, then: (r) => Promise.resolve({ data: null, error: { message: 'timeout' } }).then(r) } } }
  await assert.rejects(() => exceptionsDuBien(sb, BIEN, '2026-06-01', '2026-06-30'), /lecture/)
})

test('LE TEST QUI COMPTE : les deux domaines de droits de l endpoint', () => {
  // Arbitrage de Thierry : ECRITURE sur `reglages` (une exception altere la
  // reference du pricing : meme consequence qu'un prix), LECTURE sur
  // `reservations` (les ecrans de stats doivent pouvoir l afficher, sinon un TO
  // amoindri reste inexplicable).
  const src = fs.readFileSync(path.join(__dirname, '..', 'api/yield-exceptions.js'), 'utf8')
  assert.ok(/domaine: ecriture \? 'reglages' : 'reservations'/.test(src),
    'ecriture -> reglages, lecture -> reservations')
  assert.ok(/niveau: ecriture \? 'write' : 'read'/.test(src))
  assert.ok(/bienRequis: true/.test(src),
    'le bien est REVALIDE serveur : un id client ne designe jamais le bien d un autre')
  assert.ok(/userId: compte/.test(src),
    'on ecrit au nom du compte PROPRIETAIRE, pas de l appelant')
  assert.ok(!/channelCall|fetch\(/.test(src), 'aucun appel provider')

  // Les bornes du GET sont validees : sans cela, un mois non padde rendait
  // 200 « aucune exception » a un hote qui en a declare.
  assert.ok(/estJourISO\(debutBrut\)/.test(src) && /estJourISO\(finBrut\)/.test(src),
    'les bornes fournies sont validees')
  assert.ok(/Array\.isArray\(v\) \? v\[0\] : v/.test(src),
    'un parametre repete (tableau Vercel) est ramene a une chaine')
  assert.ok(/error: 'periode_invalide'/.test(src), 'et rend 400, pas une liste vide')

  // Un id mal forme est une erreur d appelant, pas une panne.
  assert.ok(/UUID_RE\.test\(String\(id\)\)/.test(src))
  assert.ok(/error: 'id_invalide'/.test(src))

  // La regex de classification ne doit pas capturer les defauts de cablage
  // serveur (« supabase requis »), qui sortiraient en 400 sans console.error.
  assert.ok(/periode invalide\|motif requis\|motif trop long/.test(src))
  assert.ok(!/motif trop long\|requis/.test(src),
    'l alternative nue « requis » capturait les erreurs serveur')

  // La fenetre par defaut du GET est BORNEE.
  assert.ok(!/'1900-01-01'/.test(src), 'plus de fenetre millenaire par defaut')
})

test('le script de saisie compte les reservations DU BIEN, pas du compte', () => {
  // Sur un compte a quatre biens, declarer des travaux sur un seul annoncait
  // les reservations des quatre. Le filtre par bien est obligatoire sur cette
  // table, et sa cle est le PROVIDER, pas l uuid.
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts/declarer-exception-yield.js'), 'utf8')
  assert.ok(/\.eq\('property_id', String\(bien\.provider_property_id\)\)/.test(src),
    'filtre sur la cle provider du bien')
  assert.ok(/provider_property_id/.test(src.slice(0, src.indexOf('main()'))),
    'et la colonne est selectionnee — sinon le filtre porterait sur undefined')
  // Une periode future est SIGNALEE, pas refusee : une periode a cheval est
  // legitime, mais un 201 muet laisserait croire a une fermeture.
  assert.ok(/PERIODE ENTIEREMENT FUTURE/.test(src))
  assert.ok(/a cheval sur aujourd/.test(src))
})

test('la table est clee sur l UUID, avec RLS et sans policy d ecriture', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations/2026-09-12-yield-exceptions.sql'), 'utf8')
  assert.ok(/property_id uuid not null\s*\n\s*references public\.properties\(id\) on delete cascade/.test(sql))
  assert.ok(/enable row level security/.test(sql), 'regle 5')
  assert.ok(/for select to authenticated/.test(sql))
  // Une policy d'ecriture court-circuiterait la garde de l'endpoint : la RLS ne
  // connait pas les profils delegues.
  assert.ok(!/for (insert|update|delete)/.test(sql), 'aucune policy d ecriture')
  assert.ok(/revoke insert, update, delete/.test(sql))
  for (const l of sql.split('\n')) assert.ok(l.length <= 60, `ligne > 60 : ${l}`)
})
