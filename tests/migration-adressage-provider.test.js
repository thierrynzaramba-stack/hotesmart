// tests/migration-adressage-provider.test.js
// LES DEUX SENS DE L'IDENTIFIANT, PENDANT UNE MIGRATION.
//
// Un bien en cours de bascule porte DEUX identifiants : sa cle source (Beds24)
// et sa propriete cible (Channex, qui porte les canaux). Les confondre casse le
// chantier dans les deux sens :
//   coeur -> provider : adresser Channex avec « 209413 » rend HTTP 422 (mesure
//     du 9 septembre 2026), donc toute la phase 1 du plan est inexecutable ;
//   provider -> coeur : une reservation arrivant sur la propriete cible ne
//     trouve AUCUN bien, et se perd en silence — alors que « une reservation OTA
//     qui n'arrive pas dans le coeur sous 30 min » est un critere de rollback.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test'
process.env.CHANNEL_BASE_URL = process.env.CHANNEL_BASE_URL || 'https://api.exemple'
process.env.CHANNEL_API_KEY = process.env.CHANNEL_API_KEY || 'cle-test'

const { trouverBienParIdProvider } = require('../lib/bien-du-provider')
const { proprieteChezLeProvider } = require('../lib/rate-sync')

const lire = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

const EN_MIGRATION = {
  id: 'uuid-bulle', user_id: 'uuid-hote', provider: 'beds24',
  provider_property_id: '209413', migration_target_property_id: 'chx-cible'
}

// Faux postgrest : note le filtre `.or()` recu et rend les biens correspondants.
function faux (biens) {
  let recu = null
  const api = {
    from () { return api }, select () { return api },
    eq () { return api },
    or (expr) { recu = expr; return api },
    limit: async () => {
      const val = (col) => (String(recu).match(new RegExp('(^|,)' + col + '\\.eq\\.([^,]+)')) || [])[2]
      const p = val('provider_property_id'); const c = val('migration_target_property_id')
      return { data: biens.filter(b => b.provider_property_id === p || b.migration_target_property_id === c), error: null }
    }
  }
  return { api, filtre: () => recu }
}

// ─── coeur -> provider ──────────────────────────────────────────────────────

test('LE TEST QUI COMPTE : on adresse le provider par la CIBLE, pas par la cle source', () => {
  assert.equal(proprieteChezLeProvider(EN_MIGRATION), 'chx-cible')
})

test('les endpoints de canal resolvent la destination, ils ne prennent pas la cle recue', () => {
  // `GET /channels?filter[property_id]=209413` rend HTTP 422 : sans cette
  // resolution, creer le canal Booking (phase 1.1) echoue.
  for (const f of ['api/channel-mapping.js', 'api/channel-bcom-write.js']) {
    const src = lire(f)
    assert.ok(src.includes('proprieteChezLeProvider'), `${f} resout la destination`)
    assert.ok(src.includes('idChezLeProvider'), `${f} adresse le provider par la destination resolue`)
  }
})

test('un bien sans propriete chez le provider est refuse avec un motif, pas un 422', () => {
  const src = lire('api/channel-mapping.js')
  assert.ok(src.includes('pas_de_propriete_chez_le_provider'))
})

// ─── provider -> coeur ──────────────────────────────────────────────────────

test('LE TEST QUI COMPTE : un bien se retrouve par sa propriete CIBLE', async () => {
  const f = faux([EN_MIGRATION])
  const b = await trouverBienParIdProvider(f.api, 'chx-cible', { colonnes: 'id' })
  assert.equal(b && b.id, 'uuid-bulle')
  assert.match(f.filtre(), /migration_target_property_id\.eq\.chx-cible/)
})

test('et toujours par sa cle source, tant que la bascule n a pas eu lieu', async () => {
  const f = faux([EN_MIGRATION])
  const b = await trouverBienParIdProvider(f.api, '209413', { colonnes: 'id' })
  assert.equal(b && b.id, 'uuid-bulle')
})

test('un identifiant inconnu ne rend rien, et ne jette pas', async () => {
  const f = faux([EN_MIGRATION])
  assert.equal(await trouverBienParIdProvider(f.api, 'inconnu', { colonnes: 'id' }), null)
})

test('le webhook et les evenements cherchent sur les DEUX colonnes', () => {
  // Sans cela, une reservation arrivant sur la propriete cible n'est reclamee
  // par personne — perdue en silence pendant toute la bascule.
  for (const f of ['api/channel-webhook.js', 'api/channel-events.js']) {
    assert.ok(lire(f).includes('trouverBienParIdProvider'), `${f} passe par le point unique`)
  }
})

test('la garde d autorisation reconnait la propriete cible', () => {
  // Elle resolvait le bien par sa seule cle source : pendant la bascule, elle
  // refusait l acces a son proprietaire legitime.
  const src = lire('lib/require-permission.js')
  const resolutions = src.match(/migration_target_property_id\.eq\./g) || []
  assert.equal(resolutions.length, 2, 'les DEUX chemins de resolution (UUID et propId)')
})

