// tests/guestflow-brouillons-dus.test.js
// La passe qui fait partir les brouillons echus (lib/guestflow/brouillons-dus.js),
// chantier « delai de reponse IA », lot 2. Spec §4.4 + decision 7.
//
// ⚠ L'HORLOGE EST INJECTEE PARTOUT (`opts.maintenant`), donc les dates sont
// FIGEES — regle du depot. Aucun test de ce fichier ne lit l'heure reelle.
//
// ⚠ LE DOUBLE SUPABASE APPLIQUE VRAIMENT LES CONDITIONS D'UPDATE, et c'est le
// point le plus important de ce banc. Un double qui accepterait un
// `.eq('status', 'pending_validation')` sur une tache deja `sending` validerait
// un claim qui ne ferme RIEN — et la course cron/clic passerait les tests en
// restant ouverte en production. Le double refuse donc ce que la base refuse :
// un update conditionnel ne touche que les lignes qui remplissent la condition,
// et rend les lignes REELLEMENT modifiees.

const test = require('node:test')
const assert = require('node:assert')
const { envoyerBrouillonsDus, STATUT_EN_COURS, SENDING_ORPHELIN_MS } =
  require('../lib/guestflow/brouillons-dus')

const T0 = Date.parse('2026-11-11T11:00:00Z') // 12 h a Paris, hors sourdine
const NUIT = Date.parse('2026-11-10T22:30:00Z') // 23 h 30 a Paris, en sourdine
const COMPTE = 'compte-1'
const REF = '0544fd9a'

const bienOuvert = { id: 'uuid-bien', name: 'La bulle', provider: 'channex',
  provider_property_id: REF, automation_paused: false, user_id: COMPTE }

function tache (p = {}) {
  return {
    id: p.id || 'tache-1', user_id: COMPTE, property_id: REF, book_id: 'BK1',
    guest_name: 'Alice', guest_message: 'Bonjour ?', guest_phone: null,
    arrival: '2026-11-20', departure: '2026-11-25',
    task_type: 'info_known', suggested_reply: 'Bonjour, oui bien sur.',
    source_thread: [], status: 'pending_validation',
    send_after: new Date(T0 - 60000).toISOString(),
    suspendu_le: null, modifie_le: null, updated_at: new Date(T0 - 60000).toISOString(),
    ...p
  }
}

// ─── Le double ──────────────────────────────────────────────────────────────
function banc ({ taches = [], biens = [bienOuvert], config = null } = {}) {
  const etat = { taches: taches.map(t => ({ ...t })), updates: [] }

  function filtrer (table, f) {
    if (table === 'agent_tasks') {
      return etat.taches.filter(t => {
        for (const [c, v] of Object.entries(f.eq || {})) if (String(t[c]) !== String(v)) return false
        for (const [c, v] of Object.entries(f.lte || {})) if (!(t[c] && t[c] <= v)) return false
        for (const [c, v] of Object.entries(f.lt || {})) if (!(t[c] && t[c] < v)) return false
        for (const c of f.notNull || []) if (t[c] === null || t[c] === undefined) return false
        for (const c of f.isNull || []) if (t[c] !== null && t[c] !== undefined) return false
        return true
      })
    }
    if (table === 'properties') {
      const vals = (f.in && f.in.provider_property_id) || null
      return biens.filter(b => !vals || vals.map(String).includes(String(b.provider_property_id)))
    }
    if (table === 'agent_alert_config') {
      return config ? [{ user_id: COMPTE, config }] : []
    }
    if (table === 'api_keys') return [{ api_key: 'cle-test' }]
    return []
  }

  const client = {
    from (table) {
      const f = { eq: {}, lte: {}, lt: {}, in: {}, notNull: [], isNull: [] }
      let maj = null
      const q = {
        select () { return q },
        eq (c, v) { f.eq[c] = v; return q },
        lte (c, v) { f.lte[c] = v; return q },
        lt (c, v) { f.lt[c] = v; return q },
        in (c, v) { f.in[c] = v; return q },
        not (c, _op, _v) { f.notNull.push(c); return q },
        is (c, _v) { f.isNull.push(c); return q },
        order () { return q },
        limit (n) { f.limite = n; return q },
        update (patch) { maj = patch; return q },
        maybeSingle: async () => ({ data: filtrer(table, f)[0] || null, error: null }),
        then (res, rej) {
          try {
            let lignes = filtrer(table, f)
            if (maj) {
              // ⚠ L'UPDATE CONDITIONNEL MORD : seules les lignes qui passent le
              // filtre sont touchees, et on rend CELLES-LA. Sur zero ligne, le
              // code appelant doit en conclure « quelqu un d autre l a prise ».
              for (const l of lignes) {
                Object.assign(l, maj)
                etat.updates.push({ id: l.id, patch: { ...maj } })
              }
            }
            if (f.limite) lignes = lignes.slice(0, f.limite)
            return Promise.resolve({ data: lignes.map(l => ({ ...l })), error: null }).then(res, rej)
          } catch (e) { return Promise.reject(e).then(res, rej) }
        }
      }
      return q
    }
  }
  return { etat, client }
}

