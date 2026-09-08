// tests/book-public-endpoint.test.js
// Spec : docs/specs/spec-moteur-reservation.md §4 — DOC : docs/kb/moteur-reservation.md
//
// CE QUE CES TESTS DEFENDENT : le CONTRAT PUBLIC de l'endpoint.
// C'est le seul endpoint du depot qu'un inconnu peut appeler sans session.
// Ce qui en sort part sur l'internet public — d'ou des tests qui verifient
// autant ce qui N'EST PAS rendu que ce qui l'est.

const test = require('node:test')
const assert = require('node:assert')
const Module = require('node:module')

process.env.SUPABASE_URL = 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = 'test'

// ─── Harnais ────────────────────────────────────────────────────────────────
const etat = {
  lien: null, erreurLien: null, bien: null, erreurBien: null,
  inventaire: [], snapshots: [], erreurSnap: null, verrous: [], requetes: []
}

function table (nom) {
  const q = { table: nom, filtres: {} }
  etat.requetes.push(q)
  const chaine = {
    select (champs) { q.champs = champs; return chaine },
    eq (col, val) { q.filtres[col] = val; return chaine },
    gte (col, val) { q.filtres[`${col}>=`] = val; return chaine },
    lte (col, val) { q.filtres[`${col}<=`] = val; return chaine },
    like (col, val) { q.filtres[`${col}~`] = val; return chaine },
    gt (col, val) { q.filtres[`${col}>`] = val; return chaine },
    async maybeSingle () {
      if (nom === 'booking_links') {
        if (etat.erreurLien) return { data: null, error: { message: etat.erreurLien } }
        return { data: etat.lien && etat.lien.token === q.filtres.token ? etat.lien : null, error: null }
      }
      if (etat.erreurBien) return { data: null, error: { message: etat.erreurBien } }
      return { data: etat.bien && etat.bien.id === q.filtres.id ? etat.bien : null, error: null }
    },
    then (res) {
      if (nom === 'calendar_inventory') return res({ data: etat.inventaire, error: null })
      if (nom === 'write_locks') return res({ data: etat.verrous, error: null })
      if (etat.erreurSnap) return res({ data: null, error: { message: etat.erreurSnap } })
      return res({ data: etat.snapshots, error: null })
    }
  }
  return chaine
}

const origine = Module._load
Module._load = function (demande, parent, isMain) {
  if (demande === '@supabase/supabase-js') return { createClient: () => ({ from: table }) }
  return origine.apply(this, arguments)
}
const handler = require('../api/book-public')
Module._load = origine

// ─── Faux req / res ─────────────────────────────────────────────────────────
function appeler (query, methode) {
  const req = { method: methode || 'GET', query }
  const rep = { code: 0, corps: null }
  const res = {
    status (c) { rep.code = c; return res },
    json (o) { rep.corps = o; return res },
    end () { return res }
  }
  return handler(req, res).then(() => rep)
}

const JETON = 'a'.repeat(43)
const LIEN = {
  id: 'uuid-lien', property_id: 'uuid-bien', token: JETON,
  label: 'Site vitrine', price_coefficient: 100, active: true
}
const BIEN = {
  id: 'uuid-bien', user_id: 'uuid-hote',
  name: 'Le Nid', city: 'Tarbes', country: 'FR', currency: 'EUR',
  capacity: 4, included_guests: 2, extra_guest_fee: 10, base_price: 80,
  inventory_units: 1, checkin_time: '16:00', checkout_time: '10:00',
  provider: 'channex', provider_property_id: 'prop-123',
  provider_room_type_id: 'rt-1', provider_rate_plan_id: 'rp-1'
}

function reinit (sur, surLien) {
  etat.bien = { ...BIEN, ...(sur || {}) }
  etat.lien = { ...LIEN, ...(surLien || {}) }
  etat.erreurBien = null; etat.erreurLien = null; etat.erreurSnap = null
  etat.inventaire = []; etat.snapshots = []; etat.verrous = []; etat.requetes = []
}

// ─── Jeton ──────────────────────────────────────────────────────────────────
test('un jeton de mauvaise forme est refuse SANS interroger la base', async () => {
  reinit()
  for (const mauvais of ['', 'court', 'a'.repeat(42), 'a'.repeat(44), 'a'.repeat(42) + '!', "' or 1=1--"]) {
    const r = await appeler({ token: mauvais })
    assert.equal(r.code, 404, `jeton "${mauvais.slice(0, 12)}" doit etre refuse`)
    assert.equal(r.corps.error, 'lien_inconnu')
  }
  assert.equal(etat.requetes.length, 0, 'aucune requete ne doit partir vers Postgres')
})

test('un jeton bien forme mais inconnu rend 404', async () => {
  reinit()
  const r = await appeler({ token: 'b'.repeat(43) })
  assert.equal(r.code, 404)
})

