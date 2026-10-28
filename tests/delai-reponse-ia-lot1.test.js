// tests/delai-reponse-ia-lot1.test.js
// Chantier « delai de reponse IA » (GuestFlow), LOT 1 — le socle.
// Spec : docs/specs/spec-delai-reponse-ia.md
//
// Ce que ce lot doit prouver, et c'est la condition de sa remise :
// **a la fin du lot 1, la production se comporte exactement comme avant.**
// Donc la moitie de ce fichier teste des EQUIVALENCES, pas des nouveautes.
//
// ⚠ DATES : ces tests n'ont aucune horloge dans leur objet (le lot 1 ne pose
// aucune echeance). Les dates du lot 2 seront INJECTEES — regle du depot :
// dates relatives si le test lit l'horloge, dates figees s'il injecte le temps.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const COMPTE = 'compte-prod'
const BIEN = '0544fd9a'

// ─── Le banc ────────────────────────────────────────────────────────────────
// `config` = le blob tel qu'il est EN BASE. `etat.ecritures` recoit les upserts,
// ce qui permet de lire ce que le serveur a REELLEMENT voulu ecrire — pas ce
// qu'on suppose qu'il a ecrit.
function preparer ({ config = null, lectureEnPanne = false } = {}) {
  const etat = { ecritures: [] }
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: COMPTE } }, error: null }) },
    from (nom) {
      const q = {
        _f: {},
        select () { return q }, eq (c, v) { q._f[c] = v; return q },
        limit () { return q }, order () { return q }, not () { return q }, is () { return q },
        upsert (r) { etat.ecritures.push({ table: nom, row: r }); return Promise.resolve({ error: null }) },
        single: async () => rep(nom), maybeSingle: async () => rep(nom)
      }
      function rep (nom) {
        if (nom === 'agent_alert_config') {
          if (lectureEnPanne) throw new Error('lecture impossible')
          return { data: config ? { config } : null, error: null }
        }
        return { data: null, error: null }
      }
      return q
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of ['../lib/cron-shared', '../api/agent-config', '../lib/require-permission']) {
    try { delete require.cache[require.resolve(mod)] } catch {}
  }
  return etat
}

function reponse () {
  const r = { code: null, body: null }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  r.setHeader = () => {}
  r.end = () => r
  return r
}

async function postConfig (corps, options = {}) {
  const etat = preparer(options)
  const handler = require('../api/agent-config')
  const res = reponse()
  await handler({ method: 'POST', headers: { authorization: 'Bearer jeton' }, body: corps }, res)
  return { res, etat }
}

// ════════════════════════════════════════════════════════════════════════════
// A. `getPropertyMode` DERIVE le binaire — et son contrat ne change pas
// ════════════════════════════════════════════════════════════════════════════

test('getPropertyMode : reponse_ia = null -> test (Validation manuelle)', async () => {
  preparer({ config: { [BIEN]: { delais: { reponse_ia: null, alerte_info: 0 } } } })
  const { getPropertyMode } = require('../lib/cron-shared')
  assert.equal(await getPropertyMode(COMPTE, BIEN), 'test')
})

test('getPropertyMode : reponse_ia = 0 -> auto (immediat, comme le Mode Auto)', async () => {
  preparer({ config: { [BIEN]: { delais: { reponse_ia: 0, alerte_info: 0 } } } })
  const { getPropertyMode } = require('../lib/cron-shared')
  assert.equal(await getPropertyMode(COMPTE, BIEN), 'auto')
})

test('getPropertyMode : reponse_ia = 15 -> auto (ca part, dans 15 min)', async () => {
  // ⚠ LE POINT LE PLUS IMPORTANT DU LOT 1. Un delai non nul rend « auto »,
  // donc un MODELE PROGRAMME (cron-messages, cron-arrival-code) continue de
  // partir sans validation. Si ce test disait 'test', regler un delai de
  // reponse IA retiendrait aussi les messages d'arrivee et les codes d'acces —
  // un changement de comportement que personne n'a demande.
  preparer({ config: { [BIEN]: { delais: { reponse_ia: 15, alerte_info: 15 } } } })
  const { getPropertyMode } = require('../lib/cron-shared')
  assert.equal(await getPropertyMode(COMPTE, BIEN), 'auto')
})

