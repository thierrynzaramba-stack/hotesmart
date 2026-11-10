// tests/arrival-code-manquant-alerte.test.js
// Dette 137 — le message du CODE D'ACCES et une information manquante.
//
// Decision de Thierry du 9 novembre 2026, option (a) : le message du code PART
// meme s'il lui manque une information (fiche sans adresse, typiquement) —
// sans lui la porte reste fermee —, et l'hote est PREVENU. Avant ce lot, le
// marqueur « [ADRESSE] » partait en mode Auto sans que personne le sache.
//
// On traverse le VRAI `processArrivalCodes` en mode Auto, avec des doubles pour
// tout ce qui sortirait du processus : la base (`cron-shared`), la serrure
// (`providers/seam`), l'envoi (`cron-messages`), le journal du cœur
// (`record-message`), les alertes (`founder-notify`, `alert-notify`).
// ⚠ HARNAIS ETANCHE (review 1, constat 1) : la ligne `access_codes` porte un
// `seam_code_id`, donc aucune creation de code, et la serrure est doublee. Sans
// ca, chaque test lisait la cle Seam en base (28 requetes reelles), et un test
// ne restait vert que parce que cette base etait injoignable.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

// Les libelles se lisent sur le VRAI module, avant que le double le remplace.
const { LABELS, SANS_SMS, texteSms } = require('../lib/founder-notify')
const { OU_REMPLIR } = require('../lib/balises')

const MODELE = {
  id: 'tmpl-1', lock_id: 'lock-1', event_type: 'menage_done', active: true,
  earliest_send_time: '00:00',
  template_text: 'Bonjour {prenom}, adresse : {adresse}. Code : {code_acces}'
}

function doubler (relatif, exports) {
  const abs = require.resolve(path.join(__dirname, '..', relatif))
  const m = new Module(abs)
  m.exports = exports
  m.loaded = true
  require.cache[abs] = m
}

function charger ({
  mode = 'auto', envoi = { ok: true }, pin = '123456', modele = MODELE,
  connaissance = [], baseEnPanne = false, dejaEnvoye = false,
  // Review 3, constat 2 : plusieurs modeles de code actifs.
  modeles = null,
  // Dette 141 : le comportement de la plateforme d'alerte, par type.
  alerte = null
} = {}) {
  const vus = { envois: [], alertes: [], taches: [], ordre: [], reseau: 0 }
  const table = (nom) => {
    const q = {
      select () { return q }, eq () { return q }, neq () { return q }, in () { return q },
      is () { return q }, not () { return q }, lte () { return q }, gte () { return q },
      order () { return q }, range () { return q },
      update (row) { if (nom === 'access_codes' && row.status === 'active') vus.ordre.push('actif'); return q },
      insert (row) {
        if (nom === 'agent_tasks') vus.taches.push(row)
        return Promise.resolve({ data: null, error: null })
      },
      upsert () { return Promise.resolve({ data: null, error: null }) },
      single: async () => ({ data: nom === 'locks' ? { seam_device_id: 'dev-1' } : null }),
      maybeSingle: async () => ({ data: null, error: null }),
      limit () {
        if (nom === 'access_codes') {
          // Code ancien, deja cree chez la serrure : aucun delai, aucune
          // creation. `pin` null = PIN pas encore pose (message RETENU).
          return Promise.resolve({ data: [{
            id: 'ac-1', seam_code_id: 'seam-1', code: pin, status: 'active',
            created_at: '2026-01-01T00:00:00Z'
          }] })
        }
        if (nom === 'message_sent_log' && dejaEnvoye) return Promise.resolve({ data: [{ id: 'deja' }], error: null })
        return Promise.resolve({ data: [], error: null })
      },
      then (res, rej) {
        if (nom === 'knowledge' && baseEnPanne) {
          return Promise.resolve({ data: null, error: { message: 'canceling statement due to statement timeout' } }).then(res, rej)
        }
        const data = nom === 'message_templates' ? (modeles || [modele]) : nom === 'knowledge' ? connaissance : []
        return Promise.resolve({ data, error: null }).then(res, rej)
      }
    }
    return q
  }

  doubler('lib/cron-shared.js', {
    supabase: { from: table },
    getPropertyMode: async () => mode,
    lireReglagesDuBien: async () => ({ mode, delais: null }),
    isAutomationPaused: async () => false
  })
  doubler('lib/providers/seam.js', {
    getSeamKey: async () => { vus.reseau++; return null },
    generateCode: async () => { throw new Error('aucune creation de code dans ces tests') }
  })
  doubler('lib/cron-messages.js', {
    sendGuestMessage: async (cle, bien, booking, message) => { vus.envois.push(message); vus.ordre.push('envoi'); return envoi },
    noterEnvoi: async () => { vus.ordre.push('noter') }
  })
  doubler('lib/record-message.js', { recordMessage: async () => { vus.ordre.push('journal'); return { ok: true } } })
  doubler('lib/founder-notify.js', {
    reportIncident: async (type, opts) => {
      vus.alertes.push({ type, ...opts }); vus.ordre.push('alerte')
      return alerte ? alerte(type) : { recorded: true }
    }
  })
  doubler('lib/alert-notify.js', { alertMissingAccessCode: async () => {} })
  delete require.cache[require.resolve('../lib/cles-migrees')]
  delete require.cache[require.resolve('../lib/cron-arrival-code')]
  const mod = require('../lib/cron-arrival-code')
  return { mod, vus }
}

