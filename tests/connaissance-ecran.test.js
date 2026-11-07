// tests/connaissance-ecran.test.js — `/api/ecran/connaissance` (KB V5, lot 3)
//
// ⚠ CET ENDPOINT LIT ET ÉCRIT AVEC LA CLÉ DE SERVICE : aucune policy RLS ne
// s'applique. Le seul cloisonnement entre comptes est celui qu'on écrit en
// JavaScript — `user_id` et `property_id` sur CHAQUE requête —, et ce fichier le
// garde. Et c'est le writer de `knowledge` qui remplace la page qui supprimait
// tout le logement avant de réinsérer : les tests d'écriture affirment ce qui
// part en base, filtre par filtre.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert/strict')

const TITULAIRE = '11111111-1111-4111-8111-111111111111'
const MEMBRE = '22222222-2222-4222-8222-222222222222'

const BIENS = [
  { id: 'u-1', name: 'La bulle', provider_property_id: 'P1', photo_url: null, address: null, checkin_time: null, checkout_time: null },
  { id: 'u-2', name: 'Cœur', provider_property_id: 'P2', photo_url: 'https://x.test/p2.jpg', address: '9 rue Fiche', checkin_time: '16:00', checkout_time: null }
]

// ⚠ LES DATES SONT RELATIVES : `voyageurDuBien` lit l'horloge (« séjours dont
// le départ est aujourd'hui ou plus tard »). Une date figée rendrait ce test
// faux dans trois semaines.
const jour = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10)

/**
 * Un double de supabase-js qui ENREGISTRE chaque requête : table, opération,
 * charge, filtres, ordre, borne. `repondre(r)` rend `{ data, error }`.
 */
function fabriquerClient (repondre) {
  const requetes = []
  const client = {
    from (table) {
      const r = { table, op: 'select', colonnes: null, charge: null, options: null, filtres: [], ordre: [], limite: null, unique: false }
      const fin = () => {
        requetes.push(r)
        const rep = repondre(r) || { data: [], error: null }
        if (r.unique) {
          const d = Array.isArray(rep.data) ? (rep.data[0] || null) : rep.data
          return Promise.resolve({ data: rep.error ? null : d, error: rep.error || null })
        }
        return Promise.resolve(rep)
      }
      const q = {
        select (c) { if (r.op === 'select') r.colonnes = c; else r.retour = c; return q },
        insert (x) { r.op = 'insert'; r.charge = x; return q },
        update (x) { r.op = 'update'; r.charge = x; return q },
        upsert (x, o) { r.op = 'upsert'; r.charge = x; r.options = o; return q },
        delete () { r.op = 'delete'; return q },
        eq (c, v) { r.filtres.push(['eq', c, v]); return q },
        is (c, v) { r.filtres.push(['is', c, v]); return q },
        gt (c, v) { r.filtres.push(['gt', c, v]); return q },
        gte (c, v) { r.filtres.push(['gte', c, v]); return q },
        order (c, o) { r.ordre.push([c, (o || {}).ascending]); return q },
        limit (n) { r.limite = n; return q },
        maybeSingle () { r.unique = true; return fin() },
        single () { r.unique = true; return fin() },
        then (ok, ko) { return fin().then(ok, ko) }
      }
      return q
    }
  }
  return { client, requetes }
}