test('getPropertyMode : sans bloc delais, le repli sur `mode` tient (bascule)', async () => {
  preparer({ config: { [BIEN]: { mode: 'auto' } } })
  const { getPropertyMode } = require('../lib/cron-shared')
  assert.equal(await getPropertyMode(COMPTE, BIEN), 'auto')
})

test('getPropertyMode : aucune entree -> test (le repli sur d avant)', async () => {
  preparer({ config: {} })
  const { getPropertyMode } = require('../lib/cron-shared')
  assert.equal(await getPropertyMode(COMPTE, BIEN), 'test')
})

test('getPropertyMode : bloc delais SANS reponse_ia -> repli sur `mode`', async () => {
  // Un bloc partiel (ecrit par le POST legacy, ou une forme future) ne doit pas
  // se lire comme « validation manuelle » par accident.
  preparer({ config: { [BIEN]: { mode: 'auto', delais: { alerte_info: 15 } } } })
  const { getPropertyMode } = require('../lib/cron-shared')
  assert.equal(await getPropertyMode(COMPTE, BIEN), 'auto')
})

test('getPropertyMode : delais en TABLEAU -> repli sur `mode`, pas de levee', async () => {
  preparer({ config: { [BIEN]: { mode: 'auto', delais: [] } } })
  const { getPropertyMode } = require('../lib/cron-shared')
  assert.equal(await getPropertyMode(COMPTE, BIEN), 'auto')
})

test('getPropertyMode : panne de lecture -> test (repli SUR : rien ne part)', async () => {
  preparer({ lectureEnPanne: true })
  const { getPropertyMode } = require('../lib/cron-shared')
  assert.equal(await getPropertyMode(COMPTE, BIEN), 'test')
})

test('lireReglagesDuBien : rend toujours un objet, delais a null si absent', async () => {
  preparer({ config: { [BIEN]: { mode: 'auto' } } })
  const { lireReglagesDuBien } = require('../lib/cron-shared')
  assert.deepEqual(await lireReglagesDuBien(COMPTE, BIEN), { mode: 'auto', delais: null })
})

// ════════════════════════════════════════════════════════════════════════════
// B. La cible `delais` de /api/agent-config
// ════════════════════════════════════════════════════════════════════════════

test('agent-config : une charge valide est ecrite, et le reste du bien est PRESERVE', async () => {
  const { res, etat } = await postConfig(
    { delais_ref: BIEN, delais: { reponse_ia: 15, alerte_info: 15, sourdine: { active: true, debut: '22:00', fin: '08:00' } } },
    { config: { [BIEN]: { mode: 'auto', intervention: { sms_enabled: true, sms_lines: '+33600000000' } }, 'autre-bien': { mode: 'test' } } }
  )
  assert.equal(res.code, 200)
  const ecrit = etat.ecritures.find(e => e.table === 'agent_alert_config')
  assert.ok(ecrit, 'un upsert est parti')
  const blob = ecrit.row.config
  assert.deepEqual(blob[BIEN].delais, { reponse_ia: 15, alerte_info: 15, sourdine: { active: true, debut: '22:00', fin: '08:00' } })
  assert.equal(blob[BIEN].mode, 'auto', 'le mode du bien survit')
  assert.deepEqual(blob[BIEN].intervention, { sms_enabled: true, sms_lines: '+33600000000' }, 'les alertes du bien survivent')
  assert.deepEqual(blob['autre-bien'], { mode: 'test' }, 'les AUTRES biens survivent')
})

test('agent-config : reponse_ia = null est une VALEUR valide (validation manuelle)', async () => {
  const { res, etat } = await postConfig({ delais_ref: BIEN, delais: { reponse_ia: null, alerte_info: 0 } })
  assert.equal(res.code, 200)
  assert.equal(etat.ecritures.find(e => e.table === 'agent_alert_config').row.config[BIEN].delais.reponse_ia, null)
})

test('agent-config : sourdine absente -> inactive par defaut, jamais active', async () => {
  const { res, etat } = await postConfig({ delais_ref: BIEN, delais: { reponse_ia: 15, alerte_info: 15 } })
  assert.equal(res.code, 200)
  assert.deepEqual(etat.ecritures.find(e => e.table === 'agent_alert_config').row.config[BIEN].delais.sourdine,
    { active: false, debut: '22:00', fin: '08:00' })
})

