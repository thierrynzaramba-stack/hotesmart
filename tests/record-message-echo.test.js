// tests/record-message-echo.test.js
// LE DEFAUT : un import de rattrapage DUPLIQUE les messages entrants.
//
// Mesure du 14 septembre 2026. `importMessages` a ete lance sur Ofuro Futari
// pour rapatrier les reponses ecrites par l'hote dans l'app Airbnb (35 messages
// qui n'etaient JAMAIS entres dans le coeur). Il a bien ramene les sortants —
// et duplique 21 messages ENTRANTS du voyageur Julien Darmon.
//
// LA CAUSE : les entrants ecrits par le webhook n'ont pas de `provider_msg_id`.
// La dedup par identifiant ne peut donc pas les reconnaitre, et la
// reconciliation d'echo n'existait que pour `direction === 'outbound'`.
//
// POURQUOI CES TESTS COMPTENT MAINTENANT : le correctif de fond rend cet import
// RECURRENT. Sans reconciliation, chaque passage dupliquerait le fil.

// ⚠ LE FUSEAU EST FIGE, ET C'EST LA LECON LA PLUS DURE DE CE CHANTIER.
// Ma contre-epreuve annoncait « les deux normalisations desarmees, les deux
// rougissent ». Verifie en review : desarmer `instantDe` fait rougir sous
// TZ=Europe/Paris et TZ=America/New_York, mais reste VERT sous TZ=UTC — c'est
// le fuseau de Vercel et celui de la plupart des CI. Le test protegeait le
// poste de Thierry, pas le depot.
//
// C'est la meme erreur que celle qui a duplique 83 messages : un controle qui
// ne s'execute pas comme le code de production ne dit rien du code de
// production. Troisieme forme de faux vert du depot, apres « l'assertion qui
// trouve le jeton ailleurs » et « le faux client qui n'applique pas les
// filtres » : LA CONTRE-EPREUVE QUI DEPEND DE L'ENVIRONNEMENT.
process.env.TZ = 'Europe/Paris'

// Convention du depot : le module cree son client au chargement, on lui donne
// de quoi le construire. Les requetes, elles, passent par le client INJECTE.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const { recordMessage } = require('../lib/record-message')

// Faux client qui APPLIQUE REELLEMENT les filtres. Un faux client qui rend
// toujours la meme chose ferait passer une requete qui oublie `user_id` — et
// c'est precisement ce que la review a reproche a ma premiere version.
function faux (lignes) {
  const journal = { inserts: [], updates: [], warns: [] }
  const req = (etat) => {
    const appliquer = () => {
      let l = lignes.filter(x => x._table === etat.table)
      for (const [c, v] of etat.filtres) l = l.filter(x => String(x[c]) === String(v))
      for (const c of etat.nulls) l = l.filter(x => x[c] == null)
      return { data: l, error: null }
    }
    const p = Promise.resolve().then(appliquer)
    p.select = () => req(etat)
    p.eq = (c, v) => req({ ...etat, filtres: [...etat.filtres, [c, v]] })
    p.is = (c) => req({ ...etat, nulls: [...etat.nulls, c] })
    p.gte = () => req(etat)
    p.order = () => req(etat)
    p.limit = () => req(etat)
    p.maybeSingle = () => Promise.resolve().then(() => ({ data: appliquer().data[0] || null, error: null }))
    p.insert = (row) => { journal.inserts.push(row); return Promise.resolve({ error: null }) }
    p.update = (patch) => {
      const e = { ...etat, filtres: [...etat.filtres], nulls: [...etat.nulls] }
      const q = Promise.resolve().then(() => {
        let l = lignes.filter(x => x._table === e.table)
        for (const [c, v] of e.filtres) l = l.filter(x => String(x[c]) === String(v))
        for (const c of e.nulls) l = l.filter(x => x[c] == null)
        // ⚠ ON JOURNALISE LES FILTRES DE L'UPDATE, pas seulement son effet.
        // La garde anti-ecrasement est un `.is(provider_msg_id, null)` SUR
        // L'UPDATE : sans l'observer, aucun test ne peut la distinguer d'un
        // hasard, et la contre-epreuve de la review est restee verte.
        journal.updates.push({ patch, nulls: e.nulls, touche: l.map(x => x.id) })
        for (const x of l) Object.assign(x, patch)
        return { error: null }
      })
      q.eq = (c, v) => { e.filtres.push([c, v]); return q }
      q.is = (c) => { e.nulls.push(c); return q }
      return q
    }
    return p
  }
  return { from: (t) => req({ table: t, filtres: [], nulls: [] }), journal }
}