async function appeler ({ methode = 'GET', query = {}, corps = null, titulaire = true, repondre }) {
  const { client, requetes } = fabriquerClient(repondre || (() => ({ data: [], error: null })))
  const absSdk = require.resolve('@supabase/supabase-js')
  require('@supabase/supabase-js')
  const vraiCreate = require.cache[absSdk].exports.createClient
  require.cache[absSdk].exports.createClient = () => client

  const absGarde = require.resolve('../lib/require-permission')
  require('../lib/require-permission')
  const vraieGarde = require.cache[absGarde].exports
  const contexte = titulaire
    ? { userId: TITULAIRE, accountUserId: TITULAIRE, profil: null, permissions: null }
    : { userId: MEMBRE, accountUserId: TITULAIRE,
        profil: { active: true, accepted_at: '2026-01-01', member_user_id: MEMBRE, account_user_id: TITULAIRE },
        permissions: { property_scope: 'all', property_ids: [], property_refs: [], messages: 'write', messagerie: 'write', reglages: 'write' } }
  // ⚠ LE DOUBLE POSE L'EN-TÊTE PRIVÉ, COMME LA VRAIE GARDE : sans lui, le test
  // « l'en-tête précède le refus de méthode » ne pourrait pas échouer.
  require.cache[absGarde].exports = Object.assign({}, vraieGarde, {
    contexteDEcran: async (rq, rs) => {
      rs.setHeader('Cache-Control', 'private, no-store')
      return { ok: true, userId: contexte.userId, accountUserId: TITULAIRE, contexte }
    }
  })
  const absEndpoint = require.resolve('../api/ecran/connaissance')
  delete require.cache[absEndpoint]
  const endpoint = require(absEndpoint)

  const rep = { statut: null, charge: null, entetes: {} }
  const res = {
    setHeader (k, v) { rep.entetes[k] = v },
    status (s) { rep.statut = s; return res },
    json (c) { rep.charge = c; return res }
  }
  try {
    await endpoint({ method: methode, query, body: corps }, res)
  } finally {
    require.cache[absSdk].exports.createClient = vraiCreate
    require.cache[absGarde].exports = vraieGarde
    delete require.cache[absEndpoint]
  }
  return { ...rep, requetes }
}

// Un répondeur par défaut : les biens, une base, des réservations.
function base ({ lignes = [], resas = [], erreurKnowledge = null } = {}) {
  return (r) => {
    if (r.table === 'properties') return { data: BIENS, error: null }
    if (r.table === 'knowledge' && r.op === 'select') {
      if (erreurKnowledge && /verifie_le/.test(r.colonnes)) return { data: null, error: erreurKnowledge }
      const apres = (r.filtres.find(f => f[0] === 'gt') || [])[2]
      const parId = [...lignes].sort((a, b) => (a.id < b.id ? -1 : 1))
      const restant = apres == null ? parId : parId.filter(l => l.id > apres)
      return { data: restant.slice(0, r.limite || 1000), error: null }
    }
    if (r.table === 'bookings_snapshot') {
      const resa = (r.filtres.find(f => f[1] === 'booking_id') || [])[2]
      const bien = (r.filtres.find(f => f[1] === 'property_id') || [])[2]
      const lignesB = resas.filter(x => x.property_id === bien && (resa == null || x.booking_id === resa))
      return { data: lignesB, error: null }
    }
    return { data: [], error: null }
  }
}

const filtre = (r, colonne) => (r.filtres.find(f => f[1] === colonne) || [])[2]

test('LE TEST QUI COMPTE : un membre délégué est refusé en 403 AVANT toute lecture', async () => {
  // ⚠ LA BASE PORTE DES MOTS DE PASSE WIFI ET DES CODES D'IMMEUBLE. La page
  // remplacée était non délégable ; l'ouvrir aux membres serait une décision de
  // droits, pas un effet de bord de la refonte. Et le refus vient AVANT la
  // lecture : un 403 posé après a déjà sorti les données de la base.
  for (const methode of ['GET', 'POST']) {
    const r = await appeler({ methode, titulaire: false, corps: { action: 'enregistrer', bien: 'P1', key: 'x', value: 'y' }, repondre: base() })
    assert.equal(r.statut, 403, methode)
    assert.deepEqual(r.requetes, [], `${methode} : une requête a eu lieu`)
  }
})

test('l en-tête privé précède le refus de méthode (dette 90)', async () => {
  const r = await appeler({ methode: 'DELETE', repondre: base() })
  assert.equal(r.statut, 405)
  assert.equal(r.entetes.Allow, 'GET, POST')
  assert.equal(r.entetes['Cache-Control'], 'private, no-store')
  assert.deepEqual(r.requetes, [])
})