for (const [etiquette, delais] of [
  ['reponse_ia au-dela de 24 h', { reponse_ia: 1441, alerte_info: 0 }],
  ['reponse_ia non entier', { reponse_ia: 15.5, alerte_info: 0 }],
  ['reponse_ia negatif', { reponse_ia: -1, alerte_info: 0 }],
  ['reponse_ia en chaine', { reponse_ia: '15', alerte_info: 0 }],
  ['alerte_info manquant', { reponse_ia: 15 }],
  ['alerte_info null (ce n est PAS une valeur ici)', { reponse_ia: 15, alerte_info: null }],
  ['heure de sourdine illisible', { reponse_ia: 15, alerte_info: 15, sourdine: { active: true, debut: '22h', fin: '08:00' } }],
  ['heure de sourdine hors plage', { reponse_ia: 15, alerte_info: 15, sourdine: { active: true, debut: '24:00', fin: '08:00' } }],
  ['plage de sourdine vide (debut = fin)', { reponse_ia: 15, alerte_info: 15, sourdine: { active: true, debut: '22:00', fin: '22:00' } }],
  ['sourdine en tableau', { reponse_ia: 15, alerte_info: 15, sourdine: [] }],
  ['delais en tableau', []]
]) {
  test(`agent-config : ${etiquette} -> 400, aucune ecriture`, async () => {
    const { res, etat } = await postConfig({ delais_ref: BIEN, delais })
    assert.equal(res.code, 400)
    assert.equal(etat.ecritures.length, 0, 'rien n a ete ecrit')
  })
}

test('agent-config : les heures sont validees MEME sourdine inactive', async () => {
  // Sinon une saisie fautive dort en base et ne mord qu'au jour ou l'hote
  // active la sourdine — des semaines plus tard, sans rapport apparent.
  const { res } = await postConfig({ delais_ref: BIEN, delais: { reponse_ia: 15, alerte_info: 15, sourdine: { active: false, debut: 'nawak', fin: '08:00' } } })
  assert.equal(res.code, 400)
})

// ─── Une cible par requete, avec TROIS cibles ───────────────────────────────

// ⚠ CHAQUE MOITIE DE CHARGE EST VALIDE EN SOI, ET C'EST TOUT L'INTERET.
// Premiere version de ce test : `alertes: {}`. Il passait contre le code
// d'AVANT — mais par la validation des alertes (un objet vide n'a ni
// `intervention` ni `info_unknown`, donc 400), pas par la regle des cibles.
// Un vert obtenu pour la mauvaise raison ne prouve rien : la contre-epreuve
// l'a montre, 10 rouges attendus et un test muet. On verifie donc AUSSI le
// motif rendu.
const ALERTES_VALIDES = {
  intervention: { sms_enabled: false, sms_lines: '', email_enabled: true, email_lines: 'a@b.c' },
  info_unknown: { sms_enabled: false, sms_lines: '', email_enabled: true, email_lines: 'a@b.c' }
}
const DELAIS_VALIDES = { reponse_ia: 0, alerte_info: 0 }

for (const [etiquette, corps] of [
  ['mode + delais', { mode_ref: BIEN, mode: 'auto', delais_ref: BIEN, delais: DELAIS_VALIDES }],
  ['alertes + delais', { alertes_ref: BIEN, alertes: ALERTES_VALIDES, delais_ref: BIEN, delais: DELAIS_VALIDES }],
  ['mode + alertes', { mode_ref: BIEN, mode: 'auto', alertes_ref: BIEN, alertes: ALERTES_VALIDES }]
]) {
  test(`agent-config : deux cibles (${etiquette}) -> 400 « Une cible par requête »`, async () => {
    // ⚠ LE COMPTE, PAS LA PAIRE. Avec trois cibles, un test `A && B` laisse
    // passer `A && C` et `B && C` : la charge serait acceptee et UNE SEULE des
    // deux appliquee, silencieusement. C'est le defaut exact que la version a
    // deux cibles avait deja ferme une fois, et qu'une troisieme cible
    // rouvrait.
    const { res, etat } = await postConfig(corps)
    assert.equal(res.code, 400)
    assert.equal(res.body.error, 'Une cible par requête', 'refuse par la regle des cibles, pas par une validation de charge')
    assert.equal(etat.ecritures.length, 0)
  })
}

