// tests/avis-auto-validation.test.js — l'auto-validation de l'evaluation du
// voyageur (spec §10 bis, demande de Thierry du 2 octobre 2026).
const test = require('node:test')
const assert = require('node:assert')

const {
  executerAutoValidations, normaliserHeures, echeanceAuto, completerAuMeilleur,
  marqueurRappelAuto, marqueurEchecAuto, PLAFOND_PUBLICATIONS,
} = require('../lib/avis/auto-validation')
const { enregistrerReponses } = require('../lib/avis/evaluations')
const { GRILLE_DEFAUT } = require('../lib/avis/notes-evaluation')

const H = 3600000
const MAINTENANT = Date.parse('2026-10-05T10:00:00Z')
const iso = (ms) => new Date(ms).toISOString()
const GRILLE = JSON.parse(JSON.stringify(GRILLE_DEFAUT))
const PART_PRESTA = { etat: 'impeccable', degats: 'aucun', poubelles: 'fait' }

// ─── Le reglage et l'echeance ───────────────────────────────────────────────
test('le reglage : nul desactive, un entier de 1 a 336, le reste est refuse', () => {
  assert.strictEqual(normaliserHeures(null), null)
  assert.strictEqual(normaliserHeures(''), null)
  assert.strictEqual(normaliserHeures(48), 48)
  assert.strictEqual(normaliserHeures('24'), 24)
  for (const v of [0, 337, 1.5, 'abc', -3]) assert.strictEqual(normaliserHeures(v), undefined, String(v))
})

test('LE TEST QUI COMPTE : l’echeance automatique tombe au plus tard 12 h avant celle d’Airbnb', () => {
  const deadline = iso(MAINTENANT + 30 * H)
  assert.strictEqual(echeanceAuto({ maintenant: MAINTENANT, heures: 10, deadline }), iso(MAINTENANT + 10 * H))
  assert.strictEqual(echeanceAuto({ maintenant: MAINTENANT, heures: 48, deadline }), iso(MAINTENANT + 18 * H), 'plafonnee')
  assert.strictEqual(echeanceAuto({ maintenant: MAINTENANT, heures: 48, deadline: iso(MAINTENANT + 11 * H) }), null, 'trop tard : rien')
  assert.strictEqual(echeanceAuto({ maintenant: MAINTENANT, heures: 48, deadline: null }), null, 'sans echeance : rien')
  assert.strictEqual(echeanceAuto({ maintenant: MAINTENANT, heures: null, deadline }), null, 'desactivee : rien')
})

test('les questions de l’hote sans reponse prennent le MEILLEUR niveau — « je recommande » compris', () => {
  const c = completerAuMeilleur(GRILLE, { answers_cleaner: PART_PRESTA, answers_host: null })
  assert.deepStrictEqual(c, { communication: 'excellente', regles: 'oui', recommande: 'oui' })
})

test('une question de la PRESTATAIRE sans reponse ne se complete pas : rien ne part', () => {
  assert.throws(() => completerAuMeilleur(GRILLE, { answers_cleaner: { etat: 'impeccable' }, answers_host: null }), /prestataire/)
})

// ─── L'horloge dans enregistrerReponses ─────────────────────────────────────
function baseReponses () {
  const ecritures = []
  const sb = {
    from: () => {
      const q = {
        update (maj) { ecritures.push(maj); q.maj = maj; return q },
        eq () { return q }, select () { return q },
        single: async () => ({ data: { id: 'e1', ...q.maj }, error: null }),
      }
      return q
    },
  }
  return { sb, ecritures }
}
const EV = (a = {}) => ({
  id: 'e1', user_id: 'u1', property_id: 'b1', status: 'a_remplir', grille_figee: GRILLE,
  answers_cleaner: null, answers_host: null, deadline_at: iso(MAINTENANT + 10 * 24 * H), auto_publier_le: null, ...a,
})
const enregistrer = (sb, evaluation, reponses, role, extra = {}) => enregistrerReponses(sb, {
  evaluation, reponses, role, evalScope: 'selon_grille', evalPower: 'soumettre',
  maintenant: () => new Date(MAINTENANT), autoValidationHeures: 24, ...extra,
})

