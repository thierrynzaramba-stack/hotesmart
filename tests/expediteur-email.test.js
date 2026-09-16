// tests/expediteur-email.test.js
// Etape 4 du chantier « canal e-mail pour les reservations directes ».
//
// CE QUE CES TESTS DEFENDENT : on n'enregistre JAMAIS une adresse d'expedition
// que Brevo n'a pas verifiee. Un champ libre serait accepte ici et refuse a
// l'envoi — l'hote croirait son adresse reglee et le decouvrirait devant un
// voyageur.

const test = require('node:test')
const assert = require('node:assert')
const Module = require('node:module')
const fs = require('node:fs')
const path = require('node:path')

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test'

const etat = { ligne: null, ecrits: [], senders: [], brevoStatus: 200, erreurSelect: null }

const origine = Module._load
Module._load = function (d, ...reste) {
  if (d === '@supabase/supabase-js') return {
    createClient: () => ({
      auth: { getUser: async () => ({ data: { user: { id: 'hote-A' } } }) },
      from () {
        const b = {
          _select: null,
          select (cols) { b._select = cols; return b },
          eq: () => b,
          maybeSingle: async () => {
            // Simule l'absence des colonnes d'expediteur (migration pas passee).
            if (etat.erreurSelect && String(b._select || '').includes('brevo_sender')) {
              return { data: null, error: { code: 'PGRST204', message: 'column api_keys.brevo_sender_email does not exist' } }
            }
            return { data: etat.ligne, error: null }
          },
          upsert: async (row) => { etat.ecrits.push(row); return { error: null } },
          update: async () => ({ error: null })
        }
        return b
      }
    })
  }
  if (d === '../lib/require-permission') return { requirePermission: async () => ({ ok: true }) }
  return origine.apply(this, [d, ...reste])
}

const fetchOrigine = global.fetch
global.fetch = async (url) => {
  if (String(url).includes('/senders')) {
    return { ok: etat.brevoStatus === 200, status: etat.brevoStatus,
             json: async () => ({ senders: etat.senders, message: 'brevo dit non' }) }
  }
  return { ok: true, status: 200, json: async () => ({}) }
}

const handler = require('../api/sms.js')
test.after(() => { Module._load = origine; global.fetch = fetchOrigine })

function faussesReponses () {
  const r = { code: null, corps: null }
  r.status = c => { r.code = c; return r }
  r.json = o => { r.corps = o; return r }
  r.setHeader = () => {}
  r.end = () => r
  return r
}
const appel = async (req) => {
  const res = faussesReponses()
  await handler({ headers: { authorization: 'Bearer x' }, query: {}, body: {}, ...req }, res)
  return res
}

function remise ({ cle = 'xkeysib-hote', senders, status = 200, erreurSelect = null } = {}) {
  etat.ligne = cle ? { brevo_api_key: cle, brevo_enabled: true } : null
  etat.senders = senders !== undefined ? senders
    : [{ id: 1, email: 'eric@exemple.test', name: 'Chez Éric', active: true }]
  etat.brevoStatus = status
  etat.erreurSelect = erreurSelect
  etat.ecrits = []
}

// ─── Lire la liste ──────────────────────────────────────────────────────────
test('la liste des expediteurs vient de Brevo, filtree sur les actifs', async () => {
  remise({ senders: [
    { email: 'ok@x.fr', name: 'OK', active: true },
    { email: 'pas-verifie@x.fr', name: 'Non', active: false },
    { email: null, name: 'Sans adresse', active: true }
  ] })
  const res = await appel({ method: 'GET', query: { action: 'senders' } })
  assert.strictEqual(res.code, 200)
  assert.deepStrictEqual(res.corps.senders, [{ email: 'ok@x.fr', name: 'OK' }],
    'un expediteur non verifie ferait rendre 400 a l\'envoi')
})

test('sans cle Brevo : pas de liste, et on le dit', async () => {
  remise({ cle: null })
  const res = await appel({ method: 'GET', query: { action: 'senders' } })
  assert.strictEqual(res.corps.configured, false)
  assert.deepStrictEqual(res.corps.senders, [])
})

test('Brevo muet : la cause remonte, pas un tableau vide sans explication', async () => {
  // « aucun expediteur » et « Brevo n'a pas repondu » demandent deux gestes
  // differents : les confondre ferait chercher au mauvais endroit.
  remise({ status: 503 })
  const res = await appel({ method: 'GET', query: { action: 'senders' } })
  assert.strictEqual(res.corps.configured, true)
  assert.deepStrictEqual(res.corps.senders, [])
  assert.ok(/503/.test(res.corps.error))
})

// ─── Enregistrer le choix ───────────────────────────────────────────────────
test('LE TEST QUI COMPTE : une adresse non verifiee est REFUSEE', async () => {
  // Se fier au menu affiche reviendrait a accepter n'importe quelle adresse
  // postee a la main — une identite d'expediteur que l'hote ne possede pas.
  remise({ senders: [{ email: 'eric@exemple.test', name: 'Éric', active: true }] })
  const res = await appel({ method: 'POST', body: { action: 'saveSender', email: 'victime@autre-hote.fr' } })
  assert.strictEqual(res.code, 400)
  assert.ok(/pas un expéditeur vérifié/i.test(res.corps.error))
  assert.strictEqual(etat.ecrits.length, 0, 'rien n\'est ecrit en base')
})

