// tests/menages-reassignation.test.js
// api/menages.js POST — réassignation manuelle d'un ménage (spec §11.6).
//
// ⚠ TROIS DONNÉES VIENNENT DU CLIENT : le bien, le ménage et le prestataire
// visé. Aucune ne dit à quel compte elle appartient (REVIEW.md règle 11 : « une
// donnée client qui désigne une ressource ne se valide pas, elle ne s'utilise
// pas »). Un UUID de profil accepté sans être confronté au compte rattacherait
// le ménage d'un hôte au prestataire d'un autre — et les remarques de propreté
// suivraient, puisque l'attribution des avis se fait par cette assignation.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const PROD = '11111111-1111-4111-8111-111111111111'
const MEMBRE = '22222222-2222-4222-8222-222222222222'
const REGINA = 'aaaa1111-1111-4111-8111-111111111111'
const NOUVELLE = 'bbbb2222-2222-4222-8222-222222222222'

function preparer ({ user = PROD, profil = null, permissions = null, compteAttendu = PROD,
                     dateAttendue = LOIN, notifJette = false,
                     prestataire = { id: REGINA, first_name: 'Régina', active: true },
                     menage = { id: 'm1', provider_id: null, status: 'unassigned' },
                     liaison = { rang: 1, requires_ack: false }, erreurProfil = null, erreurLiaison = null } = {}) {
  const etat = { majs: [], journal: [], requetes: [], notifs: [] }
  const client = {
    auth: { getUser: async () => (user ? { data: { user: { id: user } }, error: null }
                                       : { data: null, error: { message: 'x' } }) },
    from (table) {
      const a = { table, f: {} }
      etat.requetes.push(a)
      const chain = {
        select () { return chain },
        eq (c, v) { a.f[c] = v; return chain },
        in () { return chain }, not () { return chain }, order () { return chain },
        neq () { return chain }, gte () { return chain }, lte () { return chain },
        limit () { return Promise.resolve({ data: [], error: null }) },
        update (row) { a.row = row; return { eq: (c, v) => { etat.majs.push({ table, row, id: v }); return Promise.resolve({ error: null }) } } },
        insert (rows) { etat.journal.push(...[].concat(rows)); return Promise.resolve({ error: null }) },
        maybeSingle () {
          if (table === 'profiles') {
            // La garde de droits lit `profiles` par member_user_id ; la
            // vérification du prestataire, par id. Deux usages, deux réponses —
            // les confondre rendrait le test aveugle à ce qu'il vérifie.
            if (a.f.id) {
              // ⚠ Rend le profil DEMANDE. Rendre toujours le meme masquait le
              // fait que la reponse porte bien la personne visee.
              const p = prestataire && (prestataire.id === a.f.id || prestataire.force)
                ? prestataire
                : (prestataire ? { ...prestataire, id: a.f.id,
                                   first_name: a.f.id === NOUVELLE ? 'Marie' : prestataire.first_name } : null)
              return Promise.resolve({ data: p, error: erreurProfil })
            }
            return Promise.resolve({ data: profil, error: null })
          }
          if (table === 'profile_permissions') return Promise.resolve({ data: permissions, error: null })
          if (table === 'menages') {
            // ⚠ LES FILTRES SONT HONORES. Le double rendait le menage quels que
            // soient les `.eq`, si bien que `.eq('user_id', …)` — la SEULE garde
            // inter-comptes de ce chemin, `refsDuPerimetre` rendant null pour un
            // titulaire — n'etait couverte par aucune assertion. Le retirer
            // laissait les 18 tests verts.
            const bon = a.f.user_id === compteAttendu &&
                        String(a.f.property_id) === '209413' &&
                        String(a.f.booking_id) === 'b1' &&
                        // ⚠ Recale sur la date REELLEMENT demandee. Accepter
                        // n'importe quelle chaine relachait le double : changer
                        // la date de lecture dans l'endpoint ne cassait plus
                        // rien (REVIEW.md regle 8).
                        a.f.departure_date === dateAttendue
            return Promise.resolve({ data: bon ? menage : null, error: null })
          }
          if (table === 'property_cleaning_providers') return Promise.resolve({ data: liaison, error: erreurLiaison })
          return Promise.resolve({ data: null, error: null })
        },
        then (ok, ko) { return Promise.resolve({ data: [], error: null }).then(ok, ko) }
      }
      return chain
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  // ⚠ Le cache est vide AVANT la pose du double : l'inverse annulerait le
  // remplacement, et `etat.notifs` resterait vide quoi qu'il arrive — le defaut
  // exact trouve hier sur le double d'alerte.
  for (const mod of ['../lib/require-permission', '../lib/permissions', '../api/menages',
                     '../lib/cleaning/notifier-prestataire']) {
    try { delete require.cache[require.resolve(mod)] } catch {}
  }
  const absNotif = require.resolve(path.join(__dirname, '..', 'lib/cleaning/notifier-prestataire.js'))
  const mnotif = new Module(absNotif)
  mnotif.exports = { notifierAssignation: async (opts) => {
    if (notifJette) throw new Error('brevo indisponible')
    etat.notifs.push(opts)
    return { sms: true, email: false }
  } }
  mnotif.loaded = true
  require.cache[absNotif] = mnotif
  return { handler: require('../api/menages'), etat }
}

function reponse () {
  const r = { code: null, body: null }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  return r
}

const post = (body, entetes = {}) => ({
  method: 'POST', query: {}, body,
  headers: { authorization: 'Bearer jeton', ...entetes }
})
// Un départ lointain : les tests qui ne parlent pas d'échéance ne doivent pas
// tomber sur « trop tard pour proposer ».
const LOIN = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
const CORPS = { property_id: '209413', booking_id: 'b1', departure_date: LOIN, provider_id: REGINA }

// ─── Les droits ────────────────────────────────────────────────────────────

test('sans session : 401', async () => {
  const { handler } = preparer({ user: null })
  const res = reponse()
  await handler(post(CORPS), res)
  assert.strictEqual(res.code, 401)
})

test('un membre `prestataires: none` ne peut PAS réassigner', async () => {
  // ⚠ Le droit est `prestataires`, pas `menages` : consulter le planning et
  // décider qui le fait ne sont pas la même chose.
  const { handler, etat } = preparer({
    user: MEMBRE,
    profil: { id: 'pr1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { prestataires: 'none', menages: 'write', property_scope: 'all' }
  })
  const res = reponse()
  await handler(post(CORPS, { 'x-compte': PROD }), res)
  assert.strictEqual(res.code, 403)
  assert.strictEqual(etat.majs.length, 0)
})

test('un membre `menages: write` seul ne suffit pas non plus', async () => {
  const { handler, etat } = preparer({
    user: MEMBRE,
    profil: { id: 'pr1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { prestataires: 'read', menages: 'write', property_scope: 'all' }
  })
  const res = reponse()
  await handler(post(CORPS, { 'x-compte': PROD }), res)
  assert.strictEqual(res.code, 403)
  assert.strictEqual(etat.majs.length, 0)
})

// ─── Le périmètre ──────────────────────────────────────────────────────────

test('un bien HORS PÉRIMÈTRE est refusé, pas silencieusement ignoré', async () => {
  // Sans ce contrôle, une référence passée dans le corps suffirait à réassigner
  // le ménage d'un bien que le membre n'a pas le droit de voir.
  const { handler, etat } = preparer({
    user: MEMBRE,
    profil: { id: 'pr1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { prestataires: 'write', property_scope: 'selected',
                   property_ids: ['uuid-a'], property_refs: ['999999'] }
  })
  const res = reponse()
  await handler(post(CORPS, { 'x-compte': PROD }), res)
  assert.strictEqual(res.code, 403)
  assert.strictEqual(etat.majs.length, 0)
})

// ─── Le prestataire visé ───────────────────────────────────────────────────

test('le prestataire est vérifié SUR LE COMPTE, pas cru sur parole', async () => {
  // ⚠ La faute que ce test empêche : accepter un UUID de profil sans le
  // confronter au compte rattacherait le ménage d'un hôte au prestataire d'un
  // autre, et les remarques de propreté suivraient.
  const { handler, etat } = preparer({ prestataire: null })
  const res = reponse()
  await handler(post(CORPS), res)
  assert.strictEqual(res.code, 400)
  assert.strictEqual(etat.majs.length, 0)
})

test('la vérification du prestataire filtre bien le compte ET le mode d\'accès', async () => {
  const { handler, etat } = preparer({})
  await handler(post(CORPS), reponse())
  const q = etat.requetes.find(r => r.table === 'profiles' && r.f.id)
  assert.strictEqual(q.f.account_user_id, PROD, 'le compte doit être filtré')
  assert.strictEqual(q.f.access_mode, 'lien', 'un membre du compte n\'est pas un prestataire')
})

test('un prestataire DÉSACTIVÉ est refusé', async () => {
  const { handler, etat } = preparer({ prestataire: { id: REGINA, first_name: 'Régina', active: false } })
  const res = reponse()
  await handler(post(CORPS), res)
  assert.strictEqual(res.code, 400)
  assert.strictEqual(etat.majs.length, 0)
})

test('PANNE de vérification : 503, jamais une assignation à l\'aveugle', async () => {
  const { handler, etat } = preparer({ erreurProfil: { message: 'timeout' } })
  const res = reponse()
  await handler(post(CORPS), res)
  assert.strictEqual(res.code, 503)
  assert.strictEqual(etat.majs.length, 0)
})

// ─── La règle d'engagement s'applique aussi à la main ──────────────────────

test('réassigner vers quelqu\'un D\'OFFICE l\'engage tout de suite', async () => {
  const { handler, etat } = preparer({ liaison: { rang: 1, requires_ack: false } })
  const res = reponse()
  await handler(post(CORPS), res)
  assert.strictEqual(res.body.status, 'accepted')
  assert.strictEqual(etat.majs[0].row.status, 'accepted')
  assert.ok(etat.majs[0].row.accepted_at)
})

test('proposer à un SUPPLÉANT ne retire RIEN à la porteuse', async () => {
  // ⚠ LA RÈGLE DU 4 SEPTEMBRE. Écraser `provider_id` faisait sortir le ménage du
  // planning de la référente pendant tout le temps de la réflexion : un logement
  // pouvait n'être couvert par personne sans que personne ne le sache.
  const { handler, etat } = preparer({
    liaison: { rang: 2, requires_ack: true },
    menage: { id: 'm1', provider_id: REGINA, status: 'accepted' }
  })
  const res = reponse()
  await handler(post({ ...CORPS, provider_id: NOUVELLE }), res)
  assert.strictEqual(etat.majs[0].row.offered_to, NOUVELLE, 'la proposition est posée')
  assert.ok(etat.majs[0].row.offer_expires_at, 'avec son échéance')
  assert.strictEqual(etat.majs[0].row.provider_id, undefined, 'le porteur n\'est PAS touché')
  assert.strictEqual(etat.majs[0].row.status, undefined, 'ni le statut')
  assert.strictEqual(res.body.provider_id, REGINA, 'la réponse dit qui le porte toujours')
})

test('proposer À LA DERNIÈRE MINUTE reste possible', async () => {
  // ⚠ Décision du 4 septembre : on propose à tout moment. Le plancher de deux
  // heures avait été posé puis retiré — les changements de dernière minute font
  // partie du métier, et refuser la proposition obligeait l'hôte à engager
  // quelqu'un sans son accord alors qu'un simple oui aurait suffi.
  const demain = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
  const { handler, etat } = preparer({ liaison: { rang: 2, requires_ack: true }, dateAttendue: demain })
  const res = reponse()
  await handler(post({ ...CORPS, provider_id: NOUVELLE, departure_date: demain }), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(etat.majs[0].row.offered_to, NOUVELLE)
  // L'échéance existe toujours : une proposition sans terme resterait en suspens.
  assert.ok(etat.majs[0].row.offer_expires_at)
  assert.ok(Date.parse(etat.majs[0].row.offer_expires_at) > Date.now())
})

test('un prestataire sans liaison sur ce bien reçoit une PROPOSITION', async () => {
  // Solliciter quelqu'un qui n'intervient pas d'habitude est légitime — mais ça
  // ne fait pas de lui le référent, et ça ne retire rien à la porteuse.
  const { handler, etat } = preparer({ liaison: null })
  const res = reponse()
  await handler(post(CORPS), res)
  assert.strictEqual(etat.majs[0].row.offered_to, REGINA)
  assert.strictEqual(etat.majs[0].row.provider_id, undefined)
})

test('réassigner vers la PORTEUSE efface une proposition en cours', async () => {
  // L'hôte a tranché : la sollicitation n'a plus lieu d'être.
  const { handler, etat } = preparer({ liaison: { rang: 1, requires_ack: false } })
  await handler(post(CORPS), reponse())
  assert.strictEqual(etat.majs[0].row.offered_to, null)
  assert.strictEqual(etat.majs[0].row.offer_expires_at, null)
})

test('l\'assignation manuelle VERROUILLE le ménage', async () => {
  const { handler, etat } = preparer({})
  await handler(post(CORPS), reponse())
  assert.strictEqual(etat.majs[0].row.assigned_by, 'manual')
})

test('désassigner est possible, ET le geste reste VERROUILLÉ', async () => {
  // ⚠ Remettre `assigned_by: null` rendait la décision invisible au writer,
  // dont la garde teste `assigned_by === 'manual'` : le cron rendait le ménage
  // à la référente dans les cinq minutes, avec au journal un motif faux
  // (« prestataire lié après la création »). Laisser un ménage sans personne
  // EST une décision de l'hôte, et elle se verrouille comme les autres.
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler(post({ ...CORPS, provider_id: null }), res)
  assert.strictEqual(res.body.status, 'unassigned')
  assert.strictEqual(etat.majs[0].row.provider_id, null)
  assert.strictEqual(etat.majs[0].row.assigned_by, 'manual')
})

// ─── Le journal ────────────────────────────────────────────────────────────

test('chaque réassignation écrit UNE ligne de journal, avec l\'avant et l\'après', async () => {
  const { handler, etat } = preparer({ menage: { id: 'm1', provider_id: NOUVELLE, status: 'accepted' } })
  await handler(post(CORPS), reponse())
  assert.strictEqual(etat.journal.length, 1)
  assert.strictEqual(etat.journal[0].event, 'manual_assign')
  assert.strictEqual(etat.journal[0].from_provider_id, NOUVELLE)
  assert.strictEqual(etat.journal[0].to_provider_id, REGINA)
  assert.strictEqual(etat.journal[0].actor, 'host')
})

// ─── Les entrées mal formées ───────────────────────────────────────────────

test('champs manquants : 400, aucune écriture', async () => {
  for (const corps of [{}, { property_id: '209413' }, { property_id: '209413', booking_id: 'b1' }]) {
    const { handler, etat } = preparer({})
    const res = reponse()
    await handler(post(corps), res)
    assert.strictEqual(res.code, 400, JSON.stringify(corps))
    assert.strictEqual(etat.majs.length, 0)
  }
})

test('une date qui n\'est pas une date est refusée', async () => {
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler(post({ ...CORPS, departure_date: '05/09/2026' }), res)
  assert.strictEqual(res.code, 400)
  assert.strictEqual(etat.majs.length, 0)
})

test('un ménage introuvable rend 404, pas une création implicite', async () => {
  // Le writer est le seul à créer des ménages : une réassignation ne doit pas
  // en fabriquer un que la couche sync ne connaît pas.
  const { handler, etat } = preparer({ menage: null })
  const res = reponse()
  await handler(post(CORPS), res)
  assert.strictEqual(res.code, 404)
  assert.strictEqual(etat.majs.length, 0)
})

test('le ménage est cherché SUR LE COMPTE de l\'appelant', async () => {
  // ⚠ `refsDuPerimetre` rend `null` pour un titulaire : le contrôle de périmètre
  // ne s'applique pas à lui, et `.eq('user_id', …)` est alors la SEULE garde
  // inter-comptes de cet endpoint. Le double honore désormais les filtres, si
  // bien que retirer cette ligne fait tomber ce test.
  const { handler, etat } = preparer({ compteAttendu: 'un-autre-compte' })
  const res = reponse()
  await handler(post(CORPS), res)
  assert.strictEqual(res.code, 404, 'un ménage d\'un autre compte doit rester introuvable')
  assert.strictEqual(etat.majs.length, 0)
})

test('un ménage ANNULÉ ne se réassigne pas', async () => {
  // Le prochain cycle du cron le ré-annulerait : l'hôte verrait son geste défait
  // sans un mot.
  const { handler, etat } = preparer({ menage: { id: 'm1', provider_id: null, status: 'cancelled' } })
  const res = reponse()
  await handler(post(CORPS), res)
  assert.strictEqual(res.code, 409)
  assert.strictEqual(etat.majs.length, 0)
})

test('PANNE de lecture de la liaison : 503, jamais une porteuse dégradée', async () => {
  // Ignorer cette erreur transformait silencieusement une personne d'office en
  // suppléante : elle recevait une offre à confirmer pour un ménage qui aurait
  // dû lui être attribué d'office.
  const { handler, etat } = preparer({ liaison: null, erreurLiaison: { message: 'timeout' } })
  const res = reponse()
  await handler(post(CORPS), res)
  assert.strictEqual(res.code, 503)
  assert.strictEqual(etat.majs.length, 0)
})

test('re-choisir la PORTEUSE retire la proposition, sans la déloger', async () => {
  // ⚠ LE GESTE QUI MANQUAIT. Aucune action ne permettait d'annuler une
  // proposition en gardant la porteuse : « — personne — » retirait AUSSI la
  // porteuse, l'inverse de l'intention. Et si elle n'était pas rang 1, la
  // resélectionner partait sur la branche « proposer » et écrivait
  // `offered_to = provider_id` — ce que la base refuse (500).
  const { handler, etat } = preparer({
    menage: { id: 'm1', provider_id: REGINA, offered_to: NOUVELLE, status: 'accepted' }
  })
  const res = reponse()
  await handler(post(CORPS), res)   // CORPS vise REGINA, déjà porteuse
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.retiree, true)
  assert.strictEqual(etat.majs[0].row.offered_to, null, 'la proposition tombe')
  assert.strictEqual(etat.majs[0].row.provider_id, undefined, 'la porteuse ne bouge pas')
  assert.strictEqual(etat.journal[0].event, 'offer_withdrawn')
})

// ─── Les deux gestes : proposer, ou assigner directement ───────────────────
// ⚠ L'ASSIGNATION DIRECTE EST LE GESTE D'URGENCE. Quelqu'un se décommande à
// deux heures du départ : il faut que le ménage soit fait, et attendre une
// confirmation n'est plus possible. Elle n'a donc AUCUNE limite de délai, et la
// personne est notifiée — sans quoi le geste serait muet.
// La proposition reste le geste par défaut : engager quelqu'un sans son accord
// doit rester un choix explicite.

test('mode `assigner` : transfert IMMÉDIAT, même vers une suppléante', async () => {
  const { handler, etat } = preparer({ liaison: { rang: 2, requires_ack: true } })
  const res = reponse()
  await handler(post({ ...CORPS, provider_id: NOUVELLE, mode: 'assigner' }), res)
  assert.strictEqual(res.body.status, 'accepted')
  assert.strictEqual(etat.majs[0].row.provider_id, NOUVELLE, 'elle porte le ménage tout de suite')
  assert.strictEqual(etat.majs[0].row.offered_to, null, 'aucune proposition en attente')
  assert.ok(etat.majs[0].row.accepted_at)
})

test('mode `assigner` : AUCUNE limite de délai', async () => {
  // ⚠ C'est tout l'objet du geste. La proposition, elle, garde son échéance.
  const hier = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  const { handler, etat } = preparer({ liaison: { rang: 2, requires_ack: true }, dateAttendue: hier })
  const res = reponse()
  await handler(post({ ...CORPS, provider_id: NOUVELLE, departure_date: hier, mode: 'assigner' }), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(etat.majs[0].row.provider_id, NOUVELLE)
})

test('le DÉFAUT reste `proposer` : on n\'engage personne par accident', async () => {
  // Un corps sans `mode` ne doit pas transférer : engager quelqu'un sans son
  // accord doit rester un choix explicite.
  const { handler, etat } = preparer({ liaison: { rang: 2, requires_ack: true } })
  await handler(post({ ...CORPS, provider_id: NOUVELLE }), reponse())
  assert.strictEqual(etat.majs[0].row.offered_to, NOUVELLE)
  assert.strictEqual(etat.majs[0].row.provider_id, undefined, 'le porteur ne bouge pas')
})

test('un mode inconnu retombe sur `proposer`, jamais sur `assigner`', async () => {
  // Le repli sûr est celui qui n'engage personne.
  for (const mode of ['ASSIGNER', 'forcer', 42, null]) {
    const { handler, etat } = preparer({ liaison: { rang: 2, requires_ack: true } })
    await handler(post({ ...CORPS, provider_id: NOUVELLE, mode }), reponse())
    assert.strictEqual(etat.majs[0].row.offered_to, NOUVELLE, String(mode))
  }
})

test('`requires_ack = false` est assignée d\'office même en mode `proposer`', async () => {
  // C'est le sens de `requires_ack = false` : on ne lui PROPOSE pas ce qui lui
  // revient d'office. Le rang, lui, ne sert plus qu'à départager et à remplacer.
  const { handler, etat } = preparer({ liaison: { rang: 1, requires_ack: false } })
  await handler(post({ ...CORPS, mode: 'proposer' }), reponse())
  assert.strictEqual(etat.majs[0].row.provider_id, REGINA)
  assert.strictEqual(etat.majs[0].row.offered_to, null)
})

test('une assignation directe est NOTIFIÉE, et la réponse dit ce qui est parti', async () => {
  // ⚠ Le ménage apparaît aussitôt dans sa PWA — mais personne ne regarde sa PWA
  // toutes les cinq minutes. Sans notification, le geste d'urgence est muet, et
  // le logement n'est pas préparé alors que l'hôte croit l'avoir confié.
  // ⚠ Et on dit ce qui est RÉELLEMENT parti : promettre un SMS qui n'a pas pu
  // partir est pire que ne rien promettre.
  const { handler, etat } = preparer({ liaison: { rang: 2, requires_ack: true } })
  const res = reponse()
  await handler(post({ ...CORPS, provider_id: NOUVELLE, mode: 'assigner' }), res)
  assert.strictEqual(etat.notifs.length, 1, 'la personne assignée est prévenue')
  assert.strictEqual(etat.notifs[0].providerId, NOUVELLE)
  assert.ok(res.body.notifiee, 'la réponse porte ce qui est parti')
})

test('une PROPOSITION ne notifie pas par ce canal', async () => {
  // Elle n'engage personne : c'est la PWA qui l'annonce, avec son délai.
  const { handler, etat } = preparer({ liaison: { rang: 2, requires_ack: true } })
  await handler(post({ ...CORPS, provider_id: NOUVELLE, mode: 'proposer' }), reponse())
  assert.strictEqual(etat.notifs.length, 0)
})

test('une notification qui ÉCHOUE ne défait pas l\'assignation', async () => {
  // ⚠ L'assignation est déjà écrite : un envoi raté ne doit ni la défaire, ni
  // faire échouer la requête. La vérité reste la base ; le SMS est un rappel.
  const { handler, etat } = preparer({ liaison: { rang: 2, requires_ack: true }, notifJette: true })
  const res = reponse()
  await handler(post({ ...CORPS, provider_id: NOUVELLE, mode: 'assigner' }), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(etat.majs[0].row.provider_id, NOUVELLE)
})