// ════════════════════════════════════════════════════════════════════════════
// C. Le POST legacy MERGE, il n'ecrase plus
// ════════════════════════════════════════════════════════════════════════════

test('agent-config legacy : une cle absente de la charge est PRESERVEE', async () => {
  // ⚠ C'EST LA CORRECTION DE SECURITE DE LA DONNEE DU LOT 1. `seedAlertConfig`
  // (pages/onboarding.html:344) fait GET du blob, merge cote client, POST du
  // tout. Entre son GET et son POST, une autre session peut ecrire : le POST
  // passait par-dessus. Depuis ce lot, le serveur relit et merge.
  const { res, etat } = await postConfig(
    { config: { [BIEN]: { mode: 'test', intervention: { email_enabled: true, email_lines: 'a@b.c' } } } },
    { config: { [BIEN]: { mode: 'auto', delais: { reponse_ia: 15, alerte_info: 15, sourdine: { active: false, debut: '22:00', fin: '08:00' } } } } }
  )
  assert.equal(res.code, 200)
  const blob = etat.ecritures.find(e => e.table === 'agent_alert_config').row.config
  assert.deepEqual(blob[BIEN].delais, { reponse_ia: 15, alerte_info: 15, sourdine: { active: false, debut: '22:00', fin: '08:00' } },
    'LES DELAIS DU BIEN SURVIVENT a un POST legacy qui ne les mentionne pas')
  assert.equal(blob[BIEN].mode, 'test', 'le champ fourni, lui, est bien applique')
  assert.deepEqual(blob[BIEN].intervention, { email_enabled: true, email_lines: 'a@b.c' })
})

test('agent-config legacy : un bien absent de la charge survit', async () => {
  const { res, etat } = await postConfig(
    { config: { 'bien-A': { mode: 'auto' } } },
    { config: { 'bien-A': { mode: 'test' }, 'bien-B': { mode: 'auto', delais: { reponse_ia: null, alerte_info: 0 } } } }
  )
  assert.equal(res.code, 200)
  const blob = etat.ecritures.find(e => e.table === 'agent_alert_config').row.config
  assert.equal(blob['bien-A'].mode, 'auto')
  assert.ok(blob['bien-B'], 'bien-B n a pas disparu')
  assert.equal(blob['bien-B'].delais.reponse_ia, null)
})

test('agent-config legacy : une charge en tableau -> 400', async () => {
  const { res, etat } = await postConfig({ config: [] })
  assert.equal(res.code, 400)
  assert.equal(etat.ecritures.length, 0)
})

// ════════════════════════════════════════════════════════════════════════════
// D. LES DEUX CLES RESTENT D'ACCORD — constat GRAVE de la revue du 27/10/2026
// ════════════════════════════════════════════════════════════════════════════
// `getPropertyMode` fait gouverner `delais`, mais deux lecteurs lisent encore
// `mode` : l'interrupteur Test/Auto de messages.html (`modesDe`) et la garde de
// scripts/templates-test-colomiers.js. Sans synchronisation, l'ecran affichait
// « Test » pendant que GuestFlow envoyait tout seul.

test('cible delais : `mode` est DERIVE et ecrit avec, pour que l interrupteur dise vrai', async () => {
  const { res, etat } = await postConfig(
    { delais_ref: BIEN, delais: { reponse_ia: null, alerte_info: 0 } },
    { config: { [BIEN]: { mode: 'auto' } } }
  )
  assert.equal(res.code, 200)
  const entree = etat.ecritures.find(e => e.table === 'agent_alert_config').row.config[BIEN]
  assert.equal(entree.delais.reponse_ia, null)
  assert.equal(entree.mode, 'test', 'reponse_ia = null -> mode derive a test')
})

test('cible delais : un delai non nul derive `mode` a auto', async () => {
  const { etat } = await postConfig({ delais_ref: BIEN, delais: { reponse_ia: 15, alerte_info: 15 } })
  const entree = etat.ecritures.find(e => e.table === 'agent_alert_config').row.config[BIEN]
  assert.equal(entree.mode, 'auto')
})