const lancer = (b, opts = {}) => envoyerBrouillonsDus(
  { errors: [] }, { sb: b.client, maintenant: T0, ...opts })

// ════════════════════════════════════════════════════════════════════════════
// Le chemin nominal
// ════════════════════════════════════════════════════════════════════════════

test('un brouillon echu part, et la tache passe a done', async () => {
  const b = banc({ taches: [tache()] })
  const envois = []
  const bilan = await lancer(b, { envoyer: async (bien, t, texte) => { envois.push(texte); return { ok: true, canal: 'ota' } } })
  assert.equal(bilan.envoyes, 1)
  assert.equal(envois.length, 1)
  assert.equal(envois[0], 'Bonjour, oui bien sur.')
  assert.equal(b.etat.taches[0].status, 'done')
  assert.equal(b.etat.taches[0].send_after, null)
})

test('un brouillon PAS encore echu ne part pas', async () => {
  const b = banc({ taches: [tache({ send_after: new Date(T0 + 600000).toISOString() })] })
  const bilan = await lancer(b, { envoyer: async () => { throw new Error('ne doit pas etre appele') } })
  assert.equal(bilan.examines, 0)
  assert.equal(b.etat.taches[0].status, 'pending_validation')
})

test('un brouillon SUSPENDU ne part pas, meme tres au-dela de l echeance', async () => {
  // Regle 2 : des que l hote ouvre le brouillon, le compte a rebours est suspendu.
  const b = banc({ taches: [tache({
    send_after: new Date(T0 - 86400000).toISOString(),
    suspendu_le: new Date(T0 - 3600000).toISOString()
  })] })
  const bilan = await lancer(b, { envoyer: async () => { throw new Error('ne doit pas etre appele') } })
  assert.equal(bilan.examines, 0)
  assert.equal(b.etat.taches[0].status, 'pending_validation')
})

test('un brouillon sans send_after ne part jamais (validation manuelle)', async () => {
  const b = banc({ taches: [tache({ send_after: null })] })
  const bilan = await lancer(b, { envoyer: async () => { throw new Error('ne doit pas etre appele') } })
  assert.equal(bilan.examines, 0)
})

// ════════════════════════════════════════════════════════════════════════════
// LE CLAIM : un seul envoi, jamais deux
// ════════════════════════════════════════════════════════════════════════════

test('⚠ une tache deja prise ailleurs (statut sending) n est PAS renvoyee', async () => {
  const b = banc({ taches: [tache({ status: STATUT_EN_COURS })] })
  const bilan = await lancer(b, { envoyer: async () => { throw new Error('ne doit pas etre appele') } })
  assert.equal(bilan.examines, 0, 'la lecture ne la voit meme pas')
  assert.equal(bilan.envoyes, 0)
})

test('⚠ DEUX PASSES CONCURRENTES SUR LA MEME TACHE : un seul envoi', async () => {
  // Le scenario du test (b) du brief, cote cron/cron. Les deux passes lisent la
  // tache, les deux tentent le claim ; la base n en laisse passer qu un.
  const b = banc({ taches: [tache()] })
  let envois = 0
  const envoyer = async () => { envois++; return { ok: true, canal: 'ota' } }
  const [b1, b2] = await Promise.all([
    envoyerBrouillonsDus({ errors: [] }, { sb: b.client, maintenant: T0, envoyer }),
    envoyerBrouillonsDus({ errors: [] }, { sb: b.client, maintenant: T0, envoyer })
  ])
  assert.equal(envois, 1, `UN SEUL envoi attendu, ${envois} parti(s)`)
  assert.equal(b1.envoyes + b2.envoyes, 1)
  assert.equal(b.etat.taches[0].status, 'done')
})