test('LE TEST QUI COMPTE : la prestataire finit sa part — l’horloge part (maintenant + X h)', async () => {
  const { sb, ecritures } = baseReponses()
  await enregistrer(sb, EV(), PART_PRESTA, 'prestataire')
  assert.strictEqual(ecritures[0].auto_publier_le, iso(MAINTENANT + 24 * H))
})

test('sa part pas finie, reglage desactive, ou l’hote a deja repondu : l’horloge ne part pas', async () => {
  for (const [ev, rep, extra] of [
    [EV(), { etat: 'impeccable' }, {}],
    [EV(), PART_PRESTA, { autoValidationHeures: null }],
    [EV({ answers_host: { communication: 'excellente' } }), PART_PRESTA, {}],
  ]) {
    const { sb, ecritures } = baseReponses()
    await enregistrer(sb, ev, rep, 'prestataire', extra)
    assert.strictEqual(ecritures[0].auto_publier_le, undefined)
  }
})

test('re-enregistrer une part deja finie ne relance PAS l’horloge (une reaction de l’hote reste acquise)', async () => {
  const { sb, ecritures } = baseReponses()
  await enregistrer(sb, EV({ answers_cleaner: PART_PRESTA }), PART_PRESTA, 'prestataire')
  assert.strictEqual(ecritures[0].auto_publier_le, undefined)
})

test('LE TEST QUI COMPTE : une reponse de l’hote ARRETE l’horloge', async () => {
  const { sb, ecritures } = baseReponses()
  await enregistrer(sb, EV({ answers_cleaner: PART_PRESTA, auto_publier_le: iso(MAINTENANT + H) }), { communication: 'excellente' }, 'hote')
  assert.strictEqual(ecritures[0].auto_publier_le, null)
})

test('un point negatif coche par la prestataire : l’horloge ne part pas, et s’arrete si elle tournait', async () => {
  const { sb, ecritures } = baseReponses()
  await enregistrer(sb, EV(), { ...PART_PRESTA, degats: 'importants' }, 'prestataire')
  assert.strictEqual(ecritures[0].auto_publier_le, undefined)
  const b = baseReponses()
  await enregistrer(b.sb, EV({ answers_cleaner: PART_PRESTA, auto_publier_le: iso(MAINTENANT + H) }), { degats: 'importants' }, 'prestataire')
  assert.strictEqual(b.ecritures[0].auto_publier_le, null)
})

// ─── Le moteur ──────────────────────────────────────────────────────────────
// Un double de base : guest_evaluations (lecture par filtres, ecriture
// conditionnee), avis_config, agent_tasks, properties, core_events.
function base ({ evaluations = [], heures = 24, configEnPanne = false, configs = null } = {}) {
  const etat = { evaluations: evaluations.map(e => ({ ...e })), taches: [], evenements: [], requetes: [] }
  const from = (table) => {
    const q = { table, f: [], op: 'select' }
    etat.requetes.push(q)
    const executer = () => {
      if (table === 'avis_config') return configEnPanne ? { data: null, error: { message: 'panne' } } : { data: configs || [{ property_id: null, auto_validation_heures: heures }], error: null }
      if (table === 'properties') return { data: { name: 'Studio' }, error: null }
      if (table === 'core_events') { etat.evenements.push(q.ligne); return { data: null, error: null } }
      if (table === 'agent_tasks') {
        if (q.op === 'insert') { etat.taches.push(q.ligne); return { data: null, error: null } }
        const m = q.f.find(([, c]) => c === 'guest_message')
        return { data: etat.taches.find(t => t.guest_message === m[2]) || null, error: null }
      }
      const garde = (e) => q.f.every(([op, c, v]) =>
        op === 'eq' ? e[c] === v
          : op === 'lte' ? e[c] != null && e[c] <= v
            : op === 'gt' ? e[c] != null && e[c] > v
              : op === 'is' ? (e[c] == null) === (v === null)
                : op === 'in' ? v.includes(e[c]) : true)
      if (q.op === 'update') {
        const cibles = etat.evaluations.filter(garde)
        for (const e of cibles) Object.assign(e, q.maj)
        return { data: cibles.map(e => ({ id: e.id })), error: null }
      }
      let lignes = etat.evaluations.filter(garde).sort((a, b) => (a.auto_publier_le < b.auto_publier_le ? -1 : 1))
      if (q.limite) lignes = lignes.slice(0, q.limite)
      return { data: lignes.map(e => ({ ...e })), error: null }
    }
    const c = {
      select () { return c },
      eq (k, v) { q.f.push(['eq', k, v]); return c },
      lte (k, v) { q.f.push(['lte', k, v]); return c },
      gt (k, v) { q.f.push(['gt', k, v]); return c },
      in (k, v) { q.f.push(['in', k, v]); return c },
      is (k, v) { q.f.push(['is', k, v]); return c },
      or () { return c }, not () { return c },
      order (k) { q.ordre = k; return c },
      limit (n) { q.limite = n; return c },
      update (maj) { q.op = 'update'; q.maj = maj; return c },
      insert (ligne) { q.op = 'insert'; q.ligne = ligne; return c },
      maybeSingle: async () => executer(),
      then (ok, ko) { return Promise.resolve(executer()).then(ok, ko) },
    }
    return c
  }
  return { etat, sb: { from } }
}