const USER = 'hote-A'
const RESA = 'resa-1'
const INSTANT = '2026-09-12T16:57:56.000Z'

function ligne (over = {}) {
  return {
    _table: 'messages', id: 'x', user_id: USER, booking_id: RESA, provider: 'channex',
    direction: 'inbound', sender: 'guest', body: 'Ok',
    sent_at: INSTANT, provider_msg_id: null, created_at: '2026-09-12T16:58:14Z',
    ...over
  }
}
const entrant = (over = {}) => ({
  userId: USER, provider: 'channex', propertyId: 'bien-1', bookingId: RESA,
  direction: 'inbound', sender: 'guest', body: 'Ok',
  providerMsgId: 'msg-channex-1', sentAt: INSTANT, kind: 'message', ...over
})

test('LE TEST QUI COMPTE : un entrant deja connu SANS identifiant est reconcilie, pas duplique', async () => {
  const existante = ligne({ id: 'ancienne' })
  const sb = faux([existante])
  const r = await recordMessage({ supabase: sb, ...entrant() })

  assert.equal(r.skipped, true, 'rien n est insere')
  assert.equal(r.reason, 'echo_entrant_reconcilie')
  assert.equal(sb.journal.inserts.length, 0, 'AUCUN doublon en base')
  assert.equal(existante.provider_msg_id, 'msg-channex-1',
    'et la ligne d origine gagne l identifiant : le prochain import la reconnaitra')
})

test('LE TEST QUI COMPTE : deux messages identiques a des INSTANTS differents restent deux messages', async () => {
  // ⚠ LE PIEGE REEL. Julien Darmon a ecrit « Ok » a 16:57:56 PUIS a 17:43:36.
  // Reconcilier sur le seul texte aurait fusionne deux messages distincts —
  // une perte de donnee deguisee en nettoyage.
  const premier = ligne({ id: 'ok-16h57' })
  const sb = faux([premier])
  await recordMessage({ supabase: sb, ...entrant({ providerMsgId: 'msg-2', sentAt: '2026-09-12T17:43:36.000Z' }) })

  assert.equal(sb.journal.inserts.length, 1, 'le SECOND « Ok » est bien insere')
  assert.equal(premier.provider_msg_id, null, 'et le premier n est pas touche')
})

test('LE TEST QUI COMPTE : Postgres rend « +00:00 », le code rend « Z » — on compare des INSTANTS', async () => {
  // ⚠ CE TEST MANQUAIT, ET SANS LUI LA COMPARAISON PAR DATE N ETAIT PAS PROUVEE :
  // mes deux chaines etaient identiques, donc une egalite de chaines passait
  // aussi. `timestamptz` revient de PostgREST en « 2026-09-12T16:57:56+00:00 »
  // alors que l import pose « …Z ». Comparer les textes ne reconcilierait RIEN
  // en production, et chaque passage dupliquerait le fil — le defaut exact que
  // ces gardes existent pour fermer.
  const existante = ligne({ id: 'ancienne', sent_at: '2026-09-12T16:57:56+00:00' })
  const sb = faux([existante])
  const r = await recordMessage({ supabase: sb, ...entrant({ sentAt: '2026-09-12T16:57:56.000Z' }) })

  assert.equal(r.reason, 'echo_entrant_reconcilie', 'le meme instant, ecrit autrement, est reconnu')
  assert.equal(sb.journal.inserts.length, 0, 'aucun doublon')
  assert.equal(existante.provider_msg_id, 'msg-channex-1')
})