test('LE TEST QUI COMPTE : le GET peint tout l écran en TROIS requêtes, Server-Timing compris', async () => {
  const r = await appeler({
    query: { bien: 'P2' },
    repondre: base({
      lignes: [
        { id: 'a1', type: 'fixed', key: 'wifi_nom', value: 'RESEAU', verifie_le: null, lisible_par_ia: true },
        { id: 'a2', type: 'faq', key: 'Wifi', value: 'Bonjour {prenom}, le wifi est {wifi_nom} / {wifi_mdp}', verifie_le: null, lisible_par_ia: false }
      ],
      resas: [{ booking_id: 'B9', property_id: 'P2', snapshot: { status: 'confirmed', firstName: 'Ana', lastName: 'L', arrival: jour(3), departure: jour(5), email: 'ana@x.test', guestPhone: '+33600000000' } }]
    })
  })
  assert.equal(r.statut, 200)
  // properties + knowledge + voyageur : un écran, une poignée de requêtes.
  assert.equal(r.requetes.length, 3, r.requetes.map(x => x.table).join(', '))
  assert.match(r.entetes['Server-Timing'], /desc="3 requêtes"/)
  // ⚠ LE BIEN ARCHIVÉ N'EST PAS LU, ET TOUT EST CLOISONNÉ PAR COMPTE.
  const props = r.requetes.find(x => x.table === 'properties')
  assert.deepEqual(props.filtres.find(f => f[0] === 'is'), ['is', 'archive_le', null])
  for (const q of r.requetes) assert.equal(filtre(q, 'user_id'), TITULAIRE, `${q.table} sans user_id`)
  const kb = r.requetes.find(x => x.table === 'knowledge')
  assert.equal(filtre(kb, 'property_id'), 'P2')
  const resa = r.requetes.find(x => x.table === 'bookings_snapshot')
  assert.equal(filtre(resa, 'property_id'), 'P2', 'le voyageur de l aperçu est cherché dans CE bien')
  const c = r.charge
  assert.equal(c.bien.ref, 'P2')
  assert.equal(c.reponses.length, 1)
  const carte = c.reponses[0]
  assert.ok(!/[{}]/.test(carte.texte), 'jamais d accolades dans le texte affiché')
  assert.equal(carte.brut, 'Bonjour {prenom}, le wifi est {wifi_nom} / {wifi_mdp}', 'l éditeur recharge le texte brut')
  assert.equal(carte.horsIa, true)
  const mdp = carte.segments.find(s => s.cle === 'wifi_mdp')
  assert.equal(mdp.vide, true, 'le mot de passe n a pas de valeur : étiquette rouge')
  // L'aperçu passe par LE remplaceur, avec le vrai voyageur du logement.
  assert.match(carte.apercu, /^Bonjour Ana, le wifi est RESEAU \/ \[WIFI MOT DE PASSE\]$/)
  // ⚠ LE VOYAGEUR NE SORT QU'AVEC SON PRÉNOM : le snapshot porte aussi son
  // e-mail et son téléphone, dont l'écran n'a aucun besoin.
  assert.deepEqual(Object.keys(c.voyageur).sort(), ['arrivee', 'duFil', 'prenom', 'resa'])
  assert.equal(c.voyageur.duFil, false, 'sans ?resa=, l aperçu n est fait pour aucune conversation')
  assert.ok(!JSON.stringify(c).includes('ana@x.test'))
  assert.ok(!JSON.stringify(c).includes('+33600000000'))
  // Les balises insérables viennent du module, avec leur marqueur.
  assert.ok(c.balises.some(b => b.cle === 'wifi_nom' && b.libelle === 'Nom wifi' && b.marqueur === '[WIFI NOM]'))
})