test('une panne de lecture ne passe JAMAIS pour un lien inconnu', async () => {
  // Sinon le voyageur voit une page morte et l'hote croit son lien revoque.
  reinit(); etat.erreurLien = 'connexion perdue'
  const r = await appeler({ token: JETON })
  assert.equal(r.code, 500)
  assert.equal(r.corps.error, 'indisponible')
})

test('une panne sur bookings_snapshot ne passe pas pour « aucune reservation »', async () => {
  // Le calendrier afficherait libres des nuits deja vendues.
  reinit(); etat.erreurSnap = 'timeout'
  const r = await appeler({ token: JETON })
  assert.equal(r.code, 500)
})

// ─── Ce qui sort ────────────────────────────────────────────────────────────
test('la reponse ne contient AUCUN champ interne', async () => {
  reinit()
  const r = await appeler({ token: JETON })
  assert.equal(r.code, 200)
  const brut = JSON.stringify(r.corps)
  for (const interdit of ['uuid-hote', 'uuid-bien', 'uuid-lien', 'prop-123', JETON,
                          'user_id', 'price_coefficient', 'Site vitrine', 'provider']) {
    assert.ok(!brut.includes(interdit), `la reponse publie « ${interdit} »`)
  }
  assert.equal(r.corps.bien.nom, 'Le Nid')
  assert.equal(r.corps.bien.capacite, 4)
})

test('aucune nuit ne dit POURQUOI elle est indisponible', async () => {
  reinit()
  etat.inventaire = [{ date: new Date().toISOString().slice(0, 10), stop_sell: true }]
  const r = await appeler({ token: JETON })
  const n = r.corps.nuits[0]
  assert.equal(n.disponible, false)
  assert.equal(n.raison, undefined, 'ferme par choix ou deja vendu ne regarde pas le public')
  assert.equal(n.restant, undefined)
})

test('le filtre user_id est pose sur bookings_snapshot', async () => {
  // Sans lui, deux hotes partageant un provider_property_id se ferment
  // mutuellement des nuits.
  reinit()
  await appeler({ token: JETON })
  const q = etat.requetes.find(x => x.table === 'bookings_snapshot')
  assert.equal(q.filtres.user_id, 'uuid-hote')
  assert.equal(q.filtres.property_id, 'prop-123')
})

test('calendar_inventory est lu par UUID, bookings_snapshot par id provider', async () => {
  // Le piege de cle : les intervertir rend zero ligne EN SILENCE, donc un
  // calendrier entierement libre au prix de base.
  reinit()
  await appeler({ token: JETON })
  assert.equal(etat.requetes.find(x => x.table === 'calendar_inventory').filtres.property_id, 'uuid-bien')
  assert.equal(etat.requetes.find(x => x.table === 'bookings_snapshot').filtres.property_id, 'prop-123')
})

test('les select sont des listes fermees, jamais une etoile', async () => {
  reinit()
  await appeler({ token: JETON })
  for (const t of ['properties', 'booking_links']) {
    const q = etat.requetes.find(x => x.table === t)
    assert.ok(!q.champs.includes('*'), `un select(*) sur ${t} publierait des champs internes`)
  }
})

// ─── Ajout 1 : le jeton resout un LIEN ─────────────────────────────────────
test('un lien REVOQUE est indistinguable d un lien inexistant', async () => {
  // Repondre differemment dirait a qui detient un ancien jeton qu il a existe.
  reinit(null, { active: false })
  const r = await appeler({ token: JETON })
  assert.equal(r.code, 404)
  assert.equal(r.corps.error, 'lien_inconnu')
  assert.ok(!etat.requetes.some(x => x.table === 'properties'), 'le bien n est meme pas lu')
})

test('deux liens du meme bien peuvent porter des coefficients differents', async () => {
  reinit(null, { price_coefficient: 100 })
  const a = await appeler({ token: JETON })
  reinit(null, { price_coefficient: 120 })
  const b = await appeler({ token: JETON })
  assert.equal(a.corps.nuits[0].prix, 80)
  assert.equal(b.corps.nuits[0].prix, 96)
})