const ECHUE = (a = {}) => ({
  id: 'e1', user_id: 'u1', property_id: 'b1', property_id_ref: 'ref-1', booking_uid: 'BK-1',
  status: 'soumise_prestataire', deadline_at: iso(MAINTENANT + 5 * 24 * H),
  auto_publier_le: iso(MAINTENANT - 60000), ota_review_id: 'objet-1', grille_figee: GRILLE,
  answers_cleaner: PART_PRESTA, answers_host: null, public_text: 'Merci pour votre séjour.', ...a,
})
function outils ({ redaction = { ok: true, public_text: 'Texte' }, code = 200 } = {}) {
  const appels = { rediger: [], publier: [] }
  return {
    appels,
    rediger: async (e) => { appels.rediger.push(e); return redaction },
    publier: async (e) => { appels.publier.push(e); return { code, body: code === 200 ? { ok: true, simulation: true } : { error: 'refus' } } },
  }
}
const lancer = (sb, o, extra = {}) => executerAutoValidations(sb, { maintenant: MAINTENANT, outils: o, deps: { envoyer: async () => {} }, ...extra })

test('LE TEST QUI COMPTE : a l’echeance, les questions de l’hote prennent le meilleur niveau, le texte est garde, l’evaluation part', async () => {
  const { etat, sb } = base({ evaluations: [ECHUE()] })
  const o = outils()
  const bilan = await lancer(sb, o)
  assert.strictEqual(bilan.publiees, 1)
  assert.strictEqual(o.appels.rediger.length, 0, 'le texte de l IA est conserve')
  assert.strictEqual(o.appels.publier.length, 1)
  const e = etat.evaluations[0]
  assert.deepStrictEqual(e.answers_host, { communication: 'excellente', regles: 'oui', recommande: 'oui' })
  assert.strictEqual(e.auto_publier_le, null, 'l horloge est arretee par la prise')
  assert.strictEqual(etat.evenements[0].type, 'avis.auto_publiee')
})

test('LE TEST QUI COMPTE : JAMAIS un avis negatif — il attend l’hote', async () => {
  const { etat, sb } = base({ evaluations: [ECHUE({ answers_cleaner: { ...PART_PRESTA, degats: 'importants' } })] })
  const o = outils()
  await lancer(sb, o)
  assert.strictEqual(o.appels.publier.length, 0)
  assert.strictEqual(etat.evaluations[0].auto_publier_le, null)
  assert.strictEqual(etat.evaluations[0].answers_host, null, 'rien n est ecrit au nom de l hote')
  assert.ok(etat.taches.some(t => t.guest_message === marqueurEchecAuto('BK-1')), 'l hote est prevenu')
})

test('reglage desactive entre-temps, l’hote a repondu, statut termine, echeance passee : rien ne part', async () => {
  const cas = [
    [{}, 0],
    [{ answers_host: { communication: 'correcte' } }, 24],
    [{ status: 'publiee' }, 24],
    [{ deadline_at: iso(MAINTENANT - H) }, 24],
  ]
  for (const [a, heures] of cas) {
    const { etat, sb } = base({ evaluations: [ECHUE(a)], heures: heures || null })
    const o = outils()
    await lancer(sb, o)
    assert.strictEqual(o.appels.publier.length, 0, JSON.stringify(a))
    assert.strictEqual(etat.evaluations[0].auto_publier_le, null, JSON.stringify(a))
  }
})