// ─── « Utiliser » une réponse dans la conversation (spec kb-utiliser-reponse) ─
test('LE TEST QUI COMPTE : chaque réponse dit ce qui MANQUE pour partir telle quelle', async () => {
  // Le bouton « Utiliser » refuse sur ces trois signaux (R3) : jamais un
  // « [WIFI NOM] », un code non résolu ni une balise inconnue dans le fil.
  const r = await appeler({
    query: { bien: 'P2' },
    repondre: base({ lignes: [
      { id: 'a1', type: 'fixed', key: 'wifi_nom', value: 'RESEAU', verifie_le: null, lisible_par_ia: true },
      { id: 'b1', type: 'faq', key: 'Complet', value: 'Le wifi est {wifi_nom}', verifie_le: null, lisible_par_ia: true },
      { id: 'b2', type: 'faq', key: 'Manque', value: 'Code wifi : {wifi_mdp}', verifie_le: null, lisible_par_ia: true },
      { id: 'b3', type: 'faq', key: 'Code', value: 'Votre code : {code_acces}', verifie_le: null, lisible_par_ia: false },
      { id: 'b4', type: 'faq', key: 'Inconnue', value: 'Voir {plan_acces}', verifie_le: null, lisible_par_ia: true }
    ] })
  })
  assert.equal(r.statut, 200)
  const par = Object.fromEntries(r.charge.reponses.map(x => [x.sujet, x]))
  assert.deepEqual([par.Complet.manquants, par.Complet.inconnues, par.Complet.codeNonResolu], [[], [], false])
  assert.equal(par.Complet.apercu, 'Le wifi est RESEAU')
  assert.deepEqual(par.Manque.manquants, ['wifi_mdp'])
  assert.equal(par.Code.codeNonResolu, true)
  assert.deepEqual(par.Inconnue.inconnues, ['{plan_acces}'])
})

test('les infos de la RÉSERVATION absentes comptent aussi parmi les manques (le prénom a sa forme neutre)', async () => {
  const r = await appeler({
    query: { bien: 'P2', resa: 'B9' },
    repondre: base({
      lignes: [{ id: 'b1', type: 'faq', key: 'Arrivee', value: 'Bonjour {prenom} {nom}, arrivée le {arrivee}', verifie_le: null, lisible_par_ia: true }],
      resas: [{ booking_id: 'B9', property_id: 'P2', snapshot: { status: 'confirmed', firstName: 'Ana', departure: jour(5) } }]
    })
  })
  assert.deepEqual(r.charge.reponses[0].manquants.sort(), ['arrivee', 'nom'])
})

test('un PRÉNOM absent ne refuse pas : il prend la forme neutre (décision du 8 octobre 2026)', async () => {
  const r = await appeler({
    query: { bien: 'P2', resa: 'B9' },
    repondre: base({
      lignes: [{ id: 'b1', type: 'faq', key: 'Salut', value: 'Bonjour {prenom}, le wifi est prêt', verifie_le: null, lisible_par_ia: true }],
      resas: [{ booking_id: 'B9', property_id: 'P2', snapshot: { status: 'confirmed', lastName: 'Durand', arrival: jour(3), departure: jour(5) } }]
    })
  })
  assert.equal(r.charge.voyageur.duFil, true)
  assert.deepEqual(r.charge.reponses[0].manquants, [], 'le prénom n est pas un manque')
  assert.equal(r.charge.reponses[0].apercu, 'Bonjour, le wifi est prêt')
})

test('LE TEST QUI COMPTE : duFil n est vrai que pour la réservation DEMANDÉE, trouvée dans CE logement', async () => {
  // Sinon le serveur se rabat sur le prochain séjour du logement : bon pour
  // l'aperçu, mais « Bonjour Paul » dans le fil de Marie (R1).
  const resas = [
    { booking_id: 'B9', property_id: 'P2', snapshot: { status: 'confirmed', firstName: 'Ana', arrival: jour(3), departure: jour(5) } },
    { booking_id: 'B7', property_id: 'P1', snapshot: { status: 'confirmed', firstName: 'Marie', arrival: jour(1), departure: jour(4) } }
  ]
  const lignes = [{ id: 'b1', type: 'faq', key: 'Salut', value: 'Bonjour {prenom}', verifie_le: null, lisible_par_ia: true }]
  const duFil = await appeler({ query: { bien: 'P2', resa: 'B9' }, repondre: base({ lignes, resas }) })
  assert.equal(duFil.charge.voyageur.duFil, true)
  assert.equal(duFil.charge.reponses[0].apercu, 'Bonjour Ana')
  const ailleurs = await appeler({ query: { bien: 'P2', resa: 'B7' }, repondre: base({ lignes, resas }) })
  assert.equal(ailleurs.charge.voyageur.resa, 'B9', 'rabattu sur le prochain séjour de P2')
  assert.equal(ailleurs.charge.voyageur.duFil, false, 'B7 n est pas dans ce logement')
  const sans = await appeler({ query: { bien: 'P2' }, repondre: base({ lignes, resas }) })
  assert.equal(sans.charge.voyageur.duFil, false)
})