test('cible mode : `delais.reponse_ia` est ALIGNE, sinon le toggle ne gouverne plus rien', async () => {
  // Le scenario du constat : apres la migration, l'hote bascule en Test. Si
  // `delais.reponse_ia` restait a 0, l'agent continuait d'envoyer.
  const { res, etat } = await postConfig(
    { mode_ref: BIEN, mode: 'test' },
    { config: { [BIEN]: { mode: 'auto', delais: { reponse_ia: 0, alerte_info: 0, sourdine: { active: true, debut: '22:00', fin: '08:00' } } } } }
  )
  assert.equal(res.code, 200)
  const entree = etat.ecritures.find(e => e.table === 'agent_alert_config').row.config[BIEN]
  assert.equal(entree.mode, 'test')
  assert.equal(entree.delais.reponse_ia, null, 'passer en Test met le delai en validation manuelle')
  assert.deepEqual(entree.delais.sourdine, { active: true, debut: '22:00', fin: '08:00' },
    'et la sourdine de l hote survit a la bascule')
})

test('cible mode : passer en Auto aligne a 0, pas a un delai invente', async () => {
  const { etat } = await postConfig(
    { mode_ref: BIEN, mode: 'auto' },
    { config: { [BIEN]: { mode: 'test', delais: { reponse_ia: null, alerte_info: 15 } } } }
  )
  const entree = etat.ecritures.find(e => e.table === 'agent_alert_config').row.config[BIEN]
  assert.equal(entree.delais.reponse_ia, 0, 'Auto = immediat, le sens exact d avant')
  assert.equal(entree.delais.alerte_info, 15, 'le delai d alerte n est pas touche')
})

test('cible mode : un bien SANS bloc delais n en recoit pas (bascule non commencee)', async () => {
  const { etat } = await postConfig({ mode_ref: BIEN, mode: 'auto' }, { config: { [BIEN]: { mode: 'test' } } })
  const entree = etat.ecritures.find(e => e.table === 'agent_alert_config').row.config[BIEN]
  assert.equal(entree.mode, 'auto')
  assert.equal(entree.delais, undefined, 'on ne fabrique pas un bloc delais par surprise')
})

// ─── La sourdine absente se REPREND (constat 4) ─────────────────────────────

test('cible delais : sourdine absente de la charge -> celle de la BASE est gardee', async () => {
  const { res, etat } = await postConfig(
    { delais_ref: BIEN, delais: { reponse_ia: 30, alerte_info: 30 } },
    { config: { [BIEN]: { delais: { reponse_ia: 15, alerte_info: 15, sourdine: { active: true, debut: '23:00', fin: '07:30' } } } } }
  )
  assert.equal(res.code, 200)
  const d = etat.ecritures.find(e => e.table === 'agent_alert_config').row.config[BIEN].delais
  assert.deepEqual(d.sourdine, { active: true, debut: '23:00', fin: '07:30' },
    'un enregistrement partiel ne desactive pas la sourdine en silence')
  assert.equal(d.reponse_ia, 30)
})

// ─── Le legacy ne touche pas aux reglages d envoi (constat 3) ───────────────

// (Le test « legacy : `delais` ecarte en silence, 200 » qui vivait ici a ete
// RETIRE : le constat 1 de la seconde revue a change ce comportement en 400
// nomme. Son remplacant est dans la section E — on ne garde pas deux tests qui
// decrivent deux contrats opposes.)

test('legacy : une entree invalide est REFUSEE, pas jetee en silence (constat 5)', async () => {
  const { res, etat } = await postConfig({ config: { [BIEN]: 'pas-un-objet' } })
  assert.equal(res.code, 400)
  assert.deepEqual(res.body.refusees, [BIEN], 'la reponse NOMME ce qui a ete refuse')
  assert.equal(etat.ecritures.length, 0)
})

test('legacy : une ref trop longue est refusee et nommee', async () => {
  const longue = 'x'.repeat(65)
  const { res } = await postConfig({ config: { [longue]: { mode: 'test' } } })
  assert.equal(res.code, 400)
  assert.equal(res.body.refusees.length, 1)
})

// ─── getPropertyMode refuse une valeur hors contrat (constat 2) ─────────────

