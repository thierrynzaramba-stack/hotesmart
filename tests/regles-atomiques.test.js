// tests/regles-atomiques.test.js
// REMPLACER LES JOURS HABITUELS NE LAISSE PLUS D'ETAT A MOITIE ECRIT.
// DOC : docs/kb/menage.md (modif = MEME COMMIT)
//
// ⚠ CE QUE CES TESTS GARDENT. Jusqu'au 16 octobre 2026, remplacer les jours
// habituels d'une prestataire etait DEUX ecritures depuis le navigateur. Entre
// les deux, le reseau pouvait couper :
//   · l'ancien ecran de l'hote desactivait puis reposait — il restait ZERO
//     regle active, c'est-a-dire « disponible TOUS LES JOURS », et le moteur
//     lui attribuait des menages n'importe quel jour ;
//   · la PWA inserait puis desactivait — il restait l'ANCIEN et le NOUVEAU,
//     donc l'union des deux.
// Les deux etats sont faux. Une fonction Postgres est une transaction : soit
// les deux ecritures aboutissent, soit aucune n'a lieu.
//
// ⚠ POURQUOI UN FAUX CLIENT ET PAS LA BASE. Ce que ces tests prouvent est que
// le CODE ne fait plus qu'un seul aller-retour, et qu'il n'ecrit rien a cote
// de la transaction. L'atomicite elle-meme est celle de Postgres — elle se
// prouve en lisant la migration, ce que fait le dernier test.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { remplacerRegles } = require('../lib/cleaning/regles')

// Un faux client qui NOTE tout ce qu'on lui demande : les appels de fonction
// (`rpc`) d'un cote, les ecritures de table de l'autre. C'est la separation qui
// nous interesse — une ecriture de table pendant un remplacement serait,
// justement, l'ecriture hors transaction qu'on vient de supprimer.
function faureClient ({ rpc }) {
  const journal = { rpc: [], tables: [] }
  return {
    journal,
    rpc: async (nom, args) => { journal.rpc.push({ nom, args }); return rpc(args) },
    from (table) {
      const noter = (geste) => (...a) => {
        journal.tables.push({ table, geste, a })
        return this.from(table)
      }
      return {
        insert: noter('insert'), update: noter('update'), delete: noter('delete'),
        select: noter('select'), eq: noter('eq'), in: noter('in'), limit: noter('limit'),
        then: (res) => res({ data: [], error: null })
      }
    }
  }
}

const LOTS_SIMPLES = [{ jours: [1, 3, 5], ancre: '2026-10-12' }]

test('un remplacement = UN SEUL aller-retour, et aucune ecriture a cote', async () => {
  const c = faureClient({ rpc: () => ({ data: { avant: [], posees: 1 }, error: null }) })
  const r = await remplacerRegles(c, {
    userId: 'u1', providerId: 'p1', lots: LOTS_SIMPLES, cadence: 1,
    source: 'hote', maxActives: 50
  })
  assert.ok(!r.erreur, 'le remplacement aboutit')
  assert.strictEqual(c.journal.rpc.length, 1, 'un seul appel de fonction')
  assert.strictEqual(c.journal.rpc[0].nom, 'remplacer_regles_dispo')
  // ⚠ LE COEUR DU TEST. L'ancien code ecrivait ici : un `select` des regles
  // actives, un `insert`, puis un `update`. Trois allers-retours, donc deux
  // fenetres ou le reseau pouvait couper.
  assert.deepStrictEqual(c.journal.tables, [],
    'plus aucune ecriture de table hors de la transaction')
})

test('la fonction recoit la SOURCE et des regles DEJA validees', async () => {
  const c = faureClient({ rpc: () => ({ data: { avant: [], posees: 1 }, error: null }) })
  await remplacerRegles(c, {
    userId: 'u1', providerId: 'p1', lots: LOTS_SIMPLES, cadence: 2,
    source: 'prestataire', maxActives: 50
  })
  const { args } = c.journal.rpc[0]
  assert.strictEqual(args.p_source, 'prestataire',
    'c\'est l\'appelant qui dit qui pose — la fiche ou sa page')
  assert.strictEqual(args.p_user_id, 'u1')
  assert.strictEqual(args.p_provider_id, 'p1')
  // ⚠ LA RRULE EST CONSTRUITE EN JAVASCRIPT, PAS EN SQL. Une seconde
  // construction cote base finirait par diverger de `validerRegle`.
  assert.strictEqual(args.p_regles.length, 1)
  // La RRULE porte son DTSTART : c'est lui qui ancre la quinzaine.
  assert.match(args.p_regles[0].rrule, /^DTSTART:\d{8}T/)
  assert.match(args.p_regles[0].rrule, /RRULE:FREQ=WEEKLY/)
  assert.match(args.p_regles[0].rrule, /INTERVAL=2/, 'la quinzaine descend bien')
  assert.ok(args.p_regles[0].label, 'le libelle part avec, il est lu par les deux ecrans')
})