test('LE TEST QUI COMPTE : la lecture se pagine par CURSEUR, jamais tronquée à une page', async () => {
  const lignes = Array.from({ length: 205 }, (_, i) => ({
    id: 'k' + String(i).padStart(4, '0'), type: 'faq', key: 'Sujet ' + i, value: 'x', verifie_le: null, lisible_par_ia: true
  }))
  const r = await appeler({ query: { bien: 'P1' }, repondre: base({ lignes }) })
  assert.equal(r.statut, 200)
  assert.equal(r.charge.reponses.length, 205, 'les 205 entrées, pas les 200 premières')
  const lectures = r.requetes.filter(x => x.table === 'knowledge')
  assert.equal(lectures.length, 2)
  assert.deepEqual(lectures[0].ordre[0], ['id', undefined])
  assert.deepEqual(lectures[1].filtres.find(f => f[0] === 'gt'), ['gt', 'id', 'k0199'])
})

test('sans la migration, l écran marche et le dit (jamais un 500 pour deux colonnes de confort)', async () => {
  const r = await appeler({
    query: { bien: 'P1' },
    repondre: base({
      lignes: [{ id: 'a', type: 'faq', key: 'Parking', value: 'gratuit' }],
      erreurKnowledge: { code: '42703', message: 'column knowledge.verifie_le does not exist' }
    })
  })
  assert.equal(r.statut, 200)
  assert.equal(r.charge.migration, false)
  assert.equal(r.charge.reponses.length, 1)
  assert.equal(r.charge.reponses[0].horsIa, false, 'colonne absente = l IA lit, comme avant')
})

test('un bien inconnu ou absent rend le PREMIER bien en lecture', async () => {
  const r = await appeler({ query: { bien: 'P404' }, repondre: base() })
  assert.equal(r.charge.bien.ref, 'P1')
})

test('LE TEST QUI COMPTE : en écriture, le logement est OBLIGATOIRE et doit être du compte', async () => {
  // ⚠ RETOMBER SUR LE PREMIER BIEN, comme le fait la lecture, écrirait la
  // réponse d'un logement dans un AUTRE, sans un mot.
  const sans = await appeler({ methode: 'POST', corps: { action: 'enregistrer', key: 'x', value: 'y' }, repondre: base() })
  assert.equal(sans.statut, 400)
  const autre = await appeler({ methode: 'POST', corps: { action: 'enregistrer', bien: 'P404', key: 'x', value: 'y' }, repondre: base() })
  assert.equal(autre.statut, 403)
  for (const r of [sans, autre]) {
    assert.ok(!r.requetes.some(q => q.table === 'knowledge'), 'aucune écriture')
  }
})

test('LE TEST QUI COMPTE : modifier une réponse prête passe par son ID, jamais par son sujet', async () => {
  // ⚠ LA PREMIÈRE VERSION FAISAIT UN `upsert` SUR LE SUJET : corriger le sujet
  // créait une SECONDE ligne, et taper le sujet d'une autre réponse l'écrasait.
  const r = await appeler({
    methode: 'POST',
    corps: { action: 'enregistrer', bien: 'P1', type: 'faq', id: 'a2', key: ' Nouveau sujet ', value: 'Texte {prenom}', lisible_par_ia: false },
    repondre: (q) => (q.table === 'properties' ? { data: BIENS, error: null }
      : { data: [{ id: 'a2', type: 'faq', key: 'Nouveau sujet', value: 'Texte {prenom}' }], error: null })
  })
  assert.equal(r.statut, 200)
  const ecrit = r.requetes.filter(q => q.table === 'knowledge')
  assert.equal(ecrit.length, 1)
  assert.equal(ecrit[0].op, 'update')
  assert.equal(filtre(ecrit[0], 'id'), 'a2')
  assert.equal(filtre(ecrit[0], 'user_id'), TITULAIRE)
  assert.equal(filtre(ecrit[0], 'property_id'), 'P1')
  assert.equal(filtre(ecrit[0], 'type'), 'faq')
  assert.equal(ecrit[0].charge.key, 'Nouveau sujet')
  assert.equal(ecrit[0].charge.value, 'Texte {prenom}')
  assert.equal(ecrit[0].charge.lisible_par_ia, false)
  // ⚠ `verifie_le` EST POSÉE PAR LE GESTE DE L'HÔTE, et c'est maintenant.
  assert.ok(Math.abs(Date.parse(ecrit[0].charge.verifie_le) - Date.now()) < 5000)
})