test('le claim precede l envoi : au moment de l envoi, la tache est deja « sending »', async () => {
  // ⚠ L ORDRE EST LE CORRECTIF DU CONSTAT CENTRAL DE L ETAPE 0 : l ecran
  // envoyait PUIS claimait. Ici on verifie que le geste a MORDU avant l envoi.
  const b = banc({ taches: [tache()] })
  let statutPendantEnvoi = null
  await lancer(b, { envoyer: async () => {
    statutPendantEnvoi = b.etat.taches[0].status
    return { ok: true, canal: 'ota' }
  } })
  assert.equal(statutPendantEnvoi, STATUT_EN_COURS,
    'la tache doit etre claimee AVANT que l envoi parte')
})

// ════════════════════════════════════════════════════════════════════════════
// Les gardes rejouees a l echeance
// ════════════════════════════════════════════════════════════════════════════

test('kill switch actif : rien ne part, la tache revient a l hote avec le motif', async () => {
  const b = banc({ taches: [tache()], biens: [{ ...bienOuvert, automation_paused: true }] })
  const bilan = await lancer(b, { envoyer: async () => { throw new Error('ne doit pas etre appele') } })
  assert.equal(bilan.envoyes, 0)
  assert.equal(bilan.abandonnes, 1)
  const t = b.etat.taches[0]
  assert.equal(t.status, 'pending_validation', 'rendue a l hote, pas supprimee')
  assert.equal(t.send_after, null, 'desarmee')
  assert.match(t.summary, /automatisation_en_pause/)
})

test('⚠ le reglage repasse en validation manuelle entre-temps : rien ne part', async () => {
  const b = banc({ taches: [tache()],
    config: { [REF]: { mode: 'test', delais: { reponse_ia: null, alerte_info: 0 } } } })
  const bilan = await lancer(b, { envoyer: async () => { throw new Error('ne doit pas etre appele') } })
  assert.equal(bilan.abandonnes, 1)
  assert.match(b.etat.taches[0].summary, /repasse_en_validation_manuelle/)
})

test('le reglage reste a un delai : ca part', async () => {
  const b = banc({ taches: [tache()],
    config: { [REF]: { mode: 'auto', delais: { reponse_ia: 15, alerte_info: 15 } } } })
  const bilan = await lancer(b, { envoyer: async () => ({ ok: true, canal: 'ota' }) })
  assert.equal(bilan.envoyes, 1)
})

test('sejour termine : rien ne part', async () => {
  const b = banc({ taches: [tache({ departure: '2026-11-01' })] })
  const bilan = await lancer(b, { envoyer: async () => { throw new Error('ne doit pas etre appele') } })
  assert.equal(bilan.abandonnes, 1)
  assert.match(b.etat.taches[0].summary, /sejour_termine/)
})

test('un bien introuvable ne fait pas partir le message', async () => {
  const b = banc({ taches: [tache()], biens: [] })
  const bilan = await lancer(b, { envoyer: async () => { throw new Error('ne doit pas etre appele') } })
  assert.equal(bilan.abandonnes, 1)
  assert.match(b.etat.taches[0].summary, /bien_introuvable/)
})

test('un brouillon VIDE ne part pas', async () => {
  const b = banc({ taches: [tache({ suggested_reply: '   ' })] })
  const bilan = await lancer(b, { envoyer: async () => { throw new Error('ne doit pas etre appele') } })
  assert.equal(bilan.abandonnes, 1)
  assert.match(b.etat.taches[0].summary, /vide/)
})

// ════════════════════════════════════════════════════════════════════════════
// L echec d envoi
// ════════════════════════════════════════════════════════════════════════════