test('un reglage illisible : rien ne part, rien n’est desarme, l’erreur se compte', async () => {
  const { etat, sb } = base({ evaluations: [ECHUE()], configEnPanne: true })
  const o = outils()
  const bilan = await lancer(sb, o)
  assert.strictEqual(o.appels.publier.length, 0)
  assert.strictEqual(bilan.erreurs, 1)
  assert.ok(etat.evaluations[0].auto_publier_le)
})

test('sans objet Channex : l’auto-validation ATTEND une heure, puis renonce avant l’echeance et prevenant l’hote', async () => {
  const a = base({ evaluations: [ECHUE({ ota_review_id: null })] })
  await lancer(a.sb, outils())
  assert.strictEqual(a.etat.evaluations[0].auto_publier_le, iso(MAINTENANT + H))
  const b = base({ evaluations: [ECHUE({ ota_review_id: null, deadline_at: iso(MAINTENANT + 12.5 * H) })] })
  await lancer(b.sb, outils())
  assert.strictEqual(b.etat.evaluations[0].auto_publier_le, null)
  assert.ok(b.etat.taches.some(t => t.guest_message === marqueurEchecAuto('BK-1')))
})

test('sans texte, il est redige ; une redaction refusee ne publie pas et previent l’hote', async () => {
  const a = base({ evaluations: [ECHUE({ public_text: null })] })
  const oa = outils()
  await lancer(a.sb, oa)
  assert.strictEqual(oa.appels.rediger.length, 1)
  assert.deepStrictEqual(oa.appels.rediger[0].answers_host, { communication: 'excellente', regles: 'oui', recommande: 'oui' }, 'redige sur la grille completee')
  assert.strictEqual(oa.appels.publier.length, 1)

  const b = base({ evaluations: [ECHUE({ public_text: null })] })
  const ob = outils({ redaction: { ok: false, motif: 'langue_non_couverte' } })
  await lancer(b.sb, ob)
  assert.strictEqual(ob.appels.publier.length, 0)
  assert.strictEqual(b.etat.evaluations[0].auto_publier_le, null)
  assert.ok(b.etat.taches.some(t => t.guest_message === marqueurEchecAuto('BK-1')))
})

test('une panne passagere du modele : report d’une heure, rien de perdu', async () => {
  const { etat, sb } = base({ evaluations: [ECHUE({ public_text: null })] })
  const o = outils({ redaction: { ok: false, motif: 'ia_indisponible', transitoire: true } })
  await lancer(sb, o)
  assert.strictEqual(o.appels.publier.length, 0)
  assert.strictEqual(etat.evaluations[0].auto_publier_le, iso(MAINTENANT + H))
})

test('LE TEST QUI COMPTE : l’hote reagit entre la lecture et la prise — rien ne part', async () => {
  const { etat, sb } = base({ evaluations: [ECHUE({ public_text: null })] })
  const o = outils()
  // La redaction a lieu AVANT la prise : l'hote y repond pendant ce temps.
  o.rediger = async () => { etat.evaluations[0].auto_publier_le = null; etat.evaluations[0].answers_host = { communication: 'difficile' }; return { ok: true } }
  await lancer(sb, o)
  assert.strictEqual(o.appels.publier.length, 0)
  assert.deepStrictEqual(etat.evaluations[0].answers_host, { communication: 'difficile' }, 'sa reponse n est pas ecrasee')
})

test('une publication refusee previent l’hote', async () => {
  const { etat, sb } = base({ evaluations: [ECHUE()] })
  const bilan = await lancer(sb, outils({ code: 409 }))
  assert.strictEqual(bilan.echecs, 1)
  assert.ok(etat.taches.some(t => t.guest_message === marqueurEchecAuto('BK-1')))
})

