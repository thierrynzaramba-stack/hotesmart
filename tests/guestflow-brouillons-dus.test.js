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
// ⚠ Le reglage par defaut : sans entree de config, `encoreLegitime` REFUSE
// desormais (constat 5 : `undefined` n'est pas une permission).
const CONFIG_AUTO = { [REF]: { mode: 'auto', delais: { reponse_ia: 15, alerte_info: 0 } } }

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
// ⚠ LE BANC A CHANGE AVEC LES CORRECTIFS DE LA REVUE, et c'est le signe que le
// double suit le vrai : les lectures sont filtrees PAR COMPTE (constat 13,
// fuite entre comptes) et la passe lit maintenant `bookings_snapshot` — sans
// lui elle ne connait ni le statut d'annulation (constat 7) ni le canal de
// sortie (constat 2). Un banc qui aurait continue de passer sans ces lectures
// aurait valide du code incapable de tourner.
const snapshotOta = { status: 'confirmed', provider: 'channex', source: 'Airbnb', ota: 'airbnb' }

function banc ({ taches = [], biens = [bienOuvert], config = null,
  snapshots = null, panneBiens = false, panneConfig = false, panneSnapshots = false } = {}) {
  const etat = { taches: taches.map(t => ({ ...t })), updates: [] }
  // Par defaut, chaque tache a sa reservation au cœur : c'est le cas normal.
  const resas = snapshots !== null ? snapshots
    : taches.map(t => ({ user_id: t.user_id || COMPTE, booking_id: t.book_id || 'BK1', snapshot: snapshotOta }))

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
      if (panneBiens) throw new Error('panne properties')
      const refs = (f.in && f.in.provider_property_id) || null
      const comptes = (f.in && f.in.user_id) || null
      return biens.filter(b =>
        (!refs || refs.map(String).includes(String(b.provider_property_id)))
        && (!comptes || comptes.map(String).includes(String(b.user_id))))
    }
    if (table === 'agent_alert_config') {
      if (panneConfig) throw new Error('panne config')
      const comptes = (f.in && f.in.user_id) || null
      if (!config) return []
      if (comptes && !comptes.map(String).includes(COMPTE)) return []
      return [{ user_id: COMPTE, config }]
    }
    if (table === 'bookings_snapshot') {
      if (panneSnapshots) throw new Error('panne snapshots')
      const ids = (f.in && f.in.booking_id) || null
      const comptes = (f.in && f.in.user_id) || null
      return resas.filter(r =>
        (!ids || ids.map(String).includes(String(r.booking_id)))
        && (!comptes || comptes.map(String).includes(String(r.user_id))))
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
            let lignes
            try { lignes = filtrer(table, f) }
            catch (e) {
              // ⚠ POSTGREST REND `{ error }`, IL NE LEVE PAS. Le double doit se
              // comporter comme lui, sinon il validerait un code qui n'attrape
              // jamais la panne qu'il croit gerer.
              return Promise.resolve({ data: null, error: { message: e.message } }).then(res, rej)
            }
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

// ⚠ LE JOURNAL DU CŒUR EST CAPTURE, PAS IGNORE. Le constat 1 de la revue etait
// son absence totale dans ce chemin : le voyageur recevait la reponse et elle
// n'existait nulle part. Un banc qui ne le regarde pas ne peut pas le voir.
const lancer = (b, opts = {}) => {
  b.journal = []
  return envoyerBrouillonsDus({ errors: [] }, {
    sb: b.client, maintenant: T0,
    journaliser: async (_sb, p) => { b.journal.push(p) },
    ...opts
  })
}
// Le banc nominal : bien ouvert, reglage a 15 min, reservation au cœur.
const bancNominal = (p = {}) => banc({ config: CONFIG_AUTO, ...p })
// Le meme, a un instant choisi (la nuit, pour la sourdine).
const lancerA = (b, quand, opts = {}) => {
  b.journal = b.journal || []
  return envoyerBrouillonsDus({ errors: [] }, {
    sb: b.client, maintenant: quand,
    journaliser: async (_sb, p) => { b.journal.push(p) },
    ...opts
  })
}

// ════════════════════════════════════════════════════════════════════════════
// Le chemin nominal
// ════════════════════════════════════════════════════════════════════════════

test('un brouillon echu part, et la tache passe a done', async () => {
  const b = bancNominal({ taches: [tache()] })
  const envois = []
  const bilan = await lancer(b, { envoyer: async (bien, t, texte) => { envois.push(texte); return { ok: true, canal: 'ota' } } })
  assert.equal(bilan.envoyes, 1)
  assert.equal(envois.length, 1)
  assert.equal(envois[0], 'Bonjour, oui bien sur.')
  assert.equal(b.etat.taches[0].status, 'done')
  assert.equal(b.etat.taches[0].send_after, null)
})

test('un brouillon PAS encore echu ne part pas', async () => {
  const b = bancNominal({ taches: [tache({ send_after: new Date(T0 + 600000).toISOString() })] })
  const bilan = await lancer(b, { envoyer: async () => { throw new Error('ne doit pas etre appele') } })
  assert.equal(bilan.examines, 0)
  assert.equal(b.etat.taches[0].status, 'pending_validation')
})

test('un brouillon SUSPENDU ne part pas, meme tres au-dela de l echeance', async () => {
  // Regle 2 : des que l hote ouvre le brouillon, le compte a rebours est suspendu.
  const b = bancNominal({ taches: [tache({
    send_after: new Date(T0 - 86400000).toISOString(),
    suspendu_le: new Date(T0 - 3600000).toISOString()
  })] })
  const bilan = await lancer(b, { envoyer: async () => { throw new Error('ne doit pas etre appele') } })
  assert.equal(bilan.examines, 0)
  assert.equal(b.etat.taches[0].status, 'pending_validation')
})

test('un brouillon sans send_after ne part jamais (validation manuelle)', async () => {
  const b = bancNominal({ taches: [tache({ send_after: null })] })
  const bilan = await lancer(b, { envoyer: async () => { throw new Error('ne doit pas etre appele') } })
  assert.equal(bilan.examines, 0)
})

// ════════════════════════════════════════════════════════════════════════════
// LE CLAIM : un seul envoi, jamais deux
// ════════════════════════════════════════════════════════════════════════════

test('⚠ une tache deja prise ailleurs (statut sending) n est PAS renvoyee', async () => {
  const b = bancNominal({ taches: [tache({ status: STATUT_EN_COURS })] })
  const bilan = await lancer(b, { envoyer: async () => { throw new Error('ne doit pas etre appele') } })
  assert.equal(bilan.examines, 0, 'la lecture ne la voit meme pas')
  assert.equal(bilan.envoyes, 0)
})

test('⚠ DEUX PASSES CONCURRENTES SUR LA MEME TACHE : un seul envoi', async () => {
  // Le scenario du test (b) du brief, cote cron/cron. Les deux passes lisent la
  // tache, les deux tentent le claim ; la base n en laisse passer qu un.
  const b = bancNominal({ taches: [tache()] })
  let envois = 0
  const envoyer = async () => { envois++; return { ok: true, canal: 'ota' } }
  const [b1, b2] = await Promise.all([
    lancerA(b, T0, { envoyer }),
    lancerA(b, T0, { envoyer })
  ])
  assert.equal(envois, 1, `UN SEUL envoi attendu, ${envois} parti(s)`)
  assert.equal(b1.envoyes + b2.envoyes, 1)
  assert.equal(b.etat.taches[0].status, 'done')
})

test('le claim precede l envoi : au moment de l envoi, la tache est deja « sending »', async () => {
  // ⚠ L ORDRE EST LE CORRECTIF DU CONSTAT CENTRAL DE L ETAPE 0 : l ecran
  // envoyait PUIS claimait. Ici on verifie que le geste a MORDU avant l envoi.
  const b = bancNominal({ taches: [tache()] })
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
  const b = bancNominal({ taches: [tache()], biens: [{ ...bienOuvert, automation_paused: true }] })
  const bilan = await lancer(b, { envoyer: async () => { throw new Error('ne doit pas etre appele') } })
  assert.equal(bilan.envoyes, 0)
  assert.equal(bilan.abandonnes, 1)
  const t = b.etat.taches[0]
  assert.equal(t.status, 'pending_validation', 'rendue a l hote, pas supprimee')
  assert.equal(t.send_after, null, 'desarmee')
  assert.match(t.summary, /automatisation_en_pause/)
})

test('⚠ le reglage repasse en validation manuelle entre-temps : rien ne part', async () => {
  const b = bancNominal({ taches: [tache()],
    config: { [REF]: { mode: 'test', delais: { reponse_ia: null, alerte_info: 0 } } } })
  const bilan = await lancer(b, { envoyer: async () => { throw new Error('ne doit pas etre appele') } })
  assert.equal(bilan.abandonnes, 1)
  assert.match(b.etat.taches[0].summary, /repasse_en_validation_manuelle/)
})

test('le reglage reste a un delai : ca part', async () => {
  const b = bancNominal({ taches: [tache()],
    config: { [REF]: { mode: 'auto', delais: { reponse_ia: 15, alerte_info: 15 } } } })
  const bilan = await lancer(b, { envoyer: async () => ({ ok: true, canal: 'ota' }) })
  assert.equal(bilan.envoyes, 1)
})

test('sejour termine : rien ne part', async () => {
  const b = bancNominal({ taches: [tache({ departure: '2026-11-01' })] })
  const bilan = await lancer(b, { envoyer: async () => { throw new Error('ne doit pas etre appele') } })
  assert.equal(bilan.abandonnes, 1)
  assert.match(b.etat.taches[0].summary, /sejour_termine/)
})

test('un bien introuvable ne fait pas partir le message', async () => {
  const b = bancNominal({ taches: [tache()], biens: [] })
  const bilan = await lancer(b, { envoyer: async () => { throw new Error('ne doit pas etre appele') } })
  assert.equal(bilan.abandonnes, 1)
  assert.match(b.etat.taches[0].summary, /bien_introuvable/)
})

test('un brouillon VIDE ne part pas', async () => {
  const b = bancNominal({ taches: [tache({ suggested_reply: '   ' })] })
  const bilan = await lancer(b, { envoyer: async () => { throw new Error('ne doit pas etre appele') } })
  assert.equal(bilan.abandonnes, 1)
  assert.match(b.etat.taches[0].summary, /vide/)
})

// ════════════════════════════════════════════════════════════════════════════
// L echec d envoi
// ════════════════════════════════════════════════════════════════════════════

test('un envoi refuse rend la tache a l hote, avec NON DELIVREE dans le resume', async () => {
  const b = bancNominal({ taches: [tache()] })
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
  const b = bancNominal({ taches: [tache({ id: 'a' }), tache({ id: 'b' })] })
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
  const b = bancNominal({ taches: [tache({ modifie_le: new Date(NUIT - 600000).toISOString(),
    send_after: new Date(NUIT - 60000).toISOString() })], config: SOURDINE })
  const bilan = await lancerA(b, NUIT, { envoyer: async () => { throw new Error('ne doit pas etre appele') } })
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
  const b = bancNominal({ taches: [tache({ modifie_le: null,
    send_after: new Date(NUIT - 60000).toISOString() })], config: SOURDINE })
  const bilan = await lancerA(b, NUIT, { envoyer: async () => ({ ok: true, canal: 'ota' }) })
  assert.equal(bilan.envoyes, 1)
  assert.equal(bilan.reportes, 0)
})

test('un brouillon modifie echu EN JOURNEE part sans report', async () => {
  const b = bancNominal({ taches: [tache({ modifie_le: new Date(T0 - 600000).toISOString() })], config: SOURDINE })
  const bilan = await lancer(b, { envoyer: async () => ({ ok: true, canal: 'ota' }) })
  assert.equal(bilan.envoyes, 1)
  assert.equal(bilan.reportes, 0)
})

test('sourdine INACTIVE : un brouillon modifie part la nuit', async () => {
  const sansSourdine = { [REF]: { mode: 'auto', delais: { reponse_ia: 15, alerte_info: 15,
    sourdine: { active: false, debut: '22:00', fin: '08:00' } } } }
  const b = bancNominal({ taches: [tache({ modifie_le: new Date(NUIT - 600000).toISOString(),
    send_after: new Date(NUIT - 60000).toISOString() })], config: sansSourdine })
  const bilan = await lancerA(b, NUIT, { envoyer: async () => ({ ok: true, canal: 'ota' }) })
  assert.equal(bilan.envoyes, 1)
})

test('le report ne boucle pas : le brouillon reporte part bien apres la sourdine', async () => {
  const b = bancNominal({ taches: [tache({ modifie_le: new Date(NUIT - 600000).toISOString(),
    send_after: new Date(NUIT - 60000).toISOString() })], config: SOURDINE })
  await lancerA(b, NUIT, { envoyer: async () => ({ ok: true }) })
  const reporte = Date.parse(b.etat.taches[0].send_after)
  // Au second passage, apres l echeance reportee : il part.
  const bilan = await lancerA(b, reporte + 1000, { envoyer: async () => ({ ok: true, canal: 'ota' }) })
  assert.equal(bilan.envoyes, 1, 'un report, pas une boucle de reports')
  assert.equal(bilan.reportes, 0)
})

// ════════════════════════════════════════════════════════════════════════════
// Les orphelines : le prix du claim
// ════════════════════════════════════════════════════════════════════════════

test('⚠ une tache « sending » abandonnee revient a l hote apres 10 minutes', async () => {
  const b = bancNominal({ taches: [tache({ status: STATUT_EN_COURS,
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
  const b = bancNominal({ taches: [tache({ status: STATUT_EN_COURS,
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
  const b = bancNominal({ taches })
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
  // ⚠ LE BILAN EST COMPARE EN ENTIER, ET C'EST VOULU : un compteur qui bouge
  // sur une passe sans travail est un effet de bord. Le prix est que toute
  // colonne ajoutee au bilan doit l'etre ici aussi — `interrompu` l'a ete avec
  // le budget mur.
  assert.deepEqual(bilan, { examines: 0, envoyes: 0, reportes: 0, abandonnes: 0,
    orphelines: 0, reprises: 0, erreurs: 0, interrompu: false })
  assert.equal(results.errors.length, 0)
})

// ════════════════════════════════════════════════════════════════════════════
// Le budget mur : cette passe ENVOIE, elle ne doit pas manger le cycle
// ════════════════════════════════════════════════════════════════════════════

const { RESTE_MIN_MS } = require('../lib/guestflow/brouillons-dus')

test('budget deja epuise a l entree : rien n est lu, rien n est envoye', async () => {
  const b = bancNominal({ taches: [tache()] })
  const bilan = await lancer(b, { resteMs: () => 5000,
    envoyer: async () => { throw new Error('ne doit pas etre appele') } })
  assert.equal(bilan.interrompu, true)
  assert.equal(bilan.envoyes, 0)
  assert.equal(bilan.examines, 0)
  assert.equal(b.etat.taches[0].status, 'pending_validation', 'pas meme claimee')
})

test('⚠ budget qui s epuise EN COURS : les suivantes sont reportees, pas perdues', async () => {
  const taches = Array.from({ length: 4 }, (_, i) => tache({ id: `t${i}` }))
  const b = bancNominal({ taches })
  let reste = 60000
  const bilan = await lancer(b, {
    resteMs: () => reste,
    envoyer: async () => { reste -= 25000; return { ok: true, canal: 'ota' } }
  })
  assert.equal(bilan.interrompu, true)
  assert.ok(bilan.envoyes >= 1 && bilan.envoyes < 4,
    `quelques envois, pas tous (${bilan.envoyes}/4)`)
  const restantes = b.etat.taches.filter(t => t.status === 'pending_validation')
  assert.equal(restantes.length, 4 - bilan.envoyes, 'les autres attendent le cycle suivant')
  for (const t of restantes) assert.ok(t.send_after, 'et elles gardent leur echeance')
})

test('⚠ un envoi COMMENCE n est jamais coupe par le budget', async () => {
  // Entre le claim et l'ecriture du statut se trouve le seul endroit ou le
  // voyageur peut recevoir un message sans que la tache le dise. Le budget se
  // verifie AVANT de commencer, jamais au milieu.
  const b = bancNominal({ taches: [tache()] })
  let reste = 60000
  const bilan = await lancer(b, {
    resteMs: () => reste,
    envoyer: async () => { reste = 0; return { ok: true, canal: 'ota' } }
  })
  assert.equal(bilan.envoyes, 1)
  assert.equal(b.etat.taches[0].status, 'done', 'le statut est bien ecrit malgre le budget tombe a zero')
})

test('sans resteMs, aucun budget ne s applique (appel direct, script, test)', async () => {
  const b = bancNominal({ taches: [tache({ id: 'a' }), tache({ id: 'b' })] })
  const bilan = await lancer(b, { envoyer: async () => ({ ok: true, canal: 'ota' }) })
  assert.equal(bilan.envoyes, 2)
  assert.equal(bilan.interrompu, false)
})

test('le seuil est celui du depot pour une passe qui ecrit : 20 s', () => {
  assert.equal(RESTE_MIN_MS, 20 * 1000)
})

// ════════════════════════════════════════════════════════════════════════════
// La reprise AUTOMATIQUE des suspensions dormantes — decision 4 de Thierry
// ════════════════════════════════════════════════════════════════════════════
// ⚠ Sans elle, la suspension annule le parachute : il suffirait d'OUVRIR un
// brouillon pour que l'oubli redevienne possible. J'avais specifie une
// suspension definitive ; Thierry a tranche l'inverse, et il a raison.

const { SUSPENSION_DORMANTE_MS, REPRISE_MIN_MS } = require('../lib/guestflow/brouillons-dus')

const paris2 = (t) => new Date(t).toLocaleString('sv-SE', { timeZone: 'Europe/Paris' })

test('⚠ une suspension de plus de 30 min reprend, avec le temps QUI RESTAIT', () => {
  // Elle est verifiee par la mesure ci-dessous, pas par une horloge reelle.
  assert.equal(SUSPENSION_DORMANTE_MS, 30 * 60 * 1000)
  assert.equal(REPRISE_MIN_MS, 5 * 60 * 1000)
})

test('suspension dormante : l echeance repart du temps restant au moment de la suspension', async () => {
  // Suspendue a T0-40min, alors qu il restait 12 minutes : la reprise doit
  // redonner 12 minutes, pas le delai plein, et pas zero.
  const suspenduLe = new Date(T0 - 40 * 60000).toISOString()
  const sendAfter = new Date(T0 - 40 * 60000 + 12 * 60000).toISOString()
  const b = bancNominal({ taches: [tache({
    send_after: sendAfter, suspendu_le: suspenduLe,
    updated_at: new Date(T0 - 35 * 60000).toISOString()
  })] })
  const bilan = await lancer(b, { envoyer: async () => { throw new Error('ne doit pas partir tout de suite') } })
  assert.equal(bilan.reprises, 1)
  const t = b.etat.taches[0]
  assert.equal(t.suspendu_le, null, 'la suspension est levee')
  const dans = (Date.parse(t.send_after) - T0) / 60000
  assert.ok(Math.abs(dans - 12) < 0.01, `12 minutes attendues, ${dans.toFixed(2)} mesurees`)
})

test('⚠ le plancher de 5 minutes : une suspension a 30 s de l echeance ne part pas sous les doigts', async () => {
  const suspenduLe = new Date(T0 - 40 * 60000).toISOString()
  const sendAfter = new Date(T0 - 40 * 60000 + 30000).toISOString()
  const b = bancNominal({ taches: [tache({ send_after: sendAfter, suspendu_le: suspenduLe,
    updated_at: new Date(T0 - 35 * 60000).toISOString() })] })
  await lancer(b, { envoyer: async () => ({ ok: true }) })
  const dans = (Date.parse(b.etat.taches[0].send_after) - T0) / 60000
  assert.ok(Math.abs(dans - 5) < 0.01, `plancher a 5 minutes, ${dans.toFixed(2)} mesurees`)
})

test('une suspension RECENTE (moins de 30 min) n est pas reprise', async () => {
  const b = bancNominal({ taches: [tache({
    suspendu_le: new Date(T0 - 10 * 60000).toISOString(),
    updated_at: new Date(T0 - 10 * 60000).toISOString()
  })] })
  const bilan = await lancer(b, { envoyer: async () => { throw new Error('ne doit pas etre appele') } })
  assert.equal(bilan.reprises, 0)
  assert.ok(b.etat.taches[0].suspendu_le, 'toujours suspendue : l hote vient de l ouvrir')
})

test('⚠ `updated_at` mesure l INACTIVITE, pas l anciennete de la tache', async () => {
  // Suspendue il y a deux heures, mais l hote a modifie le brouillon il y a
  // cinq minutes : il travaille encore dessus, on ne reprend pas.
  const b = bancNominal({ taches: [tache({
    suspendu_le: new Date(T0 - 120 * 60000).toISOString(),
    updated_at: new Date(T0 - 5 * 60000).toISOString()
  })] })
  const bilan = await lancer(b, { envoyer: async () => { throw new Error('ne doit pas etre appele') } })
  assert.equal(bilan.reprises, 0)
})

test('une suspension SANS echeance n est pas reprise (validation manuelle)', async () => {
  const b = bancNominal({ taches: [tache({ send_after: null,
    suspendu_le: new Date(T0 - 40 * 60000).toISOString(),
    updated_at: new Date(T0 - 40 * 60000).toISOString() })] })
  const bilan = await lancer(b, { envoyer: async () => ({ ok: true }) })
  assert.equal(bilan.reprises, 0)
})

test('reprise puis envoi DANS LE MEME CYCLE si l echeance est deja passee', async () => {
  // ⚠ C'est pourquoi la reprise passe AVANT la lecture des echues : la faire
  // apres repousserait l envoi de cinq minutes pour rien.
  // Suspendue a T0-40min alors que l echeance etait DEJA passee : la reprise
  // la place a T0+5min (plancher), donc elle ne part PAS dans ce cycle.
  const b = bancNominal({ taches: [tache({
    send_after: new Date(T0 - 50 * 60000).toISOString(),
    suspendu_le: new Date(T0 - 40 * 60000).toISOString(),
    updated_at: new Date(T0 - 40 * 60000).toISOString()
  })] })
  const bilan = await lancer(b, { envoyer: async () => ({ ok: true, canal: 'ota' }) })
  assert.equal(bilan.reprises, 1)
  assert.equal(bilan.envoyes, 0, 'le plancher de 5 min la protege du depart immediat')
  const dans = (Date.parse(b.etat.taches[0].send_after) - T0) / 60000
  assert.ok(Math.abs(dans - 5) < 0.01)
})

// ════════════════════════════════════════════════════════════════════════════
// Les constats GRAVES de la revue du 27 octobre 2026
// ════════════════════════════════════════════════════════════════════════════

test('⚠ CONSTAT 1 : un envoi reussi JOURNALISE dans le cœur', async () => {
  // Ce chemin n'ecrivait QUE `status: 'done'`. Le voyageur recevait la reponse
  // et elle n'existait nulle part : l'hote voyait un fil sans reponse,
  // `conversations` etait muet, et au message suivant l'IA pouvait repondre une
  // SECONDE FOIS a la meme question.
  const b = bancNominal({ taches: [tache()] })
  const bilan = await lancer(b, { envoyer: async () => ({ ok: true, canal: 'ota' }) })
  assert.equal(bilan.envoyes, 1)
  assert.equal(b.journal.length, 1, 'le journal du cœur est appele')
  const j = b.journal[0]
  assert.equal(j.texte, 'Bonjour, oui bien sur.')
  assert.equal(j.origine, 'ia_differee', 'l origine distingue le differe de l immediat')
  assert.equal(j.canal, 'ota', 'le canal REELLEMENT emprunte')
  assert.equal(String(j.bookingId), 'BK1')
  assert.equal(j.guestMessage, 'Bonjour ?', 'ce a quoi l IA repond, pour `conversations`')
})

test('un envoi REFUSE ne journalise rien', async () => {
  const b = bancNominal({ taches: [tache()] })
  await lancer(b, { envoyer: async () => ({ ok: false, error: 'not_supported' }) })
  assert.equal(b.journal.length, 0, 'rien ne doit affirmer qu une reponse est partie')
})

test('⚠ CONSTAT 2 : l envoi recoit l OBJET de la reservation, pas son identifiant', async () => {
  // Avec un identifiant nu, `sendGuestMessage` pose { canal: OTA } sans
  // consulter `canalPour` : une reservation directe/Offline (canal e-mail)
  // partait vers la messagerie OTA — 422 `not_supported`, dette 3 rouverte.
  const b = bancNominal({ taches: [tache()] })
  let recu = null
  await lancer(b, { envoyer: async (_bien, _t, _texte, snapshot) => {
    recu = snapshot; return { ok: true, canal: 'ota' }
  } })
  assert.ok(recu && typeof recu === 'object', `un objet attendu, recu ${JSON.stringify(recu)}`)
  assert.equal(recu.source, 'Airbnb', 'c est lui qui porte la source, donc le canal')
})

test('⚠ CONSTAT 7 : une reservation ANNULEE ne recoit rien', async () => {
  // Rien d autre ne purge `agent_tasks` a l annulation : un voyageur qui annule
  // pendant la fenetre de differe recevait la reponse (« a bientot », un code
  // d acces…). Mon commentaire promettait cette garde sans la faire.
  const b = bancNominal({ taches: [tache()],
    snapshots: [{ user_id: COMPTE, booking_id: 'BK1',
      snapshot: { status: 'cancelled', provider: 'channex', source: 'Airbnb' } }] })
  const bilan = await lancer(b, { envoyer: async () => { throw new Error('ne doit pas etre appele') } })
  assert.equal(bilan.envoyes, 0)
  assert.equal(bilan.abandonnes, 1)
  assert.match(b.etat.taches[0].summary, /reservation_annulee/)
})

test('une reservation ABSENTE du cœur ne recoit rien non plus', async () => {
  const b = bancNominal({ taches: [tache()], snapshots: [] })
  const bilan = await lancer(b, { envoyer: async () => { throw new Error('ne doit pas etre appele') } })
  assert.equal(bilan.abandonnes, 1)
  assert.match(b.etat.taches[0].summary, /reservation_introuvable/)
})

test('⚠ CONSTAT 5 : une PANNE de lecture des reglages EMPECHE l envoi', async () => {
  // Mon repli etait inverse : `reglages` vide laissait `d` undefined, la garde
  // « repasse en validation manuelle » etait sautee, et le brouillon PARTAIT.
  // Tout le reste du chantier refuse quand il ne sait pas.
  const b = bancNominal({ taches: [tache()], panneConfig: true })
  const bilan = await lancer(b, { envoyer: async () => { throw new Error('ne doit pas etre appele') } })
  assert.equal(bilan.envoyes, 0)
  assert.equal(bilan.abandonnes, 1)
  assert.match(b.etat.taches[0].summary, /reglages_illisibles/)
})

test('une entree de config DISPARUE du blob empeche l envoi aussi', async () => {
  const b = banc({ taches: [tache()], config: { 'un-autre-bien': { mode: 'auto' } } })
  const bilan = await lancer(b, { envoyer: async () => { throw new Error('ne doit pas etre appele') } })
  assert.equal(bilan.abandonnes, 1)
  assert.match(b.etat.taches[0].summary, /reglage_introuvable/)
})

test('une PANNE de lecture des reservations empeche l envoi', async () => {
  const b = bancNominal({ taches: [tache()], panneSnapshots: true })
  const bilan = await lancer(b, { envoyer: async () => { throw new Error('ne doit pas etre appele') } })
  assert.equal(bilan.abandonnes, 1)
  assert.match(b.etat.taches[0].summary, /reservations_illisibles/)
})

test('⚠ CONSTAT 13 : le reglage d un AUTRE compte ne gouverne pas cet envoi', async () => {
  // Les Map etaient clees sur le seul `provider_property_id` : des que deux
  // comptes partagent une ref provider (bien en bascule, bien re-provisionne),
  // le reglage ET le `automation_paused` d un autre compte gouvernaient.
  // Ici : MON compte est en auto, un AUTRE compte a le meme ref en pause.
  const AUTRE = 'compte-2'
  const b = banc({
    taches: [tache()],
    biens: [bienOuvert, { ...bienOuvert, id: 'uuid-autre', user_id: AUTRE, automation_paused: true }],
    config: CONFIG_AUTO
  })
  const bilan = await lancer(b, { envoyer: async () => ({ ok: true, canal: 'ota' }) })
  assert.equal(bilan.envoyes, 1, 'mon bien part : la pause de l autre compte ne me concerne pas')
})

test('⚠ CONSTAT 4 : un statut non ecrit apres un envoi SONNE, et ne compte pas', async () => {
  // Le cron claime, envoie ; l hote a cloture entre-temps. L UPDATE conditionne
  // sur `sending` ne touche aucune ligne — et `bilan.envoyes++` montait quand
  // meme. Le voyageur avait recu le message, l hote lisait « rejetee ».
  const b = bancNominal({ taches: [tache()] })
  const results = { errors: [] }
  const bilan = await envoyerBrouillonsDus(results, {
    sb: b.client, maintenant: T0,
    journaliser: async () => {},
    envoyer: async () => {
      // L hote cloture pendant l appel provider.
      b.etat.taches[0].status = 'ignored'
      return { ok: true, canal: 'ota' }
    }
  })
  assert.equal(bilan.envoyes, 0, 'il NE compte pas comme envoye')
  assert.equal(bilan.erreurs, 1)
  assert.ok(results.errors.some(e => e.context === 'brouillon_statut_apres_envoi'),
    'et l ecart est journalise')
})

// ════════════════════════════════════════════════════════════════════════════
// Les constats de la SECONDE revue — dont le chemin qu'aucun test ne traversait
// ════════════════════════════════════════════════════════════════════════════

test('⚠ CONSTAT 3 : `envoyerParDefaut` donne au provider une reservation AVEC son id', async () => {
  // Ce chemin n'etait traverse par AUCUN test : tous injectent `opts.envoyer`.
  // Resultat, il passait le snapshot BRUT — qui n'a pas d'`id` —, donc
  // `sendGuestMessage` calculait `String(undefined)` et TOUS les envois
  // differes reels ciblaient la reservation « undefined ».
  // Ici on appelle le vrai `envoyerParDefaut`, avec `sendGuestMessage` stube.
  const recu = []
  const faux = { exports: { sendGuestMessage: async (...a) => { recu.push(a); return { ok: true, canal: 'ota' } } } }
  const chemin = require.resolve('../lib/cron-messages')
  const avant = require.cache[chemin]
  require.cache[chemin] = { id: chemin, filename: chemin, loaded: true, exports: faux.exports }
  try {
    const b = bancNominal({ taches: [tache()] })
    // Pas de `opts.envoyer` : on veut le VRAI chemin.
    const bilan = await envoyerBrouillonsDus({ errors: [] }, {
      sb: b.client, maintenant: T0, journaliser: async () => {}
    })
    assert.equal(bilan.envoyes, 1)
    assert.equal(recu.length, 1, 'sendGuestMessage a bien ete appele')
    const booking = recu[0][2]
    assert.ok(booking && typeof booking === 'object', 'un objet, pas un identifiant nu')
    assert.equal(booking.id, 'BK1', `l id doit etre la reservation, recu ${JSON.stringify(booking.id)}`)
    assert.notEqual(String(booking.id), 'undefined', 'JAMAIS la chaine « undefined »')
    assert.equal(booking.source, 'Airbnb', 'et la source, qui decide du canal')
  } finally {
    if (avant) require.cache[chemin] = avant; else delete require.cache[chemin]
  }
})

test('⚠ CONSTAT 2 : le journal recoit la REF PROVIDER, jamais l UUID du bien', async () => {
  // La regle dure du depot : properties.id = UUID ; property_id des tables
  // enfant = TEXT (provider propId). Je passais `garde.bien`, dont `.id` est
  // l UUID : la ligne `conversations` ne matchait donc JAMAIS
  // `hasNewerTaskOrConv`, et l IA pouvait repondre une seconde fois.
  const b = bancNominal({ taches: [tache()] })
  await lancer(b, { envoyer: async () => ({ ok: true, canal: 'ota' }) })
  assert.equal(b.journal.length, 1)
  const j = b.journal[0]
  assert.equal(j.property.id, REF, `la ref provider attendue, recu ${JSON.stringify(j.property.id)}`)
  assert.notEqual(j.property.id, 'uuid-bien', 'JAMAIS l UUID')
  // Le reste du bien suit, pour `provider` et le nom.
  assert.equal(j.property.provider, 'channex')
  assert.equal(j.property.name, 'La bulle')
})

test('⚠ CONSTAT 7 : le differe ferme aussi les taches « reçu pendant la pause »', async () => {
  const b = bancNominal({ taches: [tache()] })
  await lancer(b, { envoyer: async () => ({ ok: true, canal: 'ota' }) })
  assert.equal(typeof b.journal[0].fermerPause, 'function',
    'le chemin immediat la passe, le differe doit la passer aussi')
})

test('⚠ CONSTAT 10 : l ota passe est la SOURCE du snapshot, pas un champ absent', async () => {
  const b = bancNominal({ taches: [tache()] })
  await lancer(b, { envoyer: async () => ({ ok: true, canal: 'ota' }) })
  assert.equal(b.journal[0].ota, 'Airbnb',
    'le snapshot porte `source` ; lire `ota` rendait undefined et coutait une requete de plus')
})

test('⚠ CONSTAT 5 : une orpheline rendue n est plus « suspendue » (pas d etat sans issue)', async () => {
  // Desarmer en laissant `suspendu_le` produisait « vous modifiez » pour
  // toujours : pas de lien de reprise (il exige une echeance) et pas de reprise
  // automatique (elle exige `send_after` non nul).
  const b = bancNominal({ taches: [tache({
    status: STATUT_EN_COURS,
    suspendu_le: new Date(T0 - 60 * 60000).toISOString(),
    updated_at: new Date(T0 - SENDING_ORPHELIN_MS - 60000).toISOString()
  })] })
  const bilan = await lancer(b, { envoyer: async () => { throw new Error('ne doit pas etre appele') } })
  assert.equal(bilan.orphelines, 1)
  const t = b.etat.taches[0]
  assert.equal(t.status, 'pending_validation')
  assert.equal(t.send_after, null)
  assert.equal(t.suspendu_le, null, 'la suspension est levee : pas d etat sans issue')
})