for (const [etiquette, valeur] of [
  ['chaine', '15'], ['decimal', 15.5], ['hors borne', 99999], ['negatif', -5],
  ['objet', {}], ['booleen', true]
]) {
  test(`getPropertyMode : reponse_ia ${etiquette} -> repli sur mode, jamais 'auto' par defaut`, async () => {
    // ⚠ LE POST LEGACY N'APPELLE PAS `delaisPropres`, et c'est le writer des
    // defauts des biens neufs : une forme fautive peut arriver en lecture sans
    // avoir croise un validateur. Rendre 'auto' voudrait dire « ca part tout
    // seul » — le sens NON sur — et debloquerait aussi les modeles programmes.
    preparer({ config: { [BIEN]: { mode: 'test', delais: { reponse_ia: valeur, alerte_info: 0 } } } })
    const { getPropertyMode } = require('../lib/cron-shared')
    assert.equal(await getPropertyMode(COMPTE, BIEN), 'test')
  })
}

test('getPropertyMode : reponse_ia hors contrat avec mode auto -> auto (on ne durcit PAS au-dela du repli)', async () => {
  // Le repli est `mode`, pas `'test'` inconditionnel : sinon une valeur fautive
  // RETIENDRAIT les messages d un bien que l hote a mis en Auto — on ne change
  // pas son reglage a cause d une donnee malformee, on l ignore.
  preparer({ config: { [BIEN]: { mode: 'auto', delais: { reponse_ia: '15', alerte_info: 0 } } } })
  const { getPropertyMode } = require('../lib/cron-shared')
  assert.equal(await getPropertyMode(COMPTE, BIEN), 'auto')
})

// ════════════════════════════════════════════════════════════════════════════
// E. Les constats de la SECONDE revue du 27 octobre 2026
// ════════════════════════════════════════════════════════════════════════════

test('legacy : une charge qui porte `delais` est REFUSEE et nommee, plus ecartee en silence', async () => {
  // Constat 1 : `delete propre[cle]` + 200 { ok: true }, dans la fonction meme
  // qui pose « un rejet se dit ». Un writer verrait son reglage disparaitre en
  // croyant l avoir pose.
  const { res, etat } = await postConfig(
    { config: { [BIEN]: { mode: 'auto', delais: { reponse_ia: 0, alerte_info: 0 } } } },
    { config: { [BIEN]: { mode: 'test', delais: { reponse_ia: null, alerte_info: 15 } } } }
  )
  assert.equal(res.code, 400)
  assert.ok(res.body.refusees.some(r => /delais/.test(r)), 'la reponse NOMME la cle reservee')
  assert.equal(etat.ecritures.length, 0)
})

test('cible mode : un `delais` en TABLEAU n est pas etale (le serveur n ecrit pas un bloc invalide)', async () => {
  // Constat 4 : `{ ...[] , reponse_ia: 0 }` donnait `{ reponse_ia: 0 }` — plus
  // d alerte_info, plus de sourdine, et le lot 2 lirait « pas d echeance ».
  const { res, etat } = await postConfig(
    { mode_ref: BIEN, mode: 'auto' },
    { config: { [BIEN]: { mode: 'test', delais: [] } } }
  )
  assert.equal(res.code, 200)
  const entree = etat.ecritures.find(e => e.table === 'agent_alert_config').row.config[BIEN]
  assert.deepEqual(entree.delais, [], 'le bloc fautif est laisse tel quel, pas transforme en bloc boiteux')
  assert.equal(entree.mode, 'auto')
})

test('cible mode : un `delais` SCALAIRE n est pas etale en caracteres', async () => {
  const { etat } = await postConfig(
    { mode_ref: BIEN, mode: 'auto' },
    { config: { [BIEN]: { mode: 'test', delais: '22' } } }
  )
  const entree = etat.ecritures.find(e => e.table === 'agent_alert_config').row.config[BIEN]
  assert.equal(entree.delais, '22', 'pas de { 0: "2", 1: "2", reponse_ia: 0 }')
})