test('LE TEST QUI COMPTE : le rappel part six heures avant, UNE fois', async () => {
  const { etat, sb } = base({ evaluations: [ECHUE({ auto_publier_le: iso(MAINTENANT + 3 * H) })] })
  const o = outils()
  const b1 = await lancer(sb, o)
  const b2 = await lancer(sb, o)
  assert.strictEqual(b1.rappels, 1)
  assert.strictEqual(b2.rappels, 0)
  assert.strictEqual(etat.taches.filter(t => t.guest_message === marqueurRappelAuto('BK-1')).length, 1)
  assert.match(etat.taches[0].summary, /publiée automatiquement/)
  assert.strictEqual(o.appels.publier.length, 0, 'pas encore')
})

test('pas de balayage : deux requetes bornees sur auto_publier_le, plafonnees, et 5 publications par passage', async () => {
  const echues = Array.from({ length: 8 }, (_, i) => ECHUE({ id: 'e' + i, booking_uid: 'BK-' + i, auto_publier_le: iso(MAINTENANT - (10 - i) * 60000) }))
  const { etat, sb } = base({ evaluations: echues })
  const o = outils()
  await lancer(sb, o)
  const lectures = etat.requetes.filter(q => q.table === 'guest_evaluations' && q.op === 'select')
  assert.strictEqual(lectures.length, 2)
  for (const q of lectures) {
    assert.ok(q.f.some(([op, c]) => c === 'auto_publier_le' && (op === 'lte' || op === 'gt')))
    assert.strictEqual(q.limite, 20)
    assert.strictEqual(q.ordre, 'auto_publier_le')
  }
  assert.strictEqual(o.appels.publier.length, PLAFOND_PUBLICATIONS)
})

test('ne leve jamais', async () => {
  const bilan = await executerAutoValidations({ from: () => { throw new Error('panne') } }, { maintenant: MAINTENANT, outils: outils() })
  assert.strictEqual(bilan.erreurs, 1)
})

test('le cron l’execute apres les relances, avec les outils de api/avis.js', () => {
  const fs = require('node:fs'); const path = require('node:path')
  const cron = fs.readFileSync(path.join(__dirname, '..', 'api', 'cron.js'), 'utf8')
  const r = cron.indexOf("chrono.mesure('relances_avis'")
  const a = cron.indexOf("chrono.mesure('auto_validation_avis', () => executerAutoValidations(supabase, {")
  assert.match(cron, /outils: outilsAutoValidation, resteMs: \(\) => 55000 - chrono.total\(\)/)
  assert.ok(r > 0 && a > r)
  const api = fs.readFileSync(path.join(__dirname, '..', 'api', 'avis.js'), 'utf8')
  assert.match(api, /module\.exports\.outilsAutoValidation = outilsAutoValidation/)
})


// ─── Revue de 59243cb ───────────────────────────────────────────────────────
test('M1 : le meilleur niveau est la meilleure NOTE, pas le premier rang', () => {
  const { meilleurNiveau } = require('../lib/avis/auto-validation')
  const c = { cle: 'communication', categorie: 'communication', rempli_par: 'hote', niveaux: [
    { cle: 'difficile', rang: 1, note: 2, negatif: false },
    { cle: 'correcte', rang: 2, note: 4, negatif: false },
    { cle: 'excellente', rang: 3, note: 5, negatif: false },
    { cle: 'odieuse', rang: 4, note: 1, negatif: true },
  ] }
  assert.strictEqual(meilleurNiveau(c), 'excellente')
})

test('M3 : une ligne de bien NULLE herite du compte ; une valeur de bien prime', async () => {
  const { lireHeures } = require('../lib/avis/auto-validation')
  const sb = (configs) => base({ configs }).sb
  assert.deepStrictEqual(await lireHeures(sb([{ property_id: 'b1', auto_validation_heures: null }, { property_id: null, auto_validation_heures: 24 }]), { userId: 'u1', propertyId: 'b1' }), { heures: 24 })
  assert.deepStrictEqual(await lireHeures(sb([{ property_id: 'b1', auto_validation_heures: 6 }, { property_id: null, auto_validation_heures: 24 }]), { userId: 'u1', propertyId: 'b1' }), { heures: 6 })
})

test('S2 : sous 20 s de reste au cycle, aucune publication ne commence', async () => {
  const { etat, sb } = base({ evaluations: [ECHUE()] })
  const o = outils()
  await lancer(sb, o, { resteMs: () => 10000 })
  assert.strictEqual(o.appels.publier.length, 0)
  assert.ok(etat.evaluations[0].auto_publier_le, 'rien n est pris : le passage suivant reprend')
})