test('une réponse introuvable (autre compte, autre bien, supprimée) rend 404', async () => {
  const r = await appeler({
    methode: 'POST',
    corps: { action: 'enregistrer', bien: 'P1', type: 'faq', id: 'zz', key: 'S', value: 'T' },
    repondre: (q) => (q.table === 'properties' ? { data: BIENS, error: null } : { data: [], error: null })
  })
  assert.equal(r.statut, 404)
})

test('LE TEST QUI COMPTE : une nouvelle réponse est INSÉRÉE ; un sujet déjà pris rend 409, rien n est écrasé', async () => {
  const ok = await appeler({
    methode: 'POST', corps: { action: 'enregistrer', bien: 'P1', type: 'faq', key: 'Parking', value: 'Gratuit' },
    repondre: (q) => (q.table === 'properties' ? { data: BIENS, error: null } : { data: [{ id: 'n1' }], error: null })
  })
  assert.equal(ok.statut, 200)
  const ins = ok.requetes.find(q => q.table === 'knowledge')
  assert.equal(ins.op, 'insert', 'jamais un upsert : il écraserait la réponse qui porte ce sujet')
  assert.equal(ins.charge.user_id, TITULAIRE)
  assert.equal(ins.charge.property_id, 'P1')
  assert.equal(ins.charge.type, 'faq')
  const pris = await appeler({
    methode: 'POST', corps: { action: 'enregistrer', bien: 'P1', type: 'faq', key: 'Parking', value: 'Gratuit' },
    repondre: (q) => (q.table === 'properties' ? { data: BIENS, error: null }
      : { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } })
  })
  assert.equal(pris.statut, 409)
  assert.equal(pris.charge.error, 'sujet_existe')
})

test('une réponse sans sujet, vide ou trop longue est refusée sans écrire', async () => {
  for (const corps of [
    { key: '  ', value: 'x' }, { key: 'S', value: '   ' },
    { key: 'S'.repeat(201), value: 'x' }, { key: 'S', value: 'x'.repeat(4001) }
  ]) {
    const r = await appeler({ methode: 'POST', corps: { action: 'enregistrer', bien: 'P1', type: 'faq', ...corps }, repondre: base() })
    assert.equal(r.statut, 400, JSON.stringify(corps).slice(0, 60))
    assert.ok(!r.requetes.some(q => q.table === 'knowledge'))
  }
})

test('LE TEST QUI COMPTE : un fait vidé est SUPPRIMÉ, jamais gardé avec une valeur vide', async () => {
  // La page remplacée n'écrivait jamais une ligne `fixed` vide ; dix lecteurs
  // lisent `knowledge`, aucun ne s'y attend.
  const r = await appeler({
    methode: 'POST', corps: { action: 'enregistrer', bien: 'P1', type: 'fixed', key: 'wifi_mdp', value: '   ' },
    repondre: base()
  })
  assert.equal(r.statut, 200)
  const q = r.requetes.find(x => x.table === 'knowledge')
  assert.equal(q.op, 'delete')
  assert.equal(filtre(q, 'key'), 'wifi_mdp')
  assert.equal(filtre(q, 'type'), 'fixed')
  assert.equal(filtre(q, 'user_id'), TITULAIRE)
  assert.equal(filtre(q, 'property_id'), 'P1')
})