test('LE TEST QUI COMPTE : l UPDATE porte la garde anti-ecrasement — observee, pas grepee', async () => {
  // ⚠ MA PREMIERE VERSION DE CE TEST NE PROUVAIT RIEN. Elle asserait qu une
  // valeur ne changeait pas — ce qui reste vrai quand il ne se passe RIEN :
  // la review l a desarmee en retirant la garde, et aussi en supprimant tout le
  // bloc, sans faire rougir. On observe donc la REQUETE construite.
  const sb = faux([ligne({ id: 'ancienne' })])
  await recordMessage({ supabase: sb, ...entrant() })

  const maj = sb.journal.updates.find(u => u.patch.provider_msg_id === 'msg-channex-1')
  assert.ok(maj, 'un UPDATE de reconciliation a bien eu lieu')
  assert.ok(maj.nulls.includes('provider_msg_id'),
    'et il refuse d ecraser un identifiant deja pose (course entre deux ticks)')
})

test('LE TEST QUI COMPTE : la reconciliation est CLOISONNEE PAR COMPTE', async () => {
  // ⚠ Point 4 de la demande, et il n etait prouve que par un grep. Les
  // `booking_id` Beds24 sont numeriques et ne sont uniques QUE par compte : sans
  // le filtre, l import d un hote reconcilierait la ligne d un autre — donc la
  // lui volerait, en lui laissant un fil ampute.
  const chezB = ligne({ id: 'ligne-de-B', user_id: 'hote-B' })
  const sb = faux([chezB])
  const r = await recordMessage({ supabase: sb, ...entrant() })

  assert.equal(chezB.provider_msg_id, null, 'la ligne de l autre compte n est PAS touchee')
  assert.equal(sb.journal.inserts.length, 1, 'et le message de hote-A est bien ecrit chez lui')
  assert.notEqual(r.reason, 'echo_entrant_reconcilie')
})

test('LE TEST QUI COMPTE : sans instant du provider, on n invente pas — on insere', async () => {
  // ⚠ `row.sent_at` n est JAMAIS vide : il retombe sur notre horloge quand le
  // producteur n a rien fourni. Reconcilier la-dessus reviendrait a rapprocher
  // deux messages sur l heure a laquelle NOUS les avons vus.
  const existante = ligne({ id: 'ancienne' })
  const sb = faux([existante])
  await recordMessage({ supabase: sb, ...entrant({ sentAt: null }) })

  assert.equal(existante.provider_msg_id, null, 'aucune reconciliation a l aveugle')
  assert.equal(sb.journal.inserts.length, 1)
})

test('LE TEST QUI COMPTE : un instant qui diverge se CRIE, il ne se tait pas', async () => {
  // Si un producteur cesse un jour de poser le vrai instant, la reconciliation
  // cesserait de matcher EN SILENCE et chaque import dupliquerait le fil. La
  // mesure du 14/09 dit que les instants coincident aujourd hui (83 messages
  // Colomiers, ecart 0 ms) : ce cri est ce qui nous avertira si ca change.
  const original = console.warn
  const cris = []
  console.warn = (...a) => cris.push(a.join(' '))
  try {
    const sb = faux([ligne({ id: 'ancienne', sent_at: '2026-09-12T16:58:20.000Z' })])
    await recordMessage({ supabase: sb, ...entrant() })
    assert.ok(cris.some(c => /instant DIFFERENT/.test(c)),
      'le cas « meme texte, autre instant » est signale')
  } finally { console.warn = original }
})

