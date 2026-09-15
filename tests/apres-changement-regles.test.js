// tests/apres-changement-regles.test.js
// CE QUE LE MOTEUR REPREND, ET CE QU'IL NE TOUCHE JAMAIS.
//
// ⚠ LA GARDE CENTRALE DE CE LOT : un ENGAGEMENT ne se défait que par un humain.
// Elle a dit oui, quelqu'un compte dessus. On ne reprend que ce qui n'engage
// personne — une proposition en attente. Le reste est déjà couvert par l'alerte
// de refus, qui demande une décision.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const U = 'compte-1', LOLA = 'p-lola'

// Un samedi et un lundi à venir, calculés depuis l'horloge : ce fichier la lit,
// il ne doit donc pas porter de dates figées (règle du dépôt).
function prochain (dow, dans = 1) {
  const d = new Date()
  const base = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + dans, 12))
  while (base.getUTCDay() !== dow) base.setUTCDate(base.getUTCDate() + 1)
  return base.toISOString().slice(0, 10)
}
const SAMEDI = prochain(6), LUNDI = prochain(1)

function preparer ({ menages = [], erreurLecture = null, alerte = () => true } = {}) {
  const etat = { maj: [], alertes: [], filtres: null }
  const client = {
    from (table) {
      const f = {}
      const chain = {
        select () { return chain },
        eq (c, v) { f[c] = v; return chain },
        is (c, v) { f[c + '_is'] = v; return chain },
        gte (c, v) { f[c + '_gte'] = v; return chain },
        lte (c, v) { f[c + '_lte'] = v; return chain },
        limit () {
          if (table === 'menages') { etat.filtres = f
            return Promise.resolve(erreurLecture
              ? { data: null, error: erreurLecture } : { data: menages, error: null }) }
          return Promise.resolve({ data: [{ property_id: '209413' }], error: null })
        },
        update (row) {
          const q = { row, f: {} }
          const c2 = {
            eq (c, v) { q.f[c] = v; return c2 },
            is (c, v) { q.f[c + '_is'] = v; return c2 },
            then (res, rej) { etat.maj.push(q)
              return Promise.resolve({ data: [], error: null }).then(res, rej) }
          }
          return c2
        }
      }
      return chain
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m

  const absAlert = require.resolve(path.join(__dirname, '..', 'lib/alert-notify.js'))
  const ma = new Module(absAlert)
  ma.exports = { alertReglesModifiees: async (o) => { etat.alertes.push(o); return alerte(o) } }
  ma.loaded = true
  require.cache[absAlert] = ma

  for (const mod of ['../lib/cleaning/apres-changement-regles']) {
    try { delete require.cache[require.resolve(mod)] } catch {}
  }
  return { etat, mod: require('../lib/cleaning/apres-changement-regles') }
}

const r = (jours, cadence = 1) => ({ jours, cadence })
const propose = (o = {}) => ({ id: 'm1', property_id: '209413', departure_date: SAMEDI,
                               status: 'offered', provider_id: null, offered_to: LOLA,
                               assigned_by: 'auto', ...o })
const BASE = { userId: U, providerId: LOLA, prenom: 'Lola' }

// ─── Ce qu'on reprend ──────────────────────────────────────────────────────

test('une PROPOSITION sur un jour retiré revient au moteur', async () => {
  const { etat, mod } = preparer({ menages: [propose()] })
  const b = await mod.apresChangementDeRegles({ ...BASE, avant: [r([1, 6])], apres: [r([1])] })
  assert.strictEqual(b.repris, 1)
  const maj = etat.maj[0]
  assert.strictEqual(maj.row.offered_to, null, 'la proposition est retirée')
  assert.strictEqual(maj.row.status, 'unassigned', 'et le ménage redevient à attribuer')
  assert.match(maj.row.assignment_reason, /ne travaille plus/)
})

test('la reprise est CONDITIONNELLE : elle a pu accepter entre-temps', async () => {
  // ⚠ Entre la lecture et l'écriture, elle a pu accepter depuis son téléphone.
  // Sans cette condition dans l'`update`, on effacerait une acceptation qui
  // vient d'arriver — et personne ne saurait qu'elle avait dit oui.
  const { etat, mod } = preparer({ menages: [propose()] })
  await mod.apresChangementDeRegles({ ...BASE, avant: [r([6])], apres: [] })
  const maj = etat.maj[0]
  assert.strictEqual(maj.f.offered_to, LOLA, 'l\'offre doit être encore la sienne')
  assert.strictEqual(maj.f.provider_id_is, null, 'et personne ne doit porter le ménage')
})

// ─── Ce qu'on ne touche JAMAIS ─────────────────────────────────────────────

test('un ménage ACCEPTÉ n\'est pas touché', async () => {
  // ⚠ LA GARDE CENTRALE. Un engagement ne se défait que par un humain : elle a
  // dit oui, quelqu'un compte dessus. L'alerte de refus existe déjà pour ce cas.
  const { etat, mod } = preparer({ menages: [propose({ provider_id: LOLA, status: 'accepted' })] })
  const b = await mod.apresChangementDeRegles({ ...BASE, avant: [r([6])], apres: [] })
  assert.strictEqual(b.repris, 0)
  assert.strictEqual(etat.maj.length, 0)
})

test('un ménage VERROUILLÉ par l\'hôte n\'est pas touché', async () => {
  // `assigned_by = 'manual'` est le verrou du §3 : une décision humaine ne se
  // défait pas par un calcul.
  const { etat, mod } = preparer({ menages: [propose({ assigned_by: 'manual' })] })
  const b = await mod.apresChangementDeRegles({ ...BASE, avant: [r([6])], apres: [] })
  assert.strictEqual(b.repris, 0)
  assert.strictEqual(etat.maj.length, 0)
})

test('un ménage ANNULÉ ou ORPHELIN n\'est pas touché', async () => {
  for (const status of ['cancelled', 'orphaned']) {
    const { etat, mod } = preparer({ menages: [propose({ status })] })
    await mod.apresChangementDeRegles({ ...BASE, avant: [r([6])], apres: [] })
    assert.strictEqual(etat.maj.length, 0, status)
  }
})

test('un ménage d\'un AUTRE jour n\'est pas touché', async () => {
  // Elle retire le samedi : le ménage du lundi ne la concerne pas.
  const { etat, mod } = preparer({ menages: [propose({ departure_date: LUNDI })] })
  const b = await mod.apresChangementDeRegles({ ...BASE, avant: [r([1, 6])], apres: [r([1])] })
  assert.strictEqual(b.repris, 0)
  assert.strictEqual(etat.maj.length, 0)
})

test('un jour GAGNÉ ne reprend rien — on n\'enlève une proposition à personne', async () => {
  const { etat, mod } = preparer({ menages: [propose()] })
  const b = await mod.apresChangementDeRegles({ ...BASE, avant: [r([1])], apres: [r([1, 6])] })
  assert.strictEqual(b.repris, 0)
  assert.strictEqual(etat.maj.length, 0)
  assert.strictEqual(etat.alertes.length, 1, 'mais l\'hôte l\'apprend quand même')
})

// ─── Le cloisonnement et les bornes ────────────────────────────────────────

test('la lecture est CLOISONNÉE et BORNÉE', async () => {
  // ⚠ Sans `user_id`, on lirait les ménages d'un autre compte. Sans borne de
  // date, une lecture sans plafond se ferait tronquer en silence — donc des
  // ménages laissés proposés sans que rien ne le dise.
  const { etat, mod } = preparer({ menages: [] })
  await mod.apresChangementDeRegles({ ...BASE, avant: [r([6])], apres: [] })
  assert.strictEqual(etat.filtres.user_id, U)
  assert.strictEqual(etat.filtres.offered_to, LOLA)
  assert.ok(etat.filtres.departure_date_gte, 'bornée au futur')
  assert.ok(etat.filtres.departure_date_lte, 'et bornée devant')
})

// ─── L'annonce ─────────────────────────────────────────────────────────────

test('l\'hôte est informé, avec les ménages repris', async () => {
  const { etat, mod } = preparer({ menages: [propose()] })
  await mod.apresChangementDeRegles({ ...BASE, avant: [r([6])], apres: [] })
  assert.strictEqual(etat.alertes.length, 1)
  const a = etat.alertes[0]
  assert.match(a.texte, /ne travaille plus le samedi/)
  assert.strictEqual(a.menagesRepris.length, 1)
  assert.strictEqual(a.propertyId, '209413', 'le bien vient du ménage repris')
})

test('AUCUN changement réel : rien n\'est annoncé, rien n\'est repris', async () => {
  const { etat, mod } = preparer({ menages: [propose()] })
  const b = await mod.apresChangementDeRegles({ ...BASE, avant: [r([6])], apres: [r([6])] })
  assert.strictEqual(b.annonce, false)
  assert.strictEqual(etat.alertes.length, 0)
  assert.strictEqual(etat.maj.length, 0)
})

test('une panne de lecture n\'empêche pas d\'INFORMER', async () => {
  // ⚠ Best-effort, mais pas silencieux : si on ne sait pas quels ménages
  // reprendre, l'hôte doit au moins apprendre que ses jours ont changé.
  const { etat, mod } = preparer({ menages: [propose()], erreurLecture: { message: 'timeout' } })
  const b = await mod.apresChangementDeRegles({ ...BASE, avant: [r([6])], apres: [] })
  assert.strictEqual(b.repris, 0)
  assert.strictEqual(etat.alertes.length, 1, 'l\'annonce part quand même')
})

test('une panne d\'annonce NE LÈVE PAS', async () => {
  // L'écriture des règles est déjà faite : un échec ici ne doit ni la défaire,
  // ni faire échouer la requête de la prestataire.
  const { mod } = preparer({ menages: [], alerte: () => { throw new Error('brevo') } })
  const b = await mod.apresChangementDeRegles({ ...BASE, avant: [r([6])], apres: [] })
  assert.strictEqual(b.annonce, false)
})