test('un fait rempli s écrit par sa CLÉ (upsert sur l identité du fait), date de vérification posée', async () => {
  const r = await appeler({
    methode: 'POST', corps: { action: 'enregistrer', bien: 'P1', type: 'fixed', key: 'checkin', value: ' 17:00 ' },
    repondre: (q) => (q.table === 'properties' ? { data: BIENS, error: null } : { data: [{ id: 'f1' }], error: null })
  })
  assert.equal(r.statut, 200)
  const q = r.requetes.find(x => x.table === 'knowledge')
  assert.equal(q.op, 'upsert')
  assert.equal(q.options.onConflict, 'user_id,property_id,type,key')
  assert.equal(q.charge.value, '17:00')
  assert.ok(q.charge.verifie_le)
  // ⚠ L'IDENTITÉ DU FAIT EST DANS LA CHARGE : un upsert sans `user_id` ou sur
  // un autre bien écrirait chez quelqu'un d'autre (constat de review : rien ne
  // le vérifiait).
  assert.equal(q.charge.user_id, TITULAIRE)
  assert.equal(q.charge.property_id, 'P1')
  assert.equal(q.charge.type, 'fixed')
  assert.equal(q.charge.key, 'checkin')
})

test('supprimer vise UNE ligne du compte et du bien, et dit quand elle n existe pas', async () => {
  const r = await appeler({
    methode: 'POST', corps: { action: 'supprimer', bien: 'P1', id: 'a2' },
    repondre: (q) => (q.table === 'properties' ? { data: BIENS, error: null } : { data: [{ id: 'a2' }], error: null })
  })
  assert.equal(r.statut, 200)
  const q = r.requetes.find(x => x.table === 'knowledge')
  assert.equal(q.op, 'delete')
  assert.equal(filtre(q, 'id'), 'a2')
  assert.equal(filtre(q, 'user_id'), TITULAIRE)
  assert.equal(filtre(q, 'property_id'), 'P1')
  const absente = await appeler({
    methode: 'POST', corps: { action: 'supprimer', bien: 'P1', id: 'zz' },
    repondre: (q2) => (q2.table === 'properties' ? { data: BIENS, error: null } : { data: [], error: null })
  })
  assert.equal(absente.statut, 404)
})

test('LE TEST QUI COMPTE : la migration absente se dit en écriture (503), avec l erreur que PostgREST rend VRAIMENT', async () => {
  // ⚠ UNE ÉCRITURE QUI NOMME UNE COLONNE ABSENTE REND `PGRST204`, PAS 42703 —
  // constat de review : la première version de ce test fournissait l'erreur
  // d'un SELECT, que la base ne rend jamais à une écriture, et validait donc un
  // chemin inatteignable (REVIEW.md, règle 22). Forme mesurée dans le dépôt :
  // api/sms.js et lib/email-guestflow.js la reconnaissent déjà.
  for (const op of ['update', 'insert', 'upsert']) {
    const corps = op === 'upsert'
      ? { action: 'enregistrer', bien: 'P1', type: 'fixed', key: 'checkin', value: '17:00' }
      : { action: 'enregistrer', bien: 'P1', type: 'faq', key: 'S', value: 'T', lisible_par_ia: false, ...(op === 'update' ? { id: 'a1' } : {}) }
    const r = await appeler({
      methode: 'POST', corps,
      repondre: (q) => (q.table === 'properties' ? { data: BIENS, error: null }
        : { data: null, error: { code: 'PGRST204', message: "Could not find the 'verifie_le' column of 'knowledge' in the schema cache" } })
    })
    assert.equal(r.statut, 503, op)
    assert.equal(r.charge.error, 'migration_absente', op)
  }
})