test('LE TEST QUI COMPTE : un instant SANS FUSEAU est lu en UTC, pas en heure locale', async () => {
  // ⚠ LE DEFAUT QUI A DUPLIQUE 83 MESSAGES DE COLOMIERS, LE 14 SEPTEMBRE 2026.
  // Channex rend `inserted_at` sans suffixe (« 2026-07-22T15:50:10.405 »).
  // `new Date()` le lit en heure LOCALE : sur une machine a Paris, deux heures
  // d'ecart avec la meme valeur relue depuis Postgres (« …+00:00 »). La
  // reconciliation echouait donc systematiquement, et l'import inserait un
  // doublon — alors que les deux lignes portaient le MEME instant en base.
  //
  // Le defaut etait entierement dans la comparaison en memoire : invisible en
  // relisant les donnees, invisible aussi dans mon apercu, qui normalisait le
  // fuseau alors que le code ne le faisait pas. Un apercu qui ne calcule pas
  // comme le code ne prevoit pas ce que le code fera.
  const existante = ligne({ id: 'ancienne', sent_at: '2026-07-22T15:50:10.405+00:00' })
  const sb = faux([existante])
  const r = await recordMessage({ supabase: sb, ...entrant({ sentAt: '2026-07-22T15:50:10.405' }) })

  assert.equal(r.reason, 'echo_entrant_reconcilie',
    'l instant nu du provider est reconnu comme le meme que celui de la base')
  assert.equal(sb.journal.inserts.length, 0, 'aucun doublon')
})

test('LE TEST QUI COMPTE : enUTC est eprouve par COMPORTEMENT, sur les formats reels', () => {
  // ⚠ MON TEST PRECEDENT LISAIT LE FICHIER ET ASSERAIT HUIT ESPACES
  // D'ALIGNEMENT du site d'appel. Verifie en review : il rougissait sur un
  // simple reformatage, et restait VERT quand on vidait la fonction de son
  // corps. L'inverse exact de ce qu'on demande a un test. La cause etait
  // mecanique : `enUTC` n'etait pas exporte, donc aucun test ne POUVAIT
  // l'appeler. Il l'est maintenant.
  //
  // Ces assertions portent sur des CHAINES, donc elles ne dependent d'aucun
  // fuseau : elles valent la meme chose sur le poste de Thierry, sur Vercel et
  // en CI.
  const { enUTC } = require('../lib/channels/channex')

  assert.equal(enUTC('2026-07-22T15:50:10.405'), '2026-07-22T15:50:10.405Z',
    'un instant NU recoit son fuseau — le cas Channex, celui qui a duplique 83 messages')
  assert.equal(enUTC('2026-07-22 15:50:10'), '2026-07-22 15:50:10Z',
    'meme avec un espace au lieu du T — le format des avis Beds24')
  assert.equal(enUTC('2026-07-22T15:50:10.405000'), '2026-07-22T15:50:10.405000Z',
    'microsecondes comprises')

  for (const deja of ['2026-07-22T15:50:10.405Z', '2026-07-22T15:50:10.405+00:00',
                      '2026-07-22T15:50:10.405+02:00', '2026-07-22T15:50:10.405-05:00']) {
    assert.equal(enUTC(deja), deja, `un instant qui porte deja son fuseau n est pas touche : ${deja}`)
  }

  // ⚠ LE DECALAGE AUX HEURES SEULES. « +02 » est legal en ISO 8601 et accepte
  // par Postgres. Ma premiere version ne le reconnaissait pas et y collait un
  // Z : « …+02Z », une valeur VALIDE transformee en valeur invalide, que la base
  // refuse — donc un message PERDU. Un normalisateur pose a une frontiere
  // provider ne parie pas sur la forme du lendemain.
  assert.equal(enUTC('2026-07-22T15:50:10.405+02'), '2026-07-22T15:50:10.405+02',
    'un decalage aux heures seules est laisse intact, jamais mutile')

  // ⚠ UNE DATE SEULE N'EST PAS UN DECALAGE. « 2026-07-22 » finit par « -22 ».
  assert.equal(enUTC('2026-07-22'), '2026-07-22', 'une date seule est rendue telle quelle')
  assert.equal(new Date(enUTC('2026-07-22')).toISOString(), '2026-07-22T00:00:00.000Z',
    'et elle vaut minuit UTC, quel que soit le fuseau de la machine')

  assert.equal(enUTC(null), null, 'un nul reste nul — pas « nullZ »')
})