test('toggle Test puis Auto : le delai de l hote est RESTITUE, pas detruit', async () => {
  // Constat 5, le plus insidieux : l hote regle 30 min, touche l interrupteur
  // deux fois, et repartait a 0 (envoi immediat) sans trace.
  // Aller : Auto -> Test. La valeur est memorisee.
  const { etat: e1 } = await postConfig(
    { mode_ref: BIEN, mode: 'test' },
    { config: { [BIEN]: { mode: 'auto', delais: { reponse_ia: 30, alerte_info: 15, sourdine: { active: false, debut: '22:00', fin: '08:00' } } } } }
  )
  const apresTest = e1.ecritures.find(e => e.table === 'agent_alert_config').row.config[BIEN].delais
  assert.equal(apresTest.reponse_ia, null, 'Test = validation manuelle')
  assert.equal(apresTest.reponse_ia_rappel, 30, 'les 30 minutes sont MEMORISEES')

  // Retour : Test -> Auto. La valeur revient.
  const { etat: e2 } = await postConfig(
    { mode_ref: BIEN, mode: 'auto' },
    { config: { [BIEN]: { mode: 'test', delais: apresTest } } }
  )
  const apresAuto = e2.ecritures.find(e => e.table === 'agent_alert_config').row.config[BIEN].delais
  assert.equal(apresAuto.reponse_ia, 30, 'LES 30 MINUTES SONT RESTITUEES, pas remises a 0')
  assert.equal(apresAuto.alerte_info, 15, 'et le delai d alerte n a pas bouge')
})

test('toggle Auto sans rappel : 0, le sens exact du Mode Auto d avant', async () => {
  const { etat } = await postConfig(
    { mode_ref: BIEN, mode: 'auto' },
    { config: { [BIEN]: { mode: 'test', delais: { reponse_ia: null, alerte_info: 15 } } } }
  )
  const d = etat.ecritures.find(e => e.table === 'agent_alert_config').row.config[BIEN].delais
  assert.equal(d.reponse_ia, 0)
})

test('legacy : une entree fautive DEJA EN BASE et seulement reemise ne bloque pas', async () => {
  // Constat 6 : sinon tout POST legacy futur rendait 400, l onboarding ne teste
  // pas `r.ok`, et le seed des alertes echouait en silence pour ce compte —
  // sans aucun moyen de reparer par cet endpoint.
  const fautive = 'pas-un-objet'
  const { res, etat } = await postConfig(
    { config: { 'bien-casse': fautive, 'bien-sain': { mode: 'auto' } } },
    { config: { 'bien-casse': fautive } }
  )
  assert.equal(res.code, 200, 'reemettre ce qui est deja en base ne bloque pas')
  const blob = etat.ecritures.find(e => e.table === 'agent_alert_config').row.config
  assert.equal(blob['bien-sain'].mode, 'auto', 'et le reste de la charge est bien ecrit')
})

test('legacy : une entree fautive APPORTEE par l appelant est refusee', async () => {
  const { res, etat } = await postConfig(
    { config: { 'bien-casse': 'nouvelle-valeur-fautive' } },
    { config: { 'bien-casse': { mode: 'test' } } }
  )
  assert.equal(res.code, 400)
  assert.deepEqual(res.body.refusees, ['bien-casse'])
  assert.equal(etat.ecritures.length, 0)
})

test('legacy : une ref trop longue est TRONQUEE dans la reponse', async () => {
  // Constat 6, detail : le test de type passait avant celui de longueur, donc
  // une ref enorme a valeur scalaire partait en entier dans `refusees`.
  const longue = 'x'.repeat(300)
  const { res } = await postConfig({ config: { [longue]: 'scalaire' } })
  assert.equal(res.code, 400)
  assert.equal(res.body.refusees.length, 1)
  assert.ok(res.body.refusees[0].length < 40, `la ref est tronquee (recu ${res.body.refusees[0].length} caracteres)`)
})