test('une adresse verifiee est enregistree, avec le nom que Brevo en donne', async () => {
  remise({ senders: [{ email: 'eric@exemple.test', name: 'Chez Éric', active: true }] })
  const res = await appel({ method: 'POST', body: { action: 'saveSender', email: 'eric@exemple.test' } })
  assert.strictEqual(res.code, 200)
  assert.strictEqual(etat.ecrits.length, 1)
  assert.strictEqual(etat.ecrits[0].brevo_sender_email, 'eric@exemple.test')
  assert.strictEqual(etat.ecrits[0].brevo_sender_name, 'Chez Éric',
    'le nom vient de Brevo, pas du client')
  assert.strictEqual(etat.ecrits[0].user_id, 'hote-A', 'sur SA ligne, jamais une autre')
})

test('la casse ne sert pas a contourner la verification', async () => {
  remise({ senders: [{ email: 'eric@exemple.test', name: 'Éric', active: true }] })
  const res = await appel({ method: 'POST', body: { action: 'saveSender', email: 'ERIC@Exemple.TEST' } })
  assert.strictEqual(res.code, 200)
  assert.strictEqual(etat.ecrits[0].brevo_sender_email, 'eric@exemple.test',
    'on enregistre la forme de Brevo, pas celle du client')
})

test('un expediteur desactive ne peut pas etre choisi', async () => {
  remise({ senders: [{ email: 'vieux@x.fr', name: 'Vieux', active: false }] })
  const res = await appel({ method: 'POST', body: { action: 'saveSender', email: 'vieux@x.fr' } })
  assert.strictEqual(res.code, 400)
  assert.strictEqual(etat.ecrits.length, 0)
})

test('Brevo injoignable : on n\'enregistre RIEN plutot que de croire le client', async () => {
  remise({ status: 500 })
  const res = await appel({ method: 'POST', body: { action: 'saveSender', email: 'eric@exemple.test' } })
  assert.strictEqual(res.code, 502)
  assert.strictEqual(etat.ecrits.length, 0,
    'sans verification possible, on ne valide pas « au benefice du doute »')
})

test('sans cle Brevo, on ne peut pas choisir d\'expediteur', async () => {
  remise({ cle: null })
  const res = await appel({ method: 'POST', body: { action: 'saveSender', email: 'x@y.fr' } })
  assert.strictEqual(res.code, 400)
  assert.strictEqual(etat.ecrits.length, 0)
})

// ─── La migration peut ne pas être passée ───────────────────────────────────
test('colonnes absentes : l\'ecran ne dit pas « Non configuré » a tort', async () => {
  // Entre le deploiement et le collage de la migration dans Supabase, un SELECT
  // qui nomme les colonnes echoue en entier. Sans repli, un hote dont la cle est
  // enregistree la verrait annoncee absente.
  remise({ erreurSelect: true })
  const res = await appel({ method: 'GET', query: { action: 'config' } })
  assert.strictEqual(res.corps.configured, true, 'la cle est bien la')
  assert.strictEqual(res.corps.senderEmail, null)
})

// ─── Le front ───────────────────────────────────────────────────────────────
const html = fs.readFileSync(path.join(__dirname, '..', 'pages/connexions.html'), 'utf8')

test('LE TEST QUI COMPTE : l\'ecran n\'offre pas de champ de saisie libre', () => {
  const bloc = html.split('id="bloc-expediteur"')[1].split('</div>\n\n        <div class="toast"')[0]
  assert.ok(/<select[^>]*id="brevo-sender"/.test(bloc), 'un menu, alimente par Brevo')
  assert.ok(!/<input[^>]*id="brevo-sender"/.test(bloc),
    'un champ texte laisserait saisir une adresse que Brevo refusera')
})

test('l\'ecran annonce le defaut quand rien n\'est choisi', () => {
  // Sans ça, l'hôte voit la première ligne du menu et croit l'avoir choisie —
  // alors que c'est bien cette adresse-là qui partira.
  assert.ok(/Par défaut :/.test(html))
})

test('l\'expediteur ne suit pas le toggle SMS', () => {
  // Couper les SMS ne coupe pas les e-mails : deux canaux, un seul compte.
  assert.ok(/L'EXPEDITEUR NE SUIT PAS LE TOGGLE SMS/.test(html))
})

// ─── Les correctifs de review de l'etape 4 ──────────────────────────────────

test('LE TEST QUI COMPTE : l\'ecran DIT que l\'adresse enregistree n\'est plus valide', () => {
  // Sinon il affiche « Par défaut : … » alors que le serveur, lui, continue
  // d'utiliser le choix stocke : Brevo rend 400 et plus aucun e-mail ne part.
  // L'ecran affirmerait exactement le contraire de ce que fait le serveur, et
  // l'hote n'aurait aucune raison de recliquer.
  assert.ok(/n'est plus\s*\n?\s*.*un expéditeur vérifié/.test(html)
    || /n'est plus `\s*\+\s*'un expéditeur vérifié/.test(html)
    || html.includes("n'est plus "), 'l\'alerte existe')
  assert.ok(/vos e-mails aux voyageurs/i.test(html), 'et elle dit la consequence')
})

test('sur erreur de config, le bloc expediteur ne reste pas fige sur « Chargement… »', () => {
  const bloc = html.split("setStatus('brevo', 'off', 'Erreur')")[1].slice(0, 400)
  assert.ok(/bloc-expediteur/.test(bloc) && /display = 'none'/.test(bloc),
    'une UI morte ne doit pas pretendre attendre quelque chose')
})

test('saveSender repond lisiblement si la migration n\'est pas passee', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api/sms.js'), 'utf8')
  const bloc = src.split("action === 'saveSender'")[1].slice(0, 3000)
  assert.ok(/PGRST204|schema cache/.test(bloc), 'le cas est reconnu')
  assert.ok(/pas encore disponible/.test(bloc), 'et dit sans jargon PostgREST')
})