test('un envoi refuse rend la tache a l hote, avec NON DELIVREE dans le resume', async () => {
  const b = banc({ taches: [tache()] })
  const results = { errors: [] }
  const bilan = await envoyerBrouillonsDus(results,
    { sb: b.client, maintenant: T0, envoyer: async () => ({ ok: false, error: 'not_supported' }) })
  assert.equal(bilan.envoyes, 0)
  assert.equal(bilan.erreurs, 1)
  const t = b.etat.taches[0]
  assert.equal(t.status, 'pending_validation')
  assert.match(t.summary, /NON DÉLIVRÉE/)
  assert.match(t.summary, /not_supported/)
  assert.ok(results.errors.some(e => e.context === 'brouillon_envoi'), 'l erreur est journalisee')
})

test('une exception de l envoi est traitee comme un echec, pas comme une panne de passe', async () => {
  const b = banc({ taches: [tache({ id: 'a' }), tache({ id: 'b' })] })
  let envois = 0
  const bilan = await lancer(b, { envoyer: async () => {
    envois++
    if (envois === 1) throw new Error('reseau coupe')
    return { ok: true, canal: 'ota' }
  } })
  assert.equal(bilan.erreurs, 1)
  assert.equal(bilan.envoyes, 1, 'la seconde tache part quand meme')
})

// ════════════════════════════════════════════════════════════════════════════
// La sourdine (decision 7)
// ════════════════════════════════════════════════════════════════════════════

const SOURDINE = { [REF]: { mode: 'auto', delais: { reponse_ia: 15, alerte_info: 15,
  sourdine: { active: true, debut: '22:00', fin: '08:00' } } } }

test('⚠ un brouillon MODIFIE echu en pleine nuit est REPORTE, pas envoye', async () => {
  const b = banc({ taches: [tache({ modifie_le: new Date(NUIT - 600000).toISOString(),
    send_after: new Date(NUIT - 60000).toISOString() })], config: SOURDINE })
  const bilan = await envoyerBrouillonsDus({ errors: [] },
    { sb: b.client, maintenant: NUIT, envoyer: async () => { throw new Error('ne doit pas etre appele') } })
  assert.equal(bilan.reportes, 1)
  assert.equal(bilan.envoyes, 0)
  const t = b.etat.taches[0]
  assert.equal(t.status, 'pending_validation', 'pas claimee : on reporte AVANT le claim')
  // Fin de sourdine 8 h Paris, PLUS les 15 minutes de grace (decision 7).
  const attendu = new Date(t.send_after).toLocaleString('sv-SE', { timeZone: 'Europe/Paris' })
  assert.equal(attendu, '2026-11-11 08:15:00', `recu ${attendu}`)
})

test('⚠ un brouillon JAMAIS TOUCHE part la nuit, sans sourdine ni grace', async () => {
  // Decision 7 : la sourdine protege le texte incertain de l hote, pas la
  // reponse de l IA.
  const b = banc({ taches: [tache({ modifie_le: null,
    send_after: new Date(NUIT - 60000).toISOString() })], config: SOURDINE })
  const bilan = await envoyerBrouillonsDus({ errors: [] },
    { sb: b.client, maintenant: NUIT, envoyer: async () => ({ ok: true, canal: 'ota' }) })
  assert.equal(bilan.envoyes, 1)
  assert.equal(bilan.reportes, 0)
})

test('un brouillon modifie echu EN JOURNEE part sans report', async () => {
  const b = banc({ taches: [tache({ modifie_le: new Date(T0 - 600000).toISOString() })], config: SOURDINE })
  const bilan = await lancer(b, { envoyer: async () => ({ ok: true, canal: 'ota' }) })
  assert.equal(bilan.envoyes, 1)
  assert.equal(bilan.reportes, 0)
})

test('sourdine INACTIVE : un brouillon modifie part la nuit', async () => {
  const sansSourdine = { [REF]: { mode: 'auto', delais: { reponse_ia: 15, alerte_info: 15,
    sourdine: { active: false, debut: '22:00', fin: '08:00' } } } }
  const b = banc({ taches: [tache({ modifie_le: new Date(NUIT - 600000).toISOString(),
    send_after: new Date(NUIT - 60000).toISOString() })], config: sansSourdine })
  const bilan = await envoyerBrouillonsDus({ errors: [] },
    { sb: b.client, maintenant: NUIT, envoyer: async () => ({ ok: true, canal: 'ota' }) })
  assert.equal(bilan.envoyes, 1)
})

