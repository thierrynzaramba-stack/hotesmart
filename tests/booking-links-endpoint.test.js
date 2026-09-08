// tests/booking-links-endpoint.test.js
// Spec : docs/specs/spec-moteur-reservation.md §3 ter (ajout 3) et §6 bis
//
// CE QUE CES TESTS DEFENDENT : l'app « Reservation directe ».
// C'est l'ecran qui decide QUI peut vendre, A QUEL PRIX et A QUELLES
// CONDITIONS. Le cloisonnement y compte autant que sur la page publique — sauf
// qu'ici la faute serait de laisser un compte toucher aux liens d'un autre.

const test = require('node:test')
const assert = require('node:assert')
const Module = require('node:module')

process.env.SUPABASE_URL = 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = 'test'
process.env.APP_URL = 'https://exemple.test'

const etat = { garde: null, biens: [], liens: [], requetes: [], ecritures: [] }

function table (nom) {
  const q = { table: nom, filtres: {}, maj: null }
  etat.requetes.push(q)
  const chaine = {
    select () { return chaine },
    eq (c, v) { q.filtres[c] = v; return chaine },
    in (c, v) { q.filtres[c + '@'] = v; return chaine },
    order () { return chaine },
    update (m) { q.maj = m; etat.ecritures.push({ table: nom, maj: m, filtres: q.filtres }); return chaine },
    insert (r) { q.insert = r; etat.ecritures.push({ table: nom, insert: r }); return chaine },
    async maybeSingle () {
      if (nom === 'properties') {
        const b = etat.biens.find(x => x.id === q.filtres.id)
        return { data: b || null, error: null }
      }
      if (nom === 'booking_links') {
        if (q.insert) { const l = { id: 'neuf', created_at: 'now', ...q.insert }; etat.liens.push(l); return { data: l, error: null } }
        const l = etat.liens.find(x => Object.entries(q.filtres).every(([c, v]) => String(x[c]) === String(v)))
        return { data: l ? { ...l, ...(q.maj || {}) } : null, error: null }
      }
      return { data: null, error: null }
    },
    then (res) {
      if (nom === 'properties') return res({ data: etat.biens, error: null })
      if (nom === 'booking_links') {
        const sel = etat.liens.filter(x => Object.entries(q.filtres)
          .every(([c, v]) => c.endsWith('@') ? v.includes(x[c.slice(0, -1)]) : String(x[c]) === String(v)))
        return res({ data: sel, error: null })
      }
      return res({ data: [], error: null })
    }
  }
  return chaine
}

const origine = Module._load
Module._load = function (d) {
  if (d === '@supabase/supabase-js') return { createClient: () => ({ from: table }) }
  if (d === '../lib/require-permission') return {
    requirePermission: async (req, res, opts) => {
      etat.gardeDemandee = opts
      if (!etat.garde) { res.status(403).json({ error: 'refuse' }); return { ok: false } }
      // ⚠ Le bien est RESOLU PAR LA GARDE, jamais pris tel quel du client.
      if (opts.bienRequis) {
        const b = etat.biens.find(x => x.id === opts.bien)
        if (!b) { res.status(404).json({ error: 'bien_introuvable' }); return { ok: false } }
        // ⚠ AUSSI PAUVRE QUE LA VRAIE GARDE. `resoudreBien` ne selectionne que
        // ces cinq colonnes — un faux plus genereux avait laisse passer un bug
        // ou `raisonNonVendable` voyait toujours `sans_prix_de_base`.
        const pauvre = { id: b.id, user_id: b.user_id, name: b.name, provider: b.provider, provider_property_id: b.provider_property_id }
        return { ok: true, userId: etat.appelant || etat.garde, accountUserId: etat.garde, bien: pauvre }
      }
      return { ok: true, userId: etat.appelant || etat.garde, accountUserId: etat.garde, bien: null }
    }
  }
  return origine.apply(this, arguments)
}
const handler = require('../api/booking-links')
Module._load = origine

function appeler (methode, query, body) {
  const req = { method: methode, query: query || {}, body: body || {} }
  const rep = { code: 0, corps: null }
  const res = { status (c) { rep.code = c; return res }, json (o) { rep.corps = o; return res }, end () { return res } }
  return handler(req, res).then(() => rep)
}

const BIEN = {
  id: 'uuid-bien', user_id: 'uuid-hote', name: 'Le Nid', base_price: 80, currency: 'EUR', capacity: 4,
  cancellation_policy: 'j7', provider: 'channex', provider_property_id: 'prop-1', inventory_units: 1
}

function reinit (surBien) {
  etat.garde = 'uuid-hote'
  etat.appelant = null            // par defaut : le titulaire lui-meme
  etat.biens = [{ ...BIEN, ...(surBien || {}) }]
  etat.liens = []
  etat.requetes = []; etat.ecritures = []
}

// ─── La garde ───────────────────────────────────────────────────────────────
test('sans droit, rien ne passe', async () => {
  reinit(); etat.garde = null
  assert.equal((await appeler('GET', {})).code, 403)
  assert.equal((await appeler('POST', { bien: 'uuid-bien' }, { bien: 'uuid-bien' })).code, 403)
})