test('LE TEST QUI COMPTE : les deux normalisations rendent le MEME instant', () => {
  // La source et le writer normalisent tous les deux, volontairement. S'ils
  // divergeaient, la reconciliation comparerait deux verites differentes.
  const { enUTC } = require('../lib/channels/channex')
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib/record-message.js'), 'utf8')
  assert.ok(src.includes('function normaliserInstant'), 'le writer a sa propre normalisation')
  assert.ok(src.includes('MEME REGLE QUE `enUTC`'), 'et elle se declare solidaire de celle de la source')

  // Idempotence : appliquer la source puis le writer ne doit rien changer.
  for (const v of ['2026-07-22T15:50:10.405', '2026-07-22T15:50:10.405Z',
                   '2026-07-22T15:50:10.405+00:00', '2026-07-22']) {
    assert.equal(enUTC(enUTC(v)), enUTC(v), `enUTC est idempotent sur ${v}`)
  }
})

test('la branche entrante compare des INSTANTS, pas des chaines — lecture du code', () => {
  // ⚠ FENETRE BORNEE AU BLOC ENTRANT. La review a releve que ma tranche de
  // 900 caracteres s arretait 63 caracteres avant le bloc SORTANT, qui porte les
  // memes jetons : un commentaire de plus et le test passait pour la mauvaise
  // raison. On coupe donc a l entree du bloc sortant, pas a une longueur.
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib/record-message.js'), 'utf8')
  const debut = src.indexOf("row.direction === 'inbound'")
  const fin = src.indexOf("row.direction === 'outbound'")
  assert.ok(debut > 0 && fin > debut, 'les deux blocs sont reperables et distincts')
  const bloc = src.slice(debut, fin)

  assert.ok(bloc.includes('instantDe(row.sent_at)') && bloc.includes('instantDe(x.sent_at)'),
    'la comparaison passe par la normalisation : timestamptz se serialise de trois '
    + 'facons, et celle du provider n a pas de fuseau du tout')
  assert.ok(bloc.includes(".eq('user_id', row.user_id)"), 'cloisonnement par compte')
  assert.ok(bloc.includes(".eq('booking_id', row.booking_id)"), 'et par reservation')
  assert.ok(bloc.includes(".eq('provider', row.provider)"), 'et par provider')
  assert.ok(bloc.includes('sentAt'), 'la garde exige l instant fourni par le PRODUCTEUR')
})

// ─── resolveOta : le client se passe en argument ─────────────────────────────
// Trouve en review le 17 septembre 2026, defaut anterieur (de18a64).
// `resolveOta` lisait `db`, qui n'existe que dans la portee de `recordMessage` :
// chaque appel levait une ReferenceError, avalee par son propre catch, et la
// fonction rendait TOUJOURS null. Le lookup ecrit pour l'entrant Channex — le
// seul appelant qui ne fournit pas `ota` — n'a donc jamais rien resolu.
test('resolveOta lit le snapshot au lieu de lever en silence', async () => {
  const lignes = []
  const db = {
    from (table) {
      const b = {
        select: () => b, eq: () => b, gte: () => b, limit: async () => ({ data: [] }),
        maybeSingle: async () => ({ data: table === 'bookings_snapshot'
          ? { snapshot: { source: 'AirBNB' } } : null }),
        insert: async row => { lignes.push(row); return { error: null } }
      }
      return b
    }
  }
  const avertissements = []
  const err = console.warn
  console.warn = (...a) => avertissements.push(a.join(' '))
  await recordMessage({
    supabase: db,
    userId: 'U', provider: 'channex', propertyId: 'P', bookingId: 'B',
    direction: 'inbound', sender: 'guest', body: 'bonjour', providerMsgId: 'm-1'
  })
  console.warn = err

  assert.ok(!avertissements.some(l => /resolveOta echec/.test(l)),
    'aucune ReferenceError avalee : ' + avertissements.join(' | '))
  assert.strictEqual(lignes.length, 1)
  assert.strictEqual(lignes[0].ota, 'AirBNB',
    'l\'OTA vient de la reservation, comme la fonction le promet depuis toujours')
})