test('le contrat des delais est PARTAGE, pas recopie (constat 7)', () => {
  // Une borne ecrite deux fois derive : une valeur acceptee et stockee par
  // l ecriture deviendrait « hors contrat » a la lecture, et le reglage
  // cesserait de gouverner sans que rien ne rougisse.
  const contrat = require('../lib/guestflow/delais-contrat')
  assert.equal(contrat.DELAI_MAX_MIN, 1440)
  assert.equal(contrat.minutesValides(1440), true)
  assert.equal(contrat.minutesValides(1441), false)
  assert.equal(contrat.reponseIaValide(null), true)
  assert.equal(contrat.formeExploitable([]), false)
  assert.equal(contrat.formeExploitable({}), true)
  // Et les deux consommateurs l'importent vraiment, au lieu d'en garder une copie.
  const fs = require('node:fs')
  for (const f of ['api/agent-config.js', 'lib/cron-shared.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
    assert.ok(/delais-contrat/.test(src), `${f} importe le contrat`)
    assert.ok(!/<= *1440/.test(src), `${f} ne recopie pas la borne`)
  }
})

// ════════════════════════════════════════════════════════════════════════════
// F. La derivation du delai (lib/guestflow/delais-contrat.js), lot 2
// ════════════════════════════════════════════════════════════════════════════

test('delaiDeReponse : les trois cas, et leurs motifs', () => {
  const { delaiDeReponse } = require('../lib/guestflow/delais-contrat')
  const cas = [
    [{ mode: 'test', delais: { reponse_ia: null, alerte_info: 0 } },
     { differe: false, manuel: true, motif: 'validation_manuelle' }],
    [{ mode: 'auto', delais: { reponse_ia: 0, alerte_info: 0 } },
     { differe: false, manuel: false, motif: 'immediat' }],
    [{ mode: 'auto', delais: { reponse_ia: 15, alerte_info: 15 } },
     { differe: true, manuel: false, motif: 'differe' }],
    // Sans bloc : le binaire d avant gouverne encore (bascule en cours).
    [{ mode: 'auto', delais: null }, { differe: false, manuel: false, motif: 'sans_delai' }],
    [{ mode: 'test', delais: null }, { differe: false, manuel: true, motif: 'sans_delai' }],
    // Hors contrat : repli sur le mode, et le motif le DIT.
    [{ mode: 'auto', delais: { reponse_ia: '15' } }, { differe: false, manuel: false, motif: 'hors_contrat' }],
    [{ mode: 'test', delais: { reponse_ia: 99999 } }, { differe: false, manuel: true, motif: 'hors_contrat' }],
  ]
  for (const [reglages, attendu] of cas) {
    const r = delaiDeReponse(reglages)
    assert.equal(r.differe, attendu.differe, JSON.stringify(reglages))
    assert.equal(r.manuel, attendu.manuel, JSON.stringify(reglages))
    assert.equal(r.motif, attendu.motif, JSON.stringify(reglages))
  }
})

test('delaiDeReponse : le delai differe porte ses minutes', () => {
  const { delaiDeReponse } = require('../lib/guestflow/delais-contrat')
  assert.equal(delaiDeReponse({ mode: 'auto', delais: { reponse_ia: 240 } }).minutes, 240)
  assert.equal(delaiDeReponse({ mode: 'auto', delais: { reponse_ia: 1440 } }).minutes, 1440)
})

test('echeanceDeReponse : l horloge est TOUJOURS injectee', () => {
  const { echeanceDeReponse } = require('../lib/guestflow/delais-contrat')
  const T = Date.parse('2026-11-11T12:00:00.000Z')
  assert.equal(echeanceDeReponse(15, T), '2026-11-11T12:15:00.000Z')
  assert.equal(echeanceDeReponse(0, T), '2026-11-11T12:00:00.000Z')
  // Le module ne lit pas l heure : sans cela, aucun test a dates figees.
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'lib/guestflow/delais-contrat.js'), 'utf8')
  assert.ok(!/Date\.now\(\)/.test(src), 'aucune lecture de l horloge dans le contrat')
})

// ─── La migration des donnees : son contrat, lu dans le script ─────────────

test('⚠ la migration pose alerte_info = 0, JAMAIS 15 (decision de Thierry)', () => {
  // L alerte « info manquante » n a jamais ete reglable : cron-classify appelle
  // sendAlertNotifications dans le tour, sans lire le mode. Poser 15 minutes
  // aurait CHANGE le comportement de biens en production sous couvert de
  // migration. Les 15 minutes sont le defaut des biens NEUFS.
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'scripts/migrer-modes-vers-delais.js'), 'utf8')
  assert.ok(/alerte_info: 0/.test(src), 'alerte_info = 0')
  assert.ok(!/alerte_info: 15/.test(src), 'jamais 15 dans la migration')
  // A blanc par defaut : ce script touche le reglage qui gouverne les envois.
  assert.ok(/const GO = process\.argv\.includes\('--go'\)/.test(src), 'a blanc par defaut')
  assert.ok(/if \(!GO\) continue/.test(src), 'rien ne s ecrit sans --go')
  // Idempotent : un bloc deja conforme n est pas touche.
  assert.ok(/dejaFaits\+\+/.test(src), 'idempotence comptee')
  // L empreinte refuse une base inconnue.
  assert.ok(/base === 'INCONNUE'[\s\S]{0,200}process\.exit\(1\)/.test(src), 'refus sur base inconnue')
})