test('le bien est RESOLU PAR LA GARDE, jamais pris tel quel', async () => {
  // Un identifiant de bien fourni par le client est toujours revalide serveur :
  // c'est ce qui empeche de designer le bien d'un autre compte.
  reinit()
  const r = await appeler('POST', { bien: 'bien-d-un-autre' }, { bien: 'bien-d-un-autre', label: 'x' })
  assert.equal(r.code, 404)
  assert.equal(etat.ecritures.length, 0, 'rien ne doit etre ecrit')
})

test('l ecriture exige `reglages` en ECRITURE, la lecture en LECTURE', async () => {
  // ⚠ Y COMPRIS PAR BIEN. Constat de review : lister les liens d'un bien passait
  // par `write`, donc un profil `reglages: read` recevait 403 sur un affichage.
  reinit()
  await appeler('GET', {})
  assert.deepEqual({ d: etat.gardeDemandee.domaine, n: etat.gardeDemandee.niveau }, { d: 'reglages', n: 'read' })
  await appeler('GET', { bien: 'uuid-bien' })
  assert.equal(etat.gardeDemandee.niveau, 'read', 'lire les liens d un bien ne demande pas d ecrire')
  await appeler('POST', { bien: 'uuid-bien' }, { bien: 'uuid-bien', label: 'x' })
  assert.deepEqual({ d: etat.gardeDemandee.domaine, n: etat.gardeDemandee.niveau }, { d: 'reglages', n: 'write' })
})

test('UN COLLABORATEUR NE VEND PAS : titulaire uniquement en ecriture', async () => {
  // ⚠ Le contresens que tests/pages-non-delegables.test.js documente : masquer
  // une entree de menu NE FERME PAS la page. `reglages` est delegable, donc un
  // collaborateur pouvait appeler cet endpoint en direct — creer un lien de
  // vente, fixer son coefficient a 1 %, ou revoquer tous les liens actifs.
  reinit()
  etat.appelant = 'uuid-collaborateur'
  for (const [m, b] of [['POST', { label: 'x' }], ['PATCH', { id: '11111111-1111-4111-8111-111111111111', active: false }]]) {
    const r = await appeler(m, { bien: 'uuid-bien' }, { bien: 'uuid-bien', ...b })
    assert.equal(r.code, 403, m)
    assert.equal(r.corps.error, 'titulaire_uniquement')
  }
  assert.equal(etat.ecritures.length, 0, 'rien ne doit etre ecrit')

  // Mais il peut LIRE : le masquage du menu n'est pas un secret.
  assert.equal((await appeler('GET', { bien: 'uuid-bien' })).code, 200)
})

test('une methode hors contrat est refusee', async () => {
  reinit()
  assert.equal((await appeler('DELETE', { bien: 'uuid-bien' })).code, 405)
})

// ─── Les liens ──────────────────────────────────────────────────────────────
test('creer un lien rend une URL complete et un jeton de 43 caracteres', async () => {
  reinit()
  const r = await appeler('POST', { bien: 'uuid-bien' }, { bien: 'uuid-bien', label: 'Site vitrine', coefficient: 110 })
  assert.equal(r.code, 200)
  assert.match(r.corps.lien.url, /^https:\/\/exemple\.test\/book\/[A-Za-z0-9_-]{43}$/)
  assert.equal(r.corps.lien.coefficient, 110)
  assert.equal(r.corps.lien.active, true)
})

test('le coefficient par defaut est 100 %', async () => {
  reinit()
  const r = await appeler('POST', { bien: 'uuid-bien' }, { bien: 'uuid-bien', label: 'x' })
  assert.equal(r.corps.lien.coefficient, 100)
})

test('un coefficient hors bornes est REFUSE, comme la contrainte SQL', async () => {
  // Un 0 vendrait les nuits gratuitement, un negatif rembourserait le voyageur,
  // et le plafond attrape la faute de frappe (10000 au lieu de 100).
  reinit()
  for (const mauvais of [0, -10, 1001, 'abc', NaN]) {
    const r = await appeler('POST', { bien: 'uuid-bien' }, { bien: 'uuid-bien', coefficient: mauvais })
    assert.equal(r.code, 400, `coefficient ${mauvais}`)
    assert.equal(r.corps.error, 'coefficient_invalide')
  }
  assert.equal(etat.ecritures.length, 0)
})

test('REVOQUER, C EST DESACTIVER — jamais supprimer', async () => {
  // La provenance des reservations deja creees par ce lien doit rester lisible,
  // et `booking_attempts.link_id` porte un `on delete restrict`.
  reinit()
  etat.liens.push({ id: '11111111-1111-4111-8111-111111111111', property_id: 'uuid-bien', token: 'z'.repeat(43), label: 'x', price_coefficient: 100, active: true })
  const r = await appeler('PATCH', { bien: 'uuid-bien' }, { bien: 'uuid-bien', id: '11111111-1111-4111-8111-111111111111', active: false })
  assert.equal(r.code, 200)
  const ecr = etat.ecritures.find(e => e.table === 'booking_links')
  assert.deepEqual(ecr.maj, { active: false }, 'un UPDATE, pas un DELETE')
})