// ─── Ce que la premiere version avait inverse ───────────────────────────────

test('LE TEST QUI COMPTE : le coeur est ecrit sous SA cle, pas sous l id recu', () => {
  // Le webhook arrive avec la propriete CIBLE pendant une migration, mais tous
  // les lecteurs du coeur interrogent `bookings_snapshot.property_id` avec
  // `provider_property_id` — le calendrier, le planning menage, et surtout
  // `nuitsOccupees`, qui alimente le verrou anti-surreservation. Ecrire sous
  // l'id recu enregistrait la reservation sous une cle que personne ne lit :
  // la nuit vendue serait passee pour libre.
  const src = lire('api/channel-webhook.js')
  assert.ok(src.includes('const cleDuCoeur = owner.provider_property_id'))
  assert.ok(src.includes('propertyId: cleDuCoeur'), 'le snapshot est keye par le coeur')
  assert.ok(/property_id:\s*String\(cleDuCoeur\)/.test(src), 'la conversation aussi')
  // L'appel SORTANT, lui, garde l'identifiant du provider.
  assert.ok(src.includes('pushAvailabilityOnce(owner, providerPropertyId'),
    'ce qui part vers le provider garde son identifiant')
})

test('un identifiant AMBIGU refuse la reservation au lieu de l attribuer au hasard', async () => {
  const f = faux([
    { ...EN_MIGRATION, id: 'bien-A' },
    { ...EN_MIGRATION, id: 'bien-B', user_id: 'autre-hote' }
  ])
  const r = await trouverBienParIdProvider(f.api, '209413', { colonnes: 'id' })
  assert.deepEqual(r, { ambigu: true })
  // Et les appelants le traitent comme un refus, pas comme un bien.
  const src = lire('api/channel-webhook.js')
  assert.ok(src.includes('ambiguous_property'), 'le webhook refuse')
})

test('un identifiant au format douteux est refuse AVANT toute interpolation', async () => {
  // Il vient d un payload externe : une virgule y injecterait des filtres
  // PostgREST, sur le chemin qui decide a quel hote appartient une reservation.
  const f = faux([EN_MIGRATION])
  assert.equal(await trouverBienParIdProvider(f.api, '209413,user_id.eq.autre', { colonnes: 'id' }), null)
  assert.equal(f.filtre(), null, 'aucune requete partie')
})

test('la garde canal compare aux DEUX identifiants du bien', () => {
  // `bienDuCanal` vient du canal Channex — donc de la propriete cible pendant
  // une migration — tandis que le front envoie la cle source. Comparer a la
  // seule cle source refusait TOUTES les actions a canal pendant la bascule.
  const src = lire('api/channel-mapping.js')
  assert.ok(src.includes('identifiantsDuBien'))
  assert.ok(/identifiantsDuBien\.includes\(String\(gardeCanal\.bienDuCanal\)\)/.test(src))
})