test('une erreur de la transaction ne laisse RIEN d\'ecrit', async () => {
  // ⚠ C'EST LE SCENARIO QUE CE CHANTIER FERME. Avant, une panne au milieu
  // laissait la moitie du reglage en base — zero regle d'un cote, l'union de
  // l'autre. Ici, l'erreur remonte et le journal des tables reste vide : il n'y
  // a rien eu a defaire, parce qu'il n'y a rien eu d'ecrit hors transaction.
  const c = faureClient({ rpc: () => ({ data: null, error: { code: '08006', message: 'connexion perdue' } }) })
  const r = await remplacerRegles(c, {
    userId: 'u1', providerId: 'p1', lots: LOTS_SIMPLES, cadence: 1,
    source: 'hote', maxActives: 50
  })
  assert.strictEqual(r.erreur, 'ecriture')
  assert.strictEqual(r.status, 503)
  assert.deepStrictEqual(c.journal.tables, [], 'aucune ecriture partielle')
})

test('la migration absente se DIT, et ne retombe pas sur l\'ancien chemin', async () => {
  // ⚠ PAS DE REPLI SILENCIEUX. Retomber sur la mecanique en deux ecritures —
  // celle qu'on vient de juger mauvaise — rendrait le defaut invisible le jour
  // ou la migration manque. L'appelant journalise « migration NON APPLIQUEE »
  // et refuse : le symptome se lit dans les logs, pas dans le navigateur.
  const c = faureClient({ rpc: () => ({ data: null, error: { code: '42883', message: 'function public.remplacer_regles_dispo does not exist' } }) })
  const r = await remplacerRegles(c, {
    userId: 'u1', providerId: 'p1', lots: LOTS_SIMPLES, cadence: 1,
    source: 'hote', maxActives: 50
  })
  assert.strictEqual(r.erreur, 'rpc_absente')
  assert.deepStrictEqual(c.journal.tables, [])
})

test('un corps invalide est refuse AVANT tout appel', async () => {
  // Valider lot par lot en ecrivant au fil de l'eau laisserait la moitie d'un
  // reglage en base sur un corps a moitie faux.
  const c = faureClient({ rpc: () => ({ data: { avant: [], posees: 0 }, error: null }) })
  const r = await remplacerRegles(c, {
    userId: 'u1', providerId: 'p1', cadence: 1, source: 'hote', maxActives: 50,
    lots: [{ jours: [1] }, { jours: [9] }]
  })
  assert.strictEqual(r.status, 400)
  assert.strictEqual(c.journal.rpc.length, 0, 'rien n\'est parti')
})

test('une ligne VIDE est legitime, et ne pose rien', async () => {
  // « Aucun jour cette semaine-la » est un reglage, pas une erreur de saisie.
  const c = faureClient({ rpc: () => ({ data: { avant: [], posees: 1 }, error: null }) })
  await remplacerRegles(c, {
    userId: 'u1', providerId: 'p1', cadence: 2, source: 'hote', maxActives: 50,
    lots: [{ jours: [1], ancre: '2026-10-12' }, { jours: [] }]
  })
  assert.strictEqual(c.journal.rpc[0].args.p_regles.length, 1)
})

test('la forme d\'AVANT vient de la transaction, pas d\'une lecture a cote', async () => {
  // ⚠ Entre une lecture faite a cote et l'ecriture, l'autre ecran a pu poser
  // quelque chose : la forme d'avant serait alors celle d'un etat qui n'a
  // jamais existe. C'est elle qui sert a ANNONCER le changement.
  const c = faureClient({ rpc: () => ({ data: { avant: [{ id: 'r1', rrule: 'FREQ=WEEKLY;BYDAY=SA' }], posees: 1 }, error: null }) })
  const r = await remplacerRegles(c, {
    userId: 'u1', providerId: 'p1', lots: LOTS_SIMPLES, cadence: 1,
    source: 'hote', maxActives: 50
  })
  assert.deepStrictEqual(r.avant, [{ id: 'r1', rrule: 'FREQ=WEEKLY;BYDAY=SA' }])
  assert.deepStrictEqual(r.formes, [{ jours: [1, 3, 5], cadence: 1 }])
})