test('le coefficient du lien porte jusqu au total encaisse', async () => {
  reinit(null, { price_coefficient: 120 })
  const d0 = new Date().toISOString().slice(0, 10)
  const plus = n => { const d = new Date(d0 + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
  const r = await appeler({ token: JETON, action: 'devis', arrivee: plus(2), depart: plus(5), personnes: '2' })
  assert.equal(r.corps.total, 288)          // 3 x 96
})

// ─── CONSTAT DE REVIEW : le kill switch ne ferme pas la vente ──────────────
test('paused_at n est pas lu — il n est meme plus demande a Postgres', async () => {
  reinit()
  await appeler({ token: JETON })
  const q = etat.requetes.find(x => x.table === 'properties')
  assert.ok(!q.champs.includes('paused_at'),
    'le kill switch d automatisation ne doit pas approcher le canal de vente')
})

// ─── CONSTAT DE REVIEW : les intentions en cours ───────────────────────────
test('les nuits sous intention sont lues et ferment le calendrier', async () => {
  reinit()
  const d0 = new Date().toISOString().slice(0, 10)
  etat.verrous = [{ key: `resa-nuit:uuid-hote:prop-123:${d0}` }]
  const r = await appeler({ token: JETON })
  assert.equal(r.corps.nuits[0].disponible, false)
  const q = etat.requetes.find(x => x.table === 'write_locks')
  assert.ok(q, 'write_locks doit etre interroge')
  assert.ok(String(q.filtres['key~']).startsWith('resa-nuit:uuid-hote:prop-123:'),
    'le prefixe cloisonne par hote ET par bien')
})

// ─── CONSTAT DE REVIEW : la borne de depart ────────────────────────────────
test('la reponse porte depart_max : le lendemain de la derniere nuit publiee', async () => {
  reinit()
  const r = await appeler({ token: JETON, jours: '10' })
  const derniere = r.corps.nuits[r.corps.nuits.length - 1].date
  const attendu = new Date(derniere + 'T00:00:00Z')
  attendu.setUTCDate(attendu.getUTCDate() + 1)
  assert.equal(r.corps.depart_max, attendu.toISOString().slice(0, 10))
})

// ─── Bien non vendable ──────────────────────────────────────────────────────
test('un bien sans base_price OUVRE — ses nuits sans prix sont invendables', async () => {
  // Avant le 8 septembre 2026 : la page rendait 200 ferme. Le modele « prix par
  // date uniquement » de Thierry rendait ses biens definitivement invendables.
  reinit({ base_price: null })
  const r = await appeler({ token: JETON })
  assert.equal(r.code, 200)
  assert.equal(r.corps.ouvert, true, 'la boutique ouvre')
  assert.ok(Array.isArray(r.corps.nuits), 'le calendrier est rendu')
  const vendables = r.corps.nuits.filter(n => n.disponible)
  assert.equal(vendables.length, 0, 'mais aucune nuit sans prix n est vendable')
})

test('un bien kill-switche reste EN VENTE : le coupe-circuit coupe les messages', async () => {
  reinit({ paused_at: '2026-09-01T00:00:00Z', automation_paused: true })
  const r = await appeler({ token: JETON })
  assert.equal(r.corps.ouvert, true, 'une boucle IA ne doit pas fermer la boutique')
  assert.ok(r.corps.nuits.length > 0)
})

// ─── Devis ──────────────────────────────────────────────────────────────────
test('le devis calcule le total cote SERVEUR', async () => {
  reinit()
  const d0 = new Date().toISOString().slice(0, 10)
  const plus = n => { const d = new Date(d0 + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
  const r = await appeler({ token: JETON, action: 'devis', arrivee: plus(2), depart: plus(5), personnes: '2' })
  assert.equal(r.corps.ok, true)
  assert.equal(r.corps.nuits, 3)
  assert.equal(r.corps.total, 240)
  assert.equal(r.corps.devise, 'EUR')
})

test('le devis refuse un total dicte par le client', async () => {
  // Le montant n'a qu'une seule source : ce calcul. Rien de ce que la page
  // envoie n'est repris.
  reinit()
  const d0 = new Date().toISOString().slice(0, 10)
  const plus = n => { const d = new Date(d0 + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
  const r = await appeler({ token: JETON, action: 'devis', arrivee: plus(2), depart: plus(5), personnes: '2', total: '1' })
  assert.equal(r.corps.total, 240)
})

test('le devis refuse un sejour hors capacite', async () => {
  reinit()
  const d0 = new Date().toISOString().slice(0, 10)
  const plus = n => { const d = new Date(d0 + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
  const r = await appeler({ token: JETON, action: 'devis', arrivee: plus(2), depart: plus(5), personnes: '9' })
  assert.equal(r.corps.ok, false)
  assert.equal(r.corps.raison, 'trop_de_voyageurs')
  assert.equal(r.corps.total, 0)
})

// ─── Methode et bornes ──────────────────────────────────────────────────────
test('POST est hors contrat : l etape 1 est en lecture seule', async () => {
  reinit()
  const r = await appeler({ token: JETON }, 'POST')
  assert.equal(r.code, 405)
})

test('la fenetre est bornee meme si le client en demande trente ans', async () => {
  reinit()
  const r = await appeler({ token: JETON, jours: '99999' })
  assert.equal(r.corps.jours, 365)
  assert.equal(r.corps.nuits.length, 365)
})

test('un debut dans le passe est ignore : la fenetre part d aujourd hui', async () => {
  reinit()
  const r = await appeler({ token: JETON, debut: '2020-01-01' })
  assert.equal(r.corps.debut, new Date().toISOString().slice(0, 10))
})