test('le post-mapping lit chez Channex, jamais chez le provider source', () => {
  // Pour un bien en bascule, `provider` vaut encore 'beds24' : sans cela, un
  // `activate_channel` serait alle tirer les reservations chez Beds24 pour les
  // ecrire avec `provider: 'channex'`, puis poser `channel_ready` et declencher
  // la facturation.
  const src = lire('api/channel-events.js')
  assert.ok(src.includes("getProvider('channex')"), 'le provider est explicite')
  assert.ok(!/getProvider\(owner\.provider/.test(src), 'et jamais celui du bien')
  assert.ok(src.includes('propertyId: idChezLeProvider'), 'on lit chez le provider par sa cible')
  assert.ok(src.includes('propertyId: cleDuCoeur'), 'on ecrit dans le coeur par sa cle')
})

// ─── Les chemins JUMEAUX, qui n avaient pas suivi ───────────────────────────

test('LE TEST QUI COMPTE : le poll de secours ne PURGE plus un bien en migration', () => {
  // Il lit le MEME feed que le webhook, mais lui ACKE quand aucun bien n est
  // trouve : la revision disparait DEFINITIVEMENT. Une reservation arrivee sur
  // la propriete cible aurait donc ete purgee par le filet de securite lui-meme.
  const src = lire('lib/cron-channel-feed.js')
  assert.ok(src.includes('trouverBienParIdProvider'), 'meme resolution que le webhook')
  assert.ok(src.includes('ambiguous_property'), 'et l ambiguite n est pas ackee')
  assert.ok(src.includes('propertyId: owner.provider_property_id'), 'ecriture sous la cle du coeur')
})

test('un message AMBIGU est rejoue, comme la reservation ambigue', () => {
  // La reservation revenait dans le feed (non ackee) tandis que le message du
  // voyageur repondait 200 et etait abandonne : deux chemins qui ne faisaient
  // pas ce que leur commentaire annoncait.
  const src = lire('api/channel-webhook.js')
  assert.ok(/reason === 'db_error' \|\| result\.reason === 'ambiguous_property'/.test(src))
})

test('LE TEST QUI COMPTE : creer un canal ne declenche pas la facturation d un bien en migration', () => {
  // Depuis que le bien est retrouvable par sa propriete cible, la creation du
  // canal Booking INACTIF (phase 1.1) atteint le post-mapping : il poserait
  // `channel_ready`, `active_at` — donc le debut du trial — et lancerait le
  // rattrapage des messages chez Channex pour un bien encore servi par Beds24.
  const src = lire('api/channel-events.js')
  assert.ok(src.includes('estEnMigration(owner)'))
  assert.ok(src.includes('migration_en_cours'))
})

test('les endpoints jumeaux resolvent le bien comme la garde', () => {
  // La garde accepte les deux identifiants : un endpoint qui n en accepte qu un
  // laisse passer l appelant puis lui rend 404.
  for (const f of ['api/channel-bcom.js', 'api/channel-rateplan.js', 'api/channel-bcom-write.js']) {
    assert.ok(lire(f).includes('migration_target_property_id.eq.'), `${f} resout sur les deux`)
  }
})

// ─── Phase 1 : la sequence Booking impose l ordre ───────────────────────────

test('LE TEST QUI COMPTE : le canal se cree SANS mapping, parce que les codes n existent pas encore', () => {
  // Mesure du 9 septembre 2026 sur les deux hotels de Bagneres :
  // `test_connection` rend `success: false` et `mapping_details` HTTP 422 tant
  // que la connexion n'est pas approuvee dans l'extranet. Or c'est la CREATION
  // du canal qui fait apparaitre la demande cote Booking. Exiger les codes a la
  // creation demandait une information qui n'existe pas encore : l'etape etait
  // infaisable dans l'ordre reel.
  const src = lire('api/channel-bcom-write.js')
  assert.ok(src.includes('const avecMapping ='), 'le mapping devient optionnel')
  assert.ok(src.includes('rate_plans: avecMapping ?'), 'sans codes, aucun rate plan mappe')
  assert.ok(!/room_type_code \(entier Booking\) requis/.test(src), 'les codes ne sont plus exiges')
})

test('LE TEST QUI COMPTE : un mapping A MOITIE est refuse — le handler, pas la source', async () => {
  // Un test qui lit la source resterait vert si `||` devenait `&&` : la regle
  // s'inverserait (un seul code -> canal cree sans mapping, en silence) sans que
  // rien ne le dise. On appelle donc le handler.
  const handler = require('../api/channel-bcom-write')
  for (const query of [
    { action: 'create', property_id: '209413', hotel_id: '10853342', room_type_code: '12' },
    { action: 'create', property_id: '209413', hotel_id: '10853342', rate_plan_code: '7' },
    // Le cas qui a cree la regression : le client interpole toujours les deux,
    // donc un code absent arrive en chaine 'undefined'.
    { action: 'create', property_id: '209413', hotel_id: '10853342',
      room_type_code: 'undefined', rate_plan_code: 'undefined' }
  ]) {
    let code = null; let corps = null
    const res = {
      status (c) { code = c; return res },
      json (b) { corps = b; return res },
      setHeader () { return res }, end () { return res }
    }
    // Un token quelconque : la validation de forme precede la garde, et c'est
    // voulu — un parametre illisible n'a pas a couter un aller-retour Supabase.
    await handler({ method: 'POST', query, headers: { authorization: 'Bearer x' }, body: {} }, res)
    assert.equal(code, 400, `refus attendu pour ${JSON.stringify(query)} (recu ${code})`)
    assert.match(String(corps && corps.error), /room_type_code/)
  }
})

test('le mapping peut etre POSE apres l approbation, sans recreer le canal', () => {
  // Sans cette action, un canal cree sans mapping n avait pour seule sortie que
  // DELETE + recreation — donc une NOUVELLE demande d approbation cote Booking,
  // la boucle meme que la phase 1 cherche a eviter.
  const src = lire('api/channel-bcom-write.js')
  assert.ok(src.includes("if (action === 'map')"), 'l action existe')
  assert.ok(/method === 'PUT'/.test(src), 'et le reseau l autorise')
  // Le PAYLOAD envoye ne porte jamais `is_active` : l activation reste un geste
  // a part. (Le retour, lui, RELIT l etat du canal — c'est une lecture.)
  const bloc = src.slice(src.indexOf('const payloadM = {'), src.indexOf('const dryRunM'))
  assert.ok(!/is_active/.test(bloc), 'le mapping ne touche jamais l activation')
})

test('le canal reste INACTIF a la creation, quoi qu il arrive', () => {
  // C'est ce qui rend la bascule sans trou possible : on mappe pendant qu il
  // dort, on verifie, on active ensuite.
  const src = lire('api/channel-bcom-write.js')
  assert.ok(/is_active: false/.test(src))
  assert.ok(/FORCE cote serveur/i.test(src), 'et ce n est pas pilotable par l appelant')
})