test('S2 : une publication interrompue APRES la prise previent l’hote', async () => {
  const { etat, sb } = base({ evaluations: [ECHUE()] })
  const o = outils()
  o.publier = async () => { throw new Error('coupure') }
  await lancer(sb, o)
  assert.ok(etat.taches.some(t => t.guest_message === marqueurEchecAuto('BK-1') && /interrompue/.test(t.summary)))
})

test('S3 : la redaction est passee avec l’horloge lue ; « auto_reprise » ne publie rien et ne previent personne', async () => {
  const { etat, sb } = base({ evaluations: [ECHUE({ public_text: null })] })
  const o = outils({ redaction: { ok: false, motif: 'auto_reprise' } })
  let option
  const rediger = o.rediger
  o.rediger = async (e, opt) => { option = opt; return rediger(e, opt) }
  await lancer(sb, o)
  assert.deepStrictEqual(option, { siAutoPublierLe: ECHUE().auto_publier_le })
  assert.strictEqual(o.appels.publier.length, 0)
  assert.strictEqual(etat.taches.length, 0)
})

test('l’hote qui publie ou reprend pendant ce temps : ce n’est pas un echec, rien n’est signale', async () => {
  for (const motif of ['deja_en_cours', 'auto_annulee']) {
    const { etat, sb } = base({ evaluations: [ECHUE()] })
    const o = outils()
    o.publier = async () => ({ code: 409, body: { motif, error: 'x' } })
    const bilan = await lancer(sb, o)
    assert.strictEqual(bilan.echecs, 0, motif)
    assert.strictEqual(etat.taches.length, 0, motif)
  }
})

test('M2 : le rappel est MARQUE, et la requete des rappels ne relit que les non rappelees', async () => {
  const { etat, sb } = base({ evaluations: [ECHUE({ auto_publier_le: iso(MAINTENANT + 3 * H) })] })
  await lancer(sb, outils())
  assert.strictEqual(etat.evaluations[0].auto_rappel_le, iso(MAINTENANT))
  const q = etat.requetes.find(x => x.table === 'guest_evaluations' && x.f.some(([op, c]) => op === 'gt'))
  assert.ok(q.f.some(([op, c, v]) => op === 'is' && c === 'auto_rappel_le' && v === null))
})

test('M2 : une echeance passee avant la publication se DIT a l’hote', async () => {
  const { etat, sb } = base({ evaluations: [ECHUE({ deadline_at: iso(MAINTENANT - H) })] })
  await lancer(sb, outils())
  assert.ok(etat.taches.some(t => t.guest_message === marqueurEchecAuto('BK-1')))
})

test('re-revue : le budget se relit juste avant la prise — une redaction longue ne lance pas de publication', async () => {
  const { etat, sb } = base({ evaluations: [ECHUE({ public_text: null })] })
  const o = outils()
  let reste = 30000
  const rediger = o.rediger
  o.rediger = async (e, opt) => { reste = 5000; return rediger(e, opt) }
  await lancer(sb, o, { resteMs: () => reste })
  assert.strictEqual(o.appels.publier.length, 0)
  assert.ok(etat.evaluations[0].auto_publier_le, 'rien n est pris')
})

test('recette : une part deja complete mais NEGATIVE, corrigee en positif, arme l’horloge', async () => {
  const { sb, ecritures } = baseReponses()
  await enregistrer(sb, EV({ answers_cleaner: { ...PART_PRESTA, degats: 'importants' } }), { degats: 'aucun' }, 'prestataire')
  assert.strictEqual(ecritures[0].auto_publier_le, iso(MAINTENANT + 24 * H))
})

test('SECURITE : un negatif corrige ne rearme PAS l’horloge si l’hote a deja demande un texte', async () => {
  const { sb, ecritures } = baseReponses()
  await enregistrer(sb, EV({ answers_cleaner: { ...PART_PRESTA, degats: 'importants' }, public_text: 'Texte demande par l hote.' }), { degats: 'aucun' }, 'prestataire')
  assert.strictEqual(ecritures[0].auto_publier_le, undefined)
})