test('LE PLAFOND EST UNE SEULE BORNE : module, SQL, et les deux endpoints', () => {
  // ⚠ LE DEFAUT QUE CE TEST FERME, ET IL ETAIT DEJA EN BASE. `api/menages-public.js`
  // declarait 50, `api/disponibilites.js` 200, et les deux passaient leur
  // chiffre a la MEME fonction Postgres : la meme prestataire pouvait etre
  // reglable depuis un ecran et refusee depuis l'autre, sans que rien ne
  // l'explique. C'est le defaut classique d'une regle recopiee — les copies
  // derivent, et la plus permissive gagne par accident.
  const { MAX_REGLES_ACTIVES } = require('../lib/cleaning/regles')
  assert.strictEqual(typeof MAX_REGLES_ACTIVES, 'number')

  // Le defaut de la fonction SQL doit valoir le meme chiffre : un appelant qui
  // oublierait l'argument tomberait sinon sur une autre borne.
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '2026-10-16-regles-atomiques.sql'), 'utf8')
  const defautSql = /p_max_actives int default (\d+)/.exec(sql)
  assert.ok(defautSql, 'la fonction porte un defaut')
  assert.strictEqual(Number(defautSql[1]), MAX_REGLES_ACTIVES,
    'le defaut SQL et la borne du module disent le meme chiffre')

  // Et aucun endpoint ne redeclare la sienne.
  for (const f of ['api/menages-public.js', 'api/disponibilites.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
      .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
    assert.ok(!/const MAX_REGLES_ACTIVES\s*=\s*\d/.test(src),
      f + ' ne redeclare pas la borne, il l\'importe')
  }
})

test('un plafond atteint se DIT, et ne se lit pas comme une panne', async () => {
  // ⚠ « Service temporairement indisponible » ferait reessayer indefiniment un
  // geste qui echouera toujours. Le refus porte un 409 — un conflit d'etat,
  // pas une panne — et une phrase qui dit quoi faire.
  const c = faureClient({ rpc: () => ({ data: null, error: { code: '54000', message: 'trop de regles actives: 51' } }) })
  const r = await remplacerRegles(c, {
    userId: 'u1', providerId: 'p1', lots: LOTS_SIMPLES, cadence: 1, source: 'hote'
  })
  assert.strictEqual(r.erreur, 'plafond')
  // Les deux endpoints traduisent ce motif en phrase : on verifie qu'ils le
  // reconnaissent, et qu'ils ne le noient pas dans le cas general.
  for (const f of ['api/menages-public.js', 'api/disponibilites.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
    assert.match(src, /r\.erreur === 'plafond'/, f + ' reconnait le plafond')
    assert.match(src, /status\(409\)/, f + ' le dit en 409, pas en 503')
  }
})

test('la migration desactive PAR ID, insere, et ne valide pas a cote', () => {
  // ⚠ CE QUE LA MIGRATION DOIT DIRE, et qu'aucun stub ne peut prouver.
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '2026-10-16-regles-atomiques.sql'), 'utf8')
  assert.match(sql, /language plpgsql/, 'un bloc plpgsql — donc une transaction')
  // Desactiver par un filtre `active = true` SEUL emporterait ce qu'on vient
  // d'inserer : l'appartenance a la liste des ids relevee avant est la garde.
  assert.match(sql, /id in \(\s*\n\s*select \(e->>'id'\)::uuid/,
    'la desactivation porte sur les ids releves, pas sur un filtre seul')
  assert.ok(sql.indexOf('update public.provider_availability_rules') <
            sql.indexOf('insert into public.provider_availability_rules'),
    'desactiver puis inserer : dans une transaction, l\'ordre redevient libre')
  // ⚠ AUCUNE VALIDATION EN SQL. Les jours, la cadence et la RRULE sont
  // valides par `lib/cleaning/regles.js`, partage par les deux ecrans ; une
  // seconde validation ici finirait par en diverger.
  assert.ok(!/BYDAY|FREQ=WEEKLY/.test(sql),
    'la RRULE n\'est pas construite en base')
  assert.match(sql, /revoke all on function/,
    'aucun role anonyme ne peut l\'appeler')
})