const jour = (d) => new Date(Date.now() + d * 86400000)
  .toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' })
const arrivante = () => ({
  id: 'ARRIVANTE', arrival: jour(0), departure: jour(2), status: 'confirmed',
  provider: 'channex', firstName: 'Ana', lastName: 'Lopez'
})
const BIEN_SANS_ADRESSE = { id: '0db6b39b', name: 'La bulle', provider: 'channex', address: '' }
const BIEN_AVEC_ADRESSE = { ...BIEN_SANS_ADRESSE, address: '4 rue du bourg vieux', zip_code: '65200', city: 'Bagnères-de-Bigorre' }
const incompletes = (vus) => vus.alertes.filter(a => a.type === 'message_envoye_incomplet')
// Le SMS tel que `reportIncident` le compose : la VRAIE fonction, importee
// (review 2, constat 1), pas une copie.
const smsDe = (a) => texteSms(LABELS[a.type], a.propertyName, a.detail)

test('LE TEST QUI COMPTE : fiche sans adresse, mode Auto — le code PART et l hote est PREVENU', async () => {
  const { mod, vus } = charger()
  await mod.processArrivalCodes('u1', null, BIEN_SANS_ADRESSE, [arrivante()], {})

  assert.strictEqual(vus.envois.length, 1, 'le code doit partir : sans lui la porte reste fermee')
  assert.ok(vus.envois[0].includes('123456'))
  const a = incompletes(vus)
  assert.strictEqual(a.length, 1, 'l hote doit etre prevenu, une fois')
  assert.strictEqual(a[0].userId, 'u1')
  assert.strictEqual(a[0].propertyId, '0db6b39b')
  assert.strictEqual(a[0].threshold, 1)
  assert.match(a[0].detail, /Code d'accès ENVOYÉ à Ana Lopez/)
  // Le NOM de l'information, l'action du jour, puis le chemin de saisie AVEC
  // le nom du logement — jamais la cle technique ni le gabarit.
  assert.match(a[0].detail, /il y manque Adresse : envoyez-le-lui depuis Messages\. À renseigner dans Logements → La bulle → Le logement → Adresse\./)
  assert.ok(!a[0].detail.includes('<nom du logement>'))
  assert.ok(!a[0].detail.includes('peut-être bien renseignée'), 'la base a ete lue : aucune panne a annoncer')
})

test('l alerte part EN DERNIER : apres l envoi, le journal anti-doublon, le fil du coeur et le code actif', async () => {
  // Review 1, constat 2 : une plateforme SMS lente ne doit plus pouvoir
  // empecher le message d'entrer dans le fil, ni le code de passer « active ».
  const { mod, vus } = charger()
  await mod.processArrivalCodes('u1', null, BIEN_SANS_ADRESSE, [arrivante()], {})
  assert.deepStrictEqual(vus.ordre, ['envoi', 'noter', 'journal', 'actif', 'alerte'])
})

test('le SMS porte TOUJOURS l action du jour : chaque information, deux logements, un nom long, envoye ou refuse', async () => {
  // Review 2, constat 1 : avec une seule information manquante, le SMS etait
  // encore coupe avant « envoyez-lui » selon les noms. On balaie toutes les
  // balises qui ont un endroit de saisie, avec le plus long nom de logement
  // en service et un nom de voyageur long, dans les deux branches.
  // Celles qui MANQUENT vraiment sans base ni fiche : les horaires ont un
  // defaut, ils ne manquent jamais.
  const { buildMessageDetaille } = require('../lib/message-builder')
  const cles = Object.keys(OU_REMPLIR).filter(c =>
    buildMessageDetaille({ template_text: `{${c}}` }, arrivante(), 'Ana', '1', {}, BIEN_SANS_ADRESSE).manquants.length)
  assert.deepStrictEqual(cles.sort(), ['adresse', 'telephone_hote', 'wifi_mdp', 'wifi_nom'], 'jeu d essai')
  let cas = 0
  for (const cle of cles) {
    for (const nom of ['La bulle', 'Cœur de vie 23']) {
      for (const voyageur of [{ firstName: 'Ana', lastName: 'Lopez' }, { firstName: 'Marie-Christine', lastName: 'Dupont-Lefebvre' }]) {
        for (const envoi of [{ ok: true }, { ok: false, reason: 'pas de messagerie' }, { ok: false, incertain: true, error: 'network_error' }]) {
          const { mod, vus } = charger({ envoi, modele: { ...MODELE, template_text: `Info {${cle}}. Code : {code_acces}` } })
          await mod.processArrivalCodes('u1', null, { ...BIEN_SANS_ADRESSE, name: nom }, [{ ...arrivante(), ...voyageur }], {})
          const a = incompletes(vus)
          assert.strictEqual(a.length, 1, `${cle} / ${nom} : une alerte attendue`)
          // Review 3, constat 4 : la branche incertaine, la plus longue.
          const action = envoi.ok ? /envoyez-le-lui depuis Messages\./
            : envoi.incertain ? /PEUT-ÊTRE REÇU \(coupure\), il y manque .* : vérifiez le fil avant de le compléter dans vos tâches\./
              : /complétez-le dans vos tâches avant l'envoi\./
          assert.match(smsDe(a[0]), action, `${cle} / ${nom} / ${voyageur.lastName} / envoi ${envoi.ok} : SMS coupe avant l action du jour\n${smsDe(a[0])}`)
          cas++
        }
      }
    }
  }
  assert.strictEqual(cas, cles.length * 12)
})

test('deux informations manquantes : l action du jour tient dans le SMS, les deux chemins dans le texte', async () => {
  const { mod, vus } = charger({ modele: { ...MODELE, template_text: 'Adresse {adresse}, wifi {wifi_mdp}. Code : {code_acces}' } })
  await mod.processArrivalCodes('u1', null, BIEN_SANS_ADRESSE, [arrivante()], {})
  const a = incompletes(vus)[0]
  assert.match(a.detail, /il y manque Adresse, Mot de passe wifi/)
  assert.match(smsDe(a), /envoyez-le-lui depuis Messages\./)
  assert.match(a.detail, /À renseigner dans Logements → La bulle → Le logement → Adresse · Logements → La bulle → Accueil du voyageur → Mot de passe wifi\./)
})

// Non-regression (vert contre le code d'avant) : rougit contre une alerte
// posee sans aucune condition (ni a l'appel, ni dans la fonction) — verifie.
test('fiche avec adresse : le code part, aucune alerte', async () => {
  const { mod, vus } = charger()
  await mod.processArrivalCodes('u1', null, BIEN_AVEC_ADRESSE, [arrivante()], {})
  assert.strictEqual(vus.envois.length, 1)
  assert.ok(vus.envois[0].includes('4 rue du bourg vieux, 65200 Bagnères-de-Bigorre'))
  assert.strictEqual(vus.alertes.length, 0)
  assert.strictEqual(vus.reseau, 0, 'aucune lecture de cle de serrure : le code est complet')
})

// Non-regression : rougit contre une alerte posee sans aucune condition — verifie.
test('modele sans {adresse} et fiche vide : rien ne manque, aucune alerte', async () => {
  // On ne previent QUE de ce que le modele demande vraiment.
  const { mod, vus } = charger({ modele: { ...MODELE, template_text: 'Bonjour {prenom}. Code : {code_acces}' } })
  await mod.processArrivalCodes('u1', null, BIEN_SANS_ADRESSE, [arrivante()], {})
  assert.strictEqual(vus.envois.length, 1)
  assert.strictEqual(vus.alertes.length, 0)
})

test('le canal refuse l envoi : l alerte dit « NON ENVOYÉ » et renvoie a la tache', async () => {
  const { mod, vus } = charger({ envoi: { ok: false, reason: 'pas de messagerie' } })
  await mod.processArrivalCodes('u1', null, BIEN_SANS_ADRESSE, [arrivante()], {})
  assert.strictEqual(vus.taches.length, 1, 'la tache de transmission manuelle existe deja')
  const a = incompletes(vus)
  assert.strictEqual(a.length, 1)
  assert.match(a[0].detail, /NON ENVOYÉ par le canal, il y manque Adresse : complétez-le dans vos tâches avant l'envoi\./)
  assert.ok(!/ENVOYÉ à/.test(a[0].detail), `l alerte annonce un envoi qui n a pas eu lieu : ${a[0].detail}`)
})

test('canal e-mail pas encore branche (`differe`) : meme texte que le refus du canal', async () => {
  // Review 1, constat 6 : le cas n'etait pas teste.
  const { mod, vus } = charger({ envoi: { ok: false, differe: true, reason: 'canal e-mail a venir' } })
  await mod.processArrivalCodes('u1', null, BIEN_SANS_ADRESSE, [arrivante()], {})
  assert.strictEqual(vus.taches.length, 1)
  assert.match(incompletes(vus)[0].detail, /NON ENVOYÉ par le canal/)
})

// Non-regression : rougit contre une alerte posee aussi en mode Test — verifie.
test('mode Test : pas d alerte — la tache a valider montre le texte a l hote', async () => {
  const { mod, vus } = charger({ mode: 'test' })
  await mod.processArrivalCodes('u1', null, BIEN_SANS_ADRESSE, [arrivante()], {})
  assert.strictEqual(vus.envois.length, 0)
  assert.strictEqual(vus.taches.length, 1)
  assert.strictEqual(vus.alertes.length, 0)
})

// Non-regression : rougit contre une alerte posee AVANT la garde du code — verifie.
test('PIN pas encore pose ET adresse manquante : la garde du code gagne, rien ne part', async () => {
  // L'option (a) n'affaiblit pas `hasUnresolvedCode` : un message sans code
  // reste RETENU. Et l'alerte « code incomplet » ne sonne pas pour un message
  // qui n'est pas parti.
  const { mod, vus } = charger({ pin: null })
  await mod.processArrivalCodes('u1', null, BIEN_SANS_ADRESSE, [arrivante()], {})
  assert.strictEqual(vus.envois.length, 0)
  assert.strictEqual(incompletes(vus).length, 0)
})

// Non-regression : rougit quand l'anti-doublon `message_sent_log` saute — verifie.
test('deuxieme cycle : le code deja envoye ne repart pas, et l alerte ne sonne pas une seconde fois', async () => {
  // Review 1, constat 6 : « une seule fois par reservation » n'etait pas mesure.
  const { mod, vus } = charger({ dejaEnvoye: true })
  await mod.processArrivalCodes('u1', null, BIEN_SANS_ADRESSE, [arrivante()], {})
  assert.strictEqual(vus.envois.length, 0)
  assert.strictEqual(vus.alertes.length, 0)
})

test('base de connaissance illisible : l alerte dit la panne, elle n accuse pas l hote', async () => {
  // Review 1, constat 4 : le wifi tombait dans les manquants et l'alerte
  // disait « a renseigner » alors que l'hote l'avait renseigne.
  const { mod, vus } = charger({
    baseEnPanne: true,
    modele: { ...MODELE, template_text: 'Wifi {wifi_mdp}. Code : {code_acces}' }
  })
  await mod.processArrivalCodes('u1', null, BIEN_AVEC_ADRESSE, [arrivante()], {})
  assert.strictEqual(vus.envois.length, 1, 'le code part quand meme (option a)')
  const a = incompletes(vus)
  assert.strictEqual(a.length, 1)
  assert.match(a[0].detail, /n'a pas pu être lue à l'envoi/)
  assert.ok(!/renseigner dans/.test(a[0].detail), a[0].detail)
})

test('base illisible ET fiche sans adresse : l adresse garde sa consigne, seul le wifi passe pour la panne', async () => {
  // Review 2, constat 2 : l'adresse vient de la FICHE, lue meme quand la base
  // ne l'est pas ; elle manque vraiment, elle ne doit pas etre « peut-etre
  // renseignee ».
  const { mod, vus } = charger({
    baseEnPanne: true,
    modele: { ...MODELE, template_text: 'Adresse {adresse}, wifi {wifi_mdp}. Code : {code_acces}' }
  })
  await mod.processArrivalCodes('u1', null, BIEN_SANS_ADRESSE, [arrivante()], {})
  const d = incompletes(vus)[0].detail
  assert.match(d, /À renseigner dans Logements → La bulle → Le logement → Adresse\./)
  assert.match(d, /n'a pas pu être lue à l'envoi : Mot de passe wifi est peut-être bien renseigné/)
  assert.ok(!/Adresse est peut-être/.test(d), d)
})

test('balise inconnue du modele : le code part et l alerte dit quoi corriger dans le modele', async () => {
  // Review 1, constat 5 : `{heure_arrivee}` partait en clair, sans alerte.
  const { mod, vus } = charger({ modele: { ...MODELE, template_text: 'Arrivee a {heure_arrivee}. Code : {code_acces}' } })
  await mod.processArrivalCodes('u1', null, BIEN_AVEC_ADRESSE, [arrivante()], {})
  assert.strictEqual(vus.envois.length, 1)
  const a = incompletes(vus)
  assert.strictEqual(a.length, 1)
  assert.match(a[0].detail, /il y manque \{heure_arrivee\} : envoyez-le-lui depuis Messages\./)
  assert.match(a[0].detail, /Variable inconnue dans le modèle : \{heure_arrivee\}, à corriger dans GuestFlow → Messages\./)
})

// Non-regression : rougit contre la version sans try/catch dans l'alerte —
// verifie (review 2, constat 3 : sans l'espion du journal, il restait vert).
test('l alerte qui echoue ne casse pas la suite de l envoi : journal du coeur et code actif', async () => {
  const { vus } = charger()
  doubler('lib/founder-notify.js', { reportIncident: async () => { throw new Error('Brevo en panne') } })
  delete require.cache[require.resolve('../lib/cron-arrival-code')]
  const mod = require('../lib/cron-arrival-code')
  // Review 2, constat 3 : l'alerte etant la derniere instruction, le catch
  // general de l'envoi avalerait aussi l'erreur — mais en journalisant
  // « Erreur envoi booking », donc un envoi rate qui n'en est pas un. C'est le
  // journal qui garde le try/catch de l'alerte.
  const erreurs = []
  const avant = console.error
  console.error = (...x) => { erreurs.push(x.join(' ')) }
  try {
    await assert.doesNotReject(() => mod.processArrivalCodes('u1', null, BIEN_SANS_ADRESSE, [arrivante()], {}))
  } finally { console.error = avant }
  assert.deepStrictEqual(vus.ordre, ['envoi', 'noter', 'journal', 'actif'])
  assert.ok(erreurs.some(e => e.includes('alerte « code incomplet » non partie')), erreurs.join('\n'))
  assert.ok(!erreurs.some(e => e.includes('Erreur envoi booking')), 'un envoi reussi journalise comme un echec')
})

test('buildMessageDetaille rend les manquants et les inconnues ; buildMessage garde son contrat (une chaine)', () => {
  const { buildMessage, buildMessageDetaille } = require('../lib/message-builder')
  const r = buildMessageDetaille(MODELE, arrivante(), 'Ana', '123456', {}, BIEN_SANS_ADRESSE)
  assert.deepStrictEqual(r.manquants, ['adresse'])
  assert.deepStrictEqual(r.inconnues, [])
  assert.ok(r.texte.includes('[ADRESSE]'))
  assert.strictEqual(buildMessage(MODELE, arrivante(), 'Ana', '123456', {}, BIEN_SANS_ADRESSE), r.texte)
  assert.strictEqual(buildMessage({ template_text: '  ' }, arrivante(), 'Ana', '1', {}, {}), null)
  assert.strictEqual(buildMessageDetaille({ template_text: '' }, arrivante(), 'Ana', '1', {}, {}), null)
})

test('le type d alerte a un libelle neutre, et il part aussi par SMS', () => {
  assert.ok(LABELS.message_envoye_incomplet, 'sinon l objet de l alerte porterait la cle brute')
  assert.ok(!/ENVOYÉ/.test(LABELS.message_envoye_incomplet), 'le meme type sert quand le canal a refuse l envoi')
  assert.ok(!SANS_SMS.has('message_envoye_incomplet'))
})

// ─── Dette 141 : le refus du canal ───────────────────────────────────────────
//
// (1) L'alerte part APRES le journal. Attendue avant `noterEnvoi`, une
// plateforme d'alerte lente (SMS et e-mail sans delai maximum, cron coupe a
// 60 s) laissait la fonction coupee sans journal anti-doublon : au cycle
// suivant, le code etait retraite comme jamais envoye — seconde tache a
// l'hote, seconde tentative au canal.
// (2) Decision de Thierry du 10 novembre 2026 : le fondateur est prevenu DES
// LE PREMIER refus (`code_acces_non_envoye`, seuil 1). `send_failure` avait
// un seuil de 2 : un refus isole ne prevenait personne.
const attendreQue = async (cond) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise(r => setTimeout(r, 2)) }
const nonEnvoyes = (vus) => vus.alertes.filter(a => a.type === 'code_acces_non_envoye')

test('LE TEST QUI COMPTE : le canal refuse et la plateforme d alerte ne rend jamais — journal anti-doublon et code actif sont DEJA ecrits', async () => {
  const { mod, vus } = charger({ envoi: { ok: false, reason: 'pas de messagerie' }, alerte: () => new Promise(() => {}) })
  // Ne se resout jamais : c'est la coupure du cron qu'on simule.
  mod.processArrivalCodes('u1', null, BIEN_AVEC_ADRESSE, [arrivante()], {})
  await attendreQue(() => vus.ordre.includes('alerte'))
  assert.ok(vus.ordre.includes('alerte'), 'jeu d essai : l alerte doit etre appelee')
  assert.deepStrictEqual(vus.alertes.map(a => a.type), ['code_acces_non_envoye'])
  const avant = vus.ordre.slice(0, vus.ordre.indexOf('alerte'))
  assert.ok(avant.includes('noter'), `le journal anti-doublon attend l alerte : ${vus.ordre.join(' > ')}`)
  assert.ok(avant.includes('actif'), `le code reste en attente derriere l alerte : ${vus.ordre.join(' > ')}`)
  assert.strictEqual(vus.taches.length, 1, 'la tache de transmission manuelle existe deja')
})

test('LE TEST QUI COMPTE : un SEUL refus du canal previent le fondateur — seuil 1, son logement, son action', async () => {
  const { mod, vus } = charger({ envoi: { ok: false, reason: 'pas de messagerie' } })
  await mod.processArrivalCodes('u1', null, BIEN_AVEC_ADRESSE, [arrivante()], {})
  const a = nonEnvoyes(vus)
  assert.strictEqual(a.length, 1)
  assert.strictEqual(a[0].threshold, 1, 'un refus isole doit suffire (decision du 10 novembre)')
  assert.ok(!vus.alertes.some(x => x.type === 'send_failure'), 'plus de `send_failure` (seuil 2, anti-spam partage)')
  // Review 1, constat 4 : le logement fixe le perimetre de l'anti-spam (null =
  // tout le parc).
  assert.strictEqual(a[0].userId, 'u1')
  assert.strictEqual(a[0].propertyId, '0db6b39b')
  assert.strictEqual(a[0].propertyName, 'La bulle')
  assert.strictEqual(a[0].detail,
    "Code d'accès de Ana Lopez NON ENVOYÉ par le canal : à lui transmettre vous-même, code et texte dans vos tâches. Motif : pas de messagerie (réservation ARRIVANTE).")
  // Le SMS tel que `reportIncident` le compose : l'action y tient.
  assert.ok(LABELS.code_acces_non_envoye, 'sinon l alerte afficherait le code brut')
  assert.ok(!SANS_SMS.has('code_acces_non_envoye'), 'la porte du voyageur : le SMS part')
  assert.match(smsDe(a[0]), /à lui transmettre vous-même/)
  assert.ok(vus.ordre.indexOf('alerte') > vus.ordre.indexOf('noter') && vus.ordre.indexOf('alerte') > vus.ordre.indexOf('actif'), vus.ordre.join(' > '))
})

test('le SMS du code non envoye garde son action avec un nom long et un motif long', async () => {
  const { mod, vus } = charger({ envoi: { ok: false, reason: 'x'.repeat(400) } })
  const long = { ...BIEN_AVEC_ADRESSE, name: 'Appartement panoramique du centre historique avec terrasse' }
  await mod.processArrivalCodes('u1', null, long, [{ ...arrivante(), firstName: 'Maria-Fernanda', lastName: 'de Los Angeles Gutierrez' }], {})
  const sms = smsDe(nonEnvoyes(vus)[0])
  assert.ok(sms.length <= 300)
  assert.match(sms, /NON ENVOYÉ par le canal : à lui transmettre vous-même, code et texte dans vos tâches\./, sms)
})

test('refus du canal ET information manquante : UNE alerte, celle du code incomplet, qui dit « NON ENVOYÉ »', async () => {
  const { mod, vus } = charger({ envoi: { ok: false, reason: 'pas de messagerie' } })
  await mod.processArrivalCodes('u1', null, BIEN_SANS_ADRESSE, [arrivante()], {})
  assert.deepStrictEqual(vus.alertes.map(a => a.type), ['message_envoye_incomplet'], 'deux SMS pour un meme code')
  assert.match(vus.alertes[0].detail, /NON ENVOYÉ par le canal/)
  assert.ok(vus.ordre.indexOf('alerte') > vus.ordre.indexOf('noter'), vus.ordre.join(' > '))
})

test('l alerte du code non envoye qui leve ne se journalise pas en envoi rate', async () => {
  const { mod, vus } = charger({
    envoi: { ok: false, reason: 'pas de messagerie' },
    alerte: () => { throw new Error('Brevo en panne') }
  })
  const erreurs = []
  const avant = console.error
  console.error = (...x) => { erreurs.push(x.join(' ')) }
  try {
    await mod.processArrivalCodes('u1', null, BIEN_AVEC_ADRESSE, [arrivante()], {})
  } finally { console.error = avant }
  assert.deepStrictEqual(vus.alertes.map(a => a.type), ['code_acces_non_envoye'])
  assert.ok(erreurs.some(e => e.includes('alerte « code non envoyé » non partie')), erreurs.join('\n'))
  assert.ok(!erreurs.some(e => e.includes('Erreur envoi booking')), 'une alerte ratee journalisee comme un envoi rate')
})

test('envoi reussi : aucune alerte de code non envoye', async () => {
  const { mod, vus } = charger()
  await mod.processArrivalCodes('u1', null, BIEN_AVEC_ADRESSE, [arrivante()], {})
  assert.deepStrictEqual(vus.alertes.map(a => a.type), [])
})

test('canal e-mail pas encore branche (`differe`) : toujours aucune alerte de code non envoye', async () => {
  // Non-regression : `differe` veut dire « pas encore branche », pas « a echoue ».
  const { mod, vus } = charger({ envoi: { ok: false, differe: true, reason: 'canal e-mail a venir' } })
  await mod.processArrivalCodes('u1', null, BIEN_AVEC_ADRESSE, [arrivante()], {})
  assert.deepStrictEqual(vus.alertes.map(a => a.type), [])
  assert.strictEqual(vus.taches.length, 1)
})

// ─── Dette 141, review 2 ────────────────────────────────────────────────────

test('LE TEST QUI COMPTE : jour de dos-a-dos, deux codes refuses sur le meme logement — DEUX alertes, chacune avec la cle de SA reservation', async () => {
  // Review 2, constat 1 : l'anti-spam (type, logement) taisait celui qui
  // ARRIVE. La cle par reservation est eprouvee sur le vrai \`reportIncident\`
  // dans tests/founder-notify-cle.test.js.
  const { mod, vus } = charger({ envoi: { ok: false, reason: 'pas de messagerie' } })
  const partant = { ...arrivante(), id: 'PARTANT', arrival: jour(-2), departure: jour(0), firstName: 'Paul', lastName: 'Martin' }
  await mod.processArrivalCodes('u1', null, BIEN_AVEC_ADRESSE, [partant, arrivante()], {})
  const a = nonEnvoyes(vus)
  assert.deepStrictEqual(a.map(x => x.cle).sort(), ['code_acces:ARRIVANTE:tmpl-1', 'code_acces:PARTANT:tmpl-1'])
  assert.ok(a.some(x => /Ana Lopez/.test(x.detail)), 'celui qui arrive ce soir n est pas nomme')
})

test('l alerte du code incomplet porte la cle de SA reservation et de SON modele', async () => {
  const { mod, vus } = charger()
  await mod.processArrivalCodes('u1', null, BIEN_SANS_ADRESSE, [arrivante()], {})
  assert.strictEqual(incompletes(vus)[0].cle, 'code_incomplet:ARRIVANTE:tmpl-1')
})

test('deux modeles de code refuses pour la MEME reservation : deux alertes, deux cles (la maille du journal)', async () => {
  // Review 3, constat 2 : la cle par reservation seule taisait le second modele.
  const { mod, vus } = charger({
    envoi: { ok: false, reason: 'pas de messagerie' },
    modeles: [MODELE, { ...MODELE, id: 'tmpl-2', template_text: 'Second : {code_acces}' }]
  })
  await mod.processArrivalCodes('u1', null, BIEN_AVEC_ADRESSE, [arrivante()], {})
  assert.deepStrictEqual(nonEnvoyes(vus).map(x => x.cle).sort(), ['code_acces:ARRIVANTE:tmpl-1', 'code_acces:ARRIVANTE:tmpl-2'])
})

test('LE TEST QUI COMPTE : envoi INCERTAIN (coupure pendant l envoi) — l alerte dit « PEUT-ÊTRE REÇU », pas « NON ENVOYÉ »', async () => {
  // Review 2, constat 2 : le code a peut-etre ete recu ; « a lui transmettre
  // vous-meme » faisait renvoyer un code deja recu.
  const { mod, vus } = charger({ envoi: { ok: false, incertain: true, error: 'network_error' } })
  await mod.processArrivalCodes('u1', null, BIEN_AVEC_ADRESSE, [arrivante()], {})
  const a = nonEnvoyes(vus)
  assert.strictEqual(a.length, 1)
  assert.strictEqual(a[0].detail,
    "Code d'accès de Ana Lopez PEUT-ÊTRE REÇU (coupure pendant l'envoi) : vérifiez le fil avant de le lui transmettre, code et texte dans vos tâches. Motif : network_error (réservation ARRIVANTE).")
  assert.ok(!/NON ENVOYÉ/.test(a[0].detail))
  assert.match(smsDe(a[0]), /vérifiez le fil avant de le lui transmettre/)
  assert.doesNotMatch(LABELS.code_acces_non_envoye, /NON ENVOYÉ/, 'le libelle contredirait le texte')
})

test('envoi INCERTAIN et information manquante : « PEUT-ÊTRE REÇU », puis le motif et la reservation en fin de texte', async () => {
  // Review 2, constat 3 : le motif du canal n'etait ecrit nulle part.
  const { mod, vus } = charger({ envoi: { ok: false, incertain: true, error: 'network_error' } })
  await mod.processArrivalCodes('u1', null, BIEN_SANS_ADRESSE, [arrivante()], {})
  assert.deepStrictEqual(vus.alertes.map(a => a.type), ['message_envoye_incomplet'])
  const d = vus.alertes[0].detail
  assert.match(d, /PEUT-ÊTRE REÇU \(coupure\), il y manque Adresse : vérifiez le fil avant de le compléter dans vos tâches\./)
  assert.ok(!/NON ENVOYÉ/.test(d))
  assert.ok(d.endsWith('Motif du canal : network_error (réservation ARRIVANTE).'), d)
})

test('refus du canal et information manquante : le motif du refus est ecrit en fin de texte', async () => {
  const { mod, vus } = charger({ envoi: { ok: false, reason: 'pas de messagerie' } })
  await mod.processArrivalCodes('u1', null, BIEN_SANS_ADRESSE, [arrivante()], {})
  assert.ok(incompletes(vus)[0].detail.endsWith('Motif du canal : pas de messagerie (réservation ARRIVANTE).'))
})

test('code ENVOYÉ avec une information manquante : aucun motif du canal (il n y a pas eu de refus)', async () => {
  const { mod, vus } = charger()
  await mod.processArrivalCodes('u1', null, BIEN_SANS_ADRESSE, [arrivante()], {})
  assert.ok(!/Motif du canal/.test(incompletes(vus)[0].detail))
})

test('le motif d un refus Beds24 (objet ou tableau) est lisible, pas « [object Object] »', async () => {
  // Review 2, constat 4 : `sendViaBeds24` rend `error: result.errors`.
  const { mod, vus } = charger({ envoi: { ok: false, error: [{ code: 1020, message: 'no messaging' }] } })
  await mod.processArrivalCodes('u1', null, BIEN_AVEC_ADRESSE, [arrivante()], {})
  const d = nonEnvoyes(vus)[0].detail
  assert.ok(!d.includes('[object Object]'), d)
  assert.match(d, /Motif : \[\{"code":1020,"message":"no messaging"\}\]/)
})

test('refus du canal et balise INCONNUE (fiche complete) : UNE alerte, celle du code incomplet', async () => {
  // Review 2, constat 7 : seul le test de forme tenait ce cas.
  const { mod, vus } = charger({
    envoi: { ok: false, reason: 'pas de messagerie' },
    modele: { ...MODELE, template_text: 'Arrivee a {heure_arrivee}. Code : {code_acces}' }
  })
  await mod.processArrivalCodes('u1', null, BIEN_AVEC_ADRESSE, [arrivante()], {})
  assert.deepStrictEqual(vus.alertes.map(a => a.type), ['message_envoye_incomplet'])
  assert.match(vus.alertes[0].detail, /NON ENVOYÉ par le canal/)
})