test('un lien d un AUTRE bien ne se modifie pas', async () => {
  // Sans confrontation au bien deja valide, un identifiant de lien suffirait a
  // modifier le lien d'un autre compte.
  reinit()
  etat.liens.push({ id: '22222222-2222-4222-8222-222222222222', property_id: 'autre-bien', token: 'y'.repeat(43), active: true })
  const r = await appeler('PATCH', { bien: 'uuid-bien' }, { bien: 'uuid-bien', id: '22222222-2222-4222-8222-222222222222', active: false })
  assert.equal(r.code, 404)
  assert.equal(r.corps.error, 'lien_inconnu')
})

// ─── La politique d'annulation ──────────────────────────────────────────────
test('seules les quatre politiques du §2 sont acceptees', async () => {
  reinit()
  for (const p of ['non_remboursable', 'j14', 'j7', 'flexible_j2']) {
    assert.equal((await appeler('POST', { bien: 'uuid-bien' }, { bien: 'uuid-bien', action: 'politique', politique: p })).code, 200, p)
  }
  const r = await appeler('POST', { bien: 'uuid-bien' }, { bien: 'uuid-bien', action: 'politique', politique: 'gratuit_toujours' })
  assert.equal(r.code, 400)
  assert.deepEqual(r.corps.valides, ['non_remboursable', 'j14', 'j7', 'flexible_j2'])
})

// ─── Ce que la liste dit a l hote ───────────────────────────────────────────
test('un bien qui ne peut pas vendre dit POURQUOI', async () => {
  // « Non vendable » sans motif envoie l'hote chercher au hasard.
  reinit({ base_price: null })
  const r = await appeler('GET', {})
  assert.equal(r.corps.biens[0].bloquant, 'sans_prix_de_base')

  reinit({ provider_property_id: null })
  assert.equal((await appeler('GET', {})).corps.biens[0].bloquant, 'sans_lien_provider')

  reinit()
  assert.equal((await appeler('GET', {})).corps.biens[0].bloquant, null)
})

test('la liste ne sort QUE les biens du compte', async () => {
  reinit()
  await appeler('GET', {})
  const q = etat.requetes.find(x => x.table === 'properties')
  assert.equal(q.filtres.user_id, 'uuid-hote')
})

test('l activation du moteur EST le lien : aucun drapeau separe', async () => {
  // Un second interrupteur creerait deux verites sur la meme question.
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'api/booking-links.js'), 'utf8')
  assert.ok(!/moteur_actif|engine_enabled|booking_enabled/.test(src))
  // Et le kill switch d'automatisation n'a rien a faire ici.
  assert.ok(!/paused_at|automation_paused/.test(src.replace(/\/\/.*$/gm, '')))
})


// ─── CONSTATS DE REVIEW ─────────────────────────────────────────────────────
test('creer un lien sur un bien qui ne peut pas vendre PREVIENT', async () => {
  // L'outil de service remplace avertissait avant d'ecrire ; ce garde-fou
  // s'etait perdu dans le passage a l'app. Sans lui, l'hote voit « actif »,
  // colle l'URL, et chaque visiteur lit « ce logement n'est pas ouvert ».
  reinit({ base_price: null })
  const r = await appeler('POST', { bien: 'uuid-bien' }, { bien: 'uuid-bien', label: 'x' })
  assert.equal(r.code, 200, 'on n interdit pas : preparer un lien avant le prix est legitime')
  assert.equal(r.corps.bloquant, 'sans_prix_de_base', 'mais on le DIT')

  reinit()
  assert.equal((await appeler('POST', { bien: 'uuid-bien' }, { bien: 'uuid-bien' })).corps.bloquant, null)
})

test('une politique passee sous une autre forme ne part pas brute en base', async () => {
  // `String(['j7']) === 'j7'` passait la liste blanche, puis `['j7']` partait tel
  // quel dans l'update : 500 au lieu d'un 400 explicite.
  reinit()
  const r = await appeler('POST', { bien: 'uuid-bien' }, { bien: 'uuid-bien', action: 'politique', politique: ['j7'] })
  assert.equal(r.code, 200)
  const ecr = etat.ecritures.find(e => e.table === 'properties')
  assert.strictEqual(ecr.maj.cancellation_policy, 'j7', 'la valeur NORMALISEE, pas la brute')
})

test('un identifiant de lien mal forme rend 404, pas 500', async () => {
  // `.eq('id', …)` sur une colonne uuid avec une valeur qui n'en est pas fait
  // ECHOUER la requete — piege deja grave dans lib/require-permission.js.
  reinit()
  for (const mauvais of ['pas-un-uuid', '1', '', "' or 1=1--"]) {
    const r = await appeler('PATCH', { bien: 'uuid-bien' }, { bien: 'uuid-bien', id: mauvais, active: false })
    assert.equal(r.code, 404, `id « ${mauvais} »`)
    assert.equal(r.corps.error, 'lien_inconnu')
  }
})