test('LE TEST QUI COMPTE : l aperçu de l éditeur passe par le remplaceur, avec le voyageur du BIEN', async () => {
  // La réservation désignée appartient à un AUTRE bien : on ne la prend pas, on
  // retombe sur le prochain séjour ACTIF de ce bien (l'annulée est sautée).
  const r = await appeler({
    methode: 'POST',
    corps: { action: 'apercu', bien: 'P1', resa: 'B-AUTRE', texte: 'Bonjour {prenom}, wifi {wifi_nom}' },
    repondre: (q) => {
      if (q.table === 'properties') return { data: BIENS, error: null }
      if (q.table === 'knowledge') return { data: [], error: null }
      if (q.table === 'bookings_snapshot') {
        if (filtre(q, 'booking_id')) return { data: [], error: null }
        return {
          data: [
            { booking_id: 'B1', snapshot: { status: 'cancelled', firstName: 'Annulé', arrival: jour(1), departure: jour(2) } },
            { booking_id: 'B2', snapshot: { status: 'confirmed', firstName: 'Lou', arrival: jour(4), departure: jour(6) } }
          ],
          error: null
        }
      }
      return { data: [], error: null }
    }
  })
  assert.equal(r.statut, 200)
  assert.equal(r.charge.apercu.texte, 'Bonjour Lou, wifi [WIFI NOM]')
  assert.deepEqual(r.charge.apercu.manquants, ['wifi_nom'])
  assert.equal(r.charge.voyageur.prenom, 'Lou')
  const resaLue = r.requetes.find(q => q.table === 'bookings_snapshot' && filtre(q, 'booking_id'))
  assert.equal(filtre(resaLue, 'property_id'), 'P1', 'la réservation est cherchée DANS ce bien')
  assert.equal(filtre(resaLue, 'user_id'), TITULAIRE, 'et DANS ce compte')
  const suivant = r.requetes.find(q => q.table === 'bookings_snapshot' && !filtre(q, 'booking_id'))
  assert.equal(suivant.filtres.find(f => f[0] === 'gte')[1], 'snapshot->>departure')
  assert.equal(filtre(suivant, 'user_id'), TITULAIRE)
  assert.equal(filtre(suivant, 'property_id'), 'P1')
  // Les faits de l'aperçu : ceux du compte ET du bien.
  const faitsLus = r.requetes.find(q => q.table === 'knowledge')
  assert.equal(filtre(faitsLus, 'user_id'), TITULAIRE)
  assert.equal(filtre(faitsLus, 'property_id'), 'P1')
  assert.equal(filtre(faitsLus, 'type'), 'fixed')
})

test('le jour de référence du « prochain voyageur » est celui de PARIS', () => {
  // 23:30 UTC le 31 décembre = déjà le 1er janvier à Paris.
  const { jourParis } = require('../api/ecran/connaissance')
  assert.equal(jourParis(new Date('2026-12-31T23:30:00Z')), '2027-01-01')
  assert.equal(jourParis(new Date('2026-07-01T21:30:00Z')), '2026-07-01')
})

test('LE TEST QUI COMPTE : l écran et l aperçu suivent la FICHE du logement quand la base se tait', async () => {
  // Les mêmes replis que l'envoi (lib/cron-messages.js) : adresse et horaires de
  // `properties`, lus dans la requête des biens — aucune requête de plus.
  const r = await appeler({
    query: { bien: 'P2' },
    repondre: base({ lignes: [{ id: 'a', type: 'faq', key: 'Accès', value: 'Au {adresse} dès {checkin}', verifie_le: null, lisible_par_ia: true }] })
  })
  assert.equal(r.statut, 200)
  assert.equal(r.requetes.length, 3, 'toujours trois requêtes')
  assert.match(r.requetes.find(q => q.table === 'properties').colonnes, /address, checkin_time, checkout_time/)
  const c = r.charge.reponses[0]
  assert.equal(c.apercu, 'Au 9 rue Fiche dès 16:00', 'ce que le voyageur recevra')
  assert.ok(c.segments.filter(s => s.cle).every(s => s.vide === false), 'pas d étiquette rouge : la fiche les remplit')
  const adresse = r.charge.faits.find(f => f.cle === 'adresse')
  assert.equal(adresse.aRemplir, false)
  assert.equal(adresse.repli, '9 rue Fiche')
})

test('les bornes de taille rendent un CODE stable, que l écran sait lire', async () => {
  const r = await appeler({ methode: 'POST', corps: { action: 'enregistrer', bien: 'P1', type: 'faq', key: 'S', value: 'x'.repeat(4001) }, repondre: base() })
  assert.equal(r.statut, 400)
  assert.equal(r.charge.error, 'trop_long')
  const f = await appeler({ methode: 'POST', corps: { action: 'enregistrer', bien: 'P1', type: 'fixed', key: 'adresse', value: 'x'.repeat(1001) }, repondre: base() })
  assert.equal(f.charge.error, 'trop_long')
})