test('le report ne boucle pas : le brouillon reporte part bien apres la sourdine', async () => {
  const b = banc({ taches: [tache({ modifie_le: new Date(NUIT - 600000).toISOString(),
    send_after: new Date(NUIT - 60000).toISOString() })], config: SOURDINE })
  await envoyerBrouillonsDus({ errors: [] },
    { sb: b.client, maintenant: NUIT, envoyer: async () => ({ ok: true }) })
  const reporte = Date.parse(b.etat.taches[0].send_after)
  // Au second passage, apres l echeance reportee : il part.
  const bilan = await envoyerBrouillonsDus({ errors: [] },
    { sb: b.client, maintenant: reporte + 1000, envoyer: async () => ({ ok: true, canal: 'ota' }) })
  assert.equal(bilan.envoyes, 1, 'un report, pas une boucle de reports')
  assert.equal(bilan.reportes, 0)
})

// ════════════════════════════════════════════════════════════════════════════
// Les orphelines : le prix du claim
// ════════════════════════════════════════════════════════════════════════════

test('⚠ une tache « sending » abandonnee revient a l hote apres 10 minutes', async () => {
  const b = banc({ taches: [tache({ status: STATUT_EN_COURS,
    updated_at: new Date(T0 - SENDING_ORPHELIN_MS - 60000).toISOString() })] })
  const bilan = await lancer(b, { envoyer: async () => { throw new Error('ne doit pas etre appele') } })
  assert.equal(bilan.orphelines, 1)
  const t = b.etat.taches[0]
  assert.equal(t.status, 'pending_validation')
  // ⚠ ET DESARMEE : c'est ce que ce test a fait trouver. Rendue ARMEE, elle
  // etait relue comme echue dans le MEME cycle et renvoyee — alors qu'une tache
  // restee « sending » est justement celle dont on ne sait pas si l'envoi est
  // parti. Le renvoi automatique choisirait le double message au voyageur.
  assert.equal(t.send_after, null, 'desarmee : l hote tranche, le cron ne renvoie pas')
  assert.match(t.summary, /impossible de savoir si le message est parti/)
  assert.equal(bilan.envoyes, 0, 'aucun envoi dans le cycle qui la reprend')
})

test('une tache « sending » RECENTE n est pas touchee (un envoi lent aboutit)', async () => {
  const b = banc({ taches: [tache({ status: STATUT_EN_COURS,
    updated_at: new Date(T0 - 60000).toISOString() })] })
  const bilan = await lancer(b, { envoyer: async () => ({ ok: true }) })
  assert.equal(bilan.orphelines, 0)
  assert.equal(b.etat.taches[0].status, STATUT_EN_COURS)
})

// ════════════════════════════════════════════════════════════════════════════
// Le plafond par cycle
// ════════════════════════════════════════════════════════════════════════════

test('le plafond par cycle borne le travail, le surplus part au cycle suivant', async () => {
  const taches = Array.from({ length: 5 }, (_, i) => tache({ id: `t${i}` }))
  const b = banc({ taches })
  const bilan = await lancer(b, { plafond: 2, envoyer: async () => ({ ok: true, canal: 'ota' }) })
  assert.equal(bilan.envoyes, 2)
  assert.equal(b.etat.taches.filter(t => t.status === 'done').length, 2)
  // Cycle suivant : les trois restantes.
  const suite = await lancer(b, { plafond: 2, envoyer: async () => ({ ok: true, canal: 'ota' }) })
  assert.equal(suite.envoyes, 2)
  assert.equal(b.etat.taches.filter(t => t.status === 'pending_validation').length, 1)
})

test('aucune tache echue : la passe ne fait rien et ne crie pas', async () => {
  const b = banc({ taches: [] })
  const results = { errors: [] }
  const bilan = await envoyerBrouillonsDus(results, { sb: b.client, maintenant: T0 })
  assert.deepEqual(bilan, { examines: 0, envoyes: 0, reportes: 0, abandonnes: 0, orphelines: 0, erreurs: 0 })
  assert.equal(results.errors.length, 0)
})
