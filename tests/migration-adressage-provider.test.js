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
  // Mesure du 10 septembre 2026 sur les deux hotels de Bagneres :
  // `test_connection` rend `success: false` et `mapping_details` HTTP 422 tant
  // que la connexion n'est pas activee dans l'extranet Booking. Or c'est la CREATION
  // du canal qui fait apparaitre la demande cote Booking. Exiger les codes a la
  // creation demandait une information qui n'existe pas encore : l'etape etait
  // infaisable dans l'ordre reel.
  const src = lire('api/channel-bcom-write.js')
  assert.ok(src.includes('const avecMapping ='), 'le mapping devient optionnel')
  assert.ok(src.includes('rate_plans: avecMapping ?'), 'sans codes, aucun rate plan mappe')
  assert.ok(!/room_type_code \(entier Booking\) requis/.test(src), 'les codes ne sont plus exiges')
})

test('LE TEST QUI COMPTE : hotel_id en NOMBRE a la creation, en CHAINE a la lecture', () => {
  // ⚠ L'EXIGENCE DE CHANNEX EST INVERSE SELON L'APPEL, ET MESUREE :
  //   POST /channels                      -> hotel_id NOMBRE  (chaine  -> HTTP 500, sans detail)
  //   POST /channels/mapping_details      -> hotel_id CHAINE   (nombre -> HTTP 422 {"errors":null})
  //   idem test_connection / connection_details.
  //
  // Le 422 a corps vide est indiscernable d'un refus de l'OTA. Le 10 septembre
  // 2026, il a fait conclure a tort que « Channex n'est pas autorise chez
  // Booking » — et supprimer un canal correctement cree — alors que la
  // connexion etait active et tous les scopes accordes. Une fois `hotel_id`
  // envoye en chaine, le meme appel a rendu les codes de La bulle
  // (room 1085334201 / rate 39174986) en HTTP 200.
  //
  // Aligner les deux cotes sur une seule forme casse donc l'un ou l'autre.
  const write = lire('api/channel-bcom-write.js')
  assert.ok(write.includes('hotel_id: Number(hotelId)'),
    'la CREATION envoie un nombre')

  const read = lire('api/channel-bcom.js')
  assert.ok(/const settingsFor = \(hotelId\) => \(\{ hotel_id: String\(hotelId\) \}\)/.test(read),
    'la LECTURE envoie une chaine')
  // Les trois appels de lecture passent bien par settingsFor, sans reconstruire
  // le settings a la main (c'est par la que le nombre reviendrait).
  for (const ep of ['test_connection', 'mapping_details', 'connection_details']) {
    // On cherche l'APPEL, pas l'allowlist : `'/channels/test_connection'`
    // apparait d'abord dans ENDPOINTS_AUTORISES, ou il n'y a pas de settings.
    const bloc = read.slice(read.indexOf(`channelCall('POST', '/channels/${ep}'`))
    assert.ok(bloc.slice(0, 200).includes('settingsFor(hotelId)'),
      `${ep} passe par settingsFor`)
  }
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

// ─── Le type de `hotel_id`, mesure le 10 septembre 2026 ─────────────────────

test('LE TEST QUI COMPTE : `hotel_id` part en NOMBRE, sinon la creation rend 500 muet', () => {
  // Mesure reelle sur l hotel 10853342 : en CHAINE, `POST /channels` rend
  // HTTP 500 « internal_server_error » sans aucun detail — pas un 422 qui
  // nommerait le champ. Quatre variantes essayees avant de trouver ; le seul
  // changement qui fait passer de 500 a 201 est le TYPE.
  //
  // L ecran de liaison Booking de l hote aurait echoue la, juste apres une
  // verification reussie, et sans rien pour comprendre.
  const src = lire('api/channel-bcom-write.js')
  assert.ok(/settings: \{ hotel_id: Number\(hotelId\) \}/.test(src), 'la creation envoie un nombre')

  // ⚠ CETTE ASSERTION DISAIT « et jamais une chaine » DANS TOUT LE FICHIER.
  // Elle etait juste tant qu'on ignorait la suite, et elle est devenue fausse le
  // 10 septembre 2026 au soir : `POST /channels/:id/activate` REFUSE un
  // `hotel_id` numerique (`422 {"settings":["invalid settings"]}`), donc un
  // canal cree par cet endpoint etait INACTIVABLE pour toujours. Il faut
  // desormais un `PUT` de normalisation en CHAINE juste apres la creation.
  // On borne donc l'assertion au PAYLOAD DE CREATION, qui est ce qu'elle
  // voulait proteger.
  const iPayload = src.indexOf('const payload = {')
  const blocCreation = src.slice(iPayload, src.indexOf("channelCall('POST', '/channels', payload)"))
  assert.ok(!/hotel_id: String\(hotelId\)/.test(blocCreation),
    'le payload de CREATION n envoie jamais une chaine')
  assert.ok(/settings: \{ hotel_id: String\(hotelId\) \}/.test(src),
    'mais la normalisation en chaine existe, sinon le canal est inactivable')
})

test('un `hotel_id` non numerique est refuse AVANT l appel', () => {
  const src = lire('api/channel-bcom-write.js')
  assert.ok(/hotel_id invalide \(nombre de 1 a 15 chiffres attendu\)/.test(src))
})

test('`hotel_id` est BORNE : Number() ne doit pas arrondir en silence', () => {
  // 17 chiffres passaient `/^\d+$/`, et `Number()` en perdait la fin : Channex
  // recevait un identifiant DIFFERENT de celui saisi, avec un 201 en retour —
  // donc un ecran qui annonce la reussite sur le mauvais hotel.
  const src = lire('api/channel-bcom-write.js')
  assert.ok(/\^\[1-9\]\\d\{0,14\}\$/.test(src), 'borne a 15 chiffres, sans zero de tete')
  // Contre-epreuve de la regle elle-meme.
  const re = /^[1-9]\d{0,14}$/
  assert.ok(re.test('10853342'), 'un hotel_id reel passe')
  assert.ok(!re.test('123456789012345678'), '18 chiffres refuses')
  assert.ok(!re.test('0'), 'zero refuse')
  assert.ok(!re.test('0123'), 'zero de tete refuse')
})

test('LE TEST QUI COMPTE : le mapping n envoie QUE le mapping', () => {
  // J avais ajoute `settings: { hotel_id }` « au cas ou le PUT remplace l objet
  // comme la creation ». Non mesure, et casseur : renvoyer une seule cle de
  // `settings` aurait efface les autres si le remplacement etait reel (Channex
  // y met `machine_account` et sept reglages de paiement), et exiger de relire
  // ce champ ouvrait un 502 sur une lecture non garantie.
  const src = lire('api/channel-bcom-write.js')
  const bloc = src.slice(src.indexOf('const payloadM = {'), src.indexOf('const dryRunM'))
  // On ne regarde que le CODE : le commentaire, lui, parle de `settings`. Et
  // c'est `hotel_id` qu'on traque — le `settings` du rate_plan (occupancy,
  // codes Booking) EST le mapping, il a sa place ici.
  const code = bloc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  assert.ok(!/hotel_id/.test(code), 'le PUT ne touche pas aux reglages du canal')
  assert.ok(/rate_plans: \[\{/.test(bloc), 'seulement le mapping')
})

// ─── Le point d entree manquant, signale par Thierry ────────────────────────

test('LE TEST QUI COMPTE : un bien EN MIGRATION est visible dans les ecrans de connexion', () => {
  // Constat de Thierry, 10 septembre 2026 : « sur HoteSmart je ne peux pas
  // deconnecter de Beds24 et remapper ensuite, je pensais que c'etait prevu ».
  // Ce ne l'etait pas. Les deux filtres ne montraient que les biens DEJA chez
  // le canal : un bien encore `beds24`, meme pourvu de sa propriete Channex par
  // l'assistant, n'apparaissait nulle part — et il n'existait aucun autre
  // chemin dans le produit pour le connecter. La migration butait sur une page
  // vide et un bouton absent.
  for (const f of ['pages/connexions.html', 'pages/biens.html']) {
    const src = lire(f)
    assert.ok(/migration_target_property_id/.test(src),
      `${f} : un bien en migration doit passer le filtre`)
  }
  // Et l endpoint doit rendre la colonne, sinon le filtre lit `undefined`.
  const api = lire('api/channel-property.js')
  const select = (api.match(/\.select\('id, name, provider[^']*'\)/) || [''])[0]
  assert.ok(select.includes('migration_target_property_id'),
    'la liste des biens porte la colonne cible : ' + select.slice(0, 80))
})

test('LE TEST QUI COMPTE : le mapping Booking cible le tarif DERIVE — la decision, pas la source', () => {
  // Mesure du 10 septembre 2026 sur le canal Booking de Colomiers, le seul en
  // production : il mappe `55b784ba-…` = « Colomiers — booking (derive) », et
  // non `06a3f06c-…` = « Tarif Standard ». Or `action=map` envoyait
  // `properties.provider_rate_plan_id`, qui porte justement la BASE.
  // Consequence silencieuse : le prix non derive part chez l'OTA, la
  // commission Booking et le `min_stay` de `property_channel_rate_plans`
  // disparaissent, et la table devient decorative.
  //
  // ⚠ PREMIERE VERSION DE CE TEST : FAUX VERT, DEMONTRE EN REVIEW.
  // Il lisait la source (`from('property_channel_rate_plans')`,
  // `rate_plan_id: ratePlanCible`, …). Remplacer la cible par
  // `propM.provider_rate_plan_id` — donc inverser la regle — laissait les CINQ
  // assertions vertes : les chaines cherchees etaient toujours la. On exerce
  // donc la DECISION, extraite en fonction pure pour cette raison.
  const { choisirTarifDerive } = require('../api/channel-bcom-write')

  // Le cas nominal : un lien derive -> c'est LUI qui est mappe.
  const ok = choisirTarifDerive([{ provider_rate_plan_id: '043297fc-derive' }])
  assert.equal(ok.ok, true)
  assert.equal(ok.ratePlanId, '043297fc-derive')

  // ⚠ AUCUN DERIVE -> REFUS, PAS DE REPLI SUR LA BASE.
  // J'avais mis un repli « mieux vaut un mapping non derive qu'un refus »,
  // signale par un booleen dans la reponse. Sur le chemin qui ECRIT, ce
  // booleen etait noye a cote de `http: 200` : ca se lisait comme un succes et
  // le prix non derive partait quand meme. Le chemin jumeau
  // (api/channel-rateplan.js, action=remap to=derived) rend 400 : on s'aligne.
  const vide = choisirTarifDerive([])
  assert.equal(vide.ok, false)
  assert.equal(vide.http, 400)
  assert.match(String(vide.corps.error), /Aucun tarif derive booking/)
  assert.ok(!('ratePlanId' in vide), 'aucune cible rendue sur un refus')

  // Une ligne presente mais sans identifiant ne vaut pas un derive.
  assert.equal(choisirTarifDerive([{ provider_rate_plan_id: null }]).ok, false)
  assert.equal(choisirTarifDerive([null, undefined]).ok, false)
  assert.equal(choisirTarifDerive(null).ok, false)

  // ⚠ DOUBLON -> 409, PAS UN CHOIX ARBITRAIRE. Aucune migration du depot ne
  // cree cette table : rien ne garantit `unique(property_id, channel)`. Le
  // `.maybeSingle()` d'origine sortait alors en 500 « Erreur lecture », sans
  // diagnostic. Et prendre la premiere ligne aurait fait dependre le prix
  // envoye a l'OTA de l'ordre de PostgREST.
  const deux = choisirTarifDerive([
    { provider_rate_plan_id: 'a' }, { provider_rate_plan_id: 'b' }
  ])
  assert.equal(deux.ok, false)
  assert.equal(deux.http, 409)
  assert.equal(deux.corps.trouves, 2)
})

test('LE TEST QUI COMPTE : un refus de Channex arrive au front avec sa raison', () => {
  // `shared/api-client.js` compose son message avec `data.error`. Les branches
  // d'ecriture rendaient 502 SANS ce champ : la raison dormait dans `result`,
  // que le front jette. L'ecran de liaison affichait donc « la connexion n'a
  // pas pu etre finalisee » sans jamais dire pourquoi, et « Reessayer »
  // rejouait un refus definitif. Mesure du 10 septembre : un second canal
  // Booking sur un bien qui en a deja un se refusait ainsi en silence.
  const { raisonChannex } = require('../api/channel-bcom-write')

  // Channex n'a pas une seule forme d'erreur. Les cinq rencontrees :
  assert.equal(raisonChannex({ errors: null }, 'Refuse'), 'Refuse',
    'corps vide -> le libelle par defaut, jamais un message vide')
  assert.equal(raisonChannex(null, 'Refuse'), 'Refuse')
  assert.match(raisonChannex(
    { errors: { code: 'bad_request', title: 'Bad Request', details: null } }, 'Refuse'),
    /Bad Request/)
  assert.match(raisonChannex(
    { errors: 'You not have access to requested group' }, 'Refuse'),
    /requested group/)
  // `details` en objet { champ: [messages] } : tout doit remonter.
  const detaille = raisonChannex({ errors: {
    code: 'x', title: 'Bad Request',
    details: { settings: ["can't be blank"], channel: ['is invalid'] }
  } }, 'Refuse')
  assert.match(detaille, /can't be blank/)
  assert.match(detaille, /is invalid/)

  // Et les deux branches d'ecriture le posent bien dans `error`.
  const src = lire('api/channel-bcom-write.js')
  assert.equal((src.match(/error: raisonChannex\(/g) || []).length, 2,
    'create ET map rendent la raison')
})

test('LE TEST QUI COMPTE : le mapping est une decision tarifaire, donc garde par canPushRates', () => {
  // Le chemin jumeau le dit dans son propre commentaire : « le remap change la
  // source de prix lue par l'OTA -> ecriture tarifaire. Refuse en 'keep' ».
  // Depuis que `action=map` choisit entre base et derive, il fait la meme
  // chose — un bien en `keep` (Beds24 maitre des prix) ne doit pas voir son
  // canal Booking pointe sur le derive HoteSmart.
  const src = lire('api/channel-bcom-write.js')
  assert.ok(/canPushRates.*require\('\.\.\/lib\/rate-sync'\)/.test(src)
    || /require\('\.\.\/lib\/rate-sync'\)/.test(src) && src.includes('canPushRates'),
    'la garde est importee')
  assert.ok(src.includes('!canPushRates(propM)'), 'et appliquee au bien du canal')
  assert.ok(src.includes('{ ...RATE_PUSH_BLOCKED }'), 'avec le refus standard du depot')
  // Le dry-run reste autorise : c'est lui qui sert a MONTRER avant le geste.
  assert.ok(src.includes("req.query.dry_run === 'false' && !canPushRates(propM)"),
    'le dry-run n\'est pas gate')
})

test('LE TEST QUI COMPTE : l\'ecran de liaison mappe un canal existant au lieu d\'en recreer un', () => {
  // Mesure du 10 septembre sur Cœur de vie « La bulle », dont le canal avait
  // ete cree par l'assistant de migration : l'ecran C appelait toujours
  // `create`, Channex refusait le doublon, et le bouton « Reessayer » rejouait
  // le meme refus sans issue. `action=map` existait cote serveur depuis le
  // debut de la phase 1 — il n'etait branche nulle part.
  const client = lire('shared/api-client.js')
  assert.ok(/map: \(channelId, \{/.test(client), 'le client expose map')
  assert.ok(client.includes('action=map&channel_id='), 'sur l\'action serveur')
  // Le mapping s'adresse par channel_id, PAS par property_id : passer le bien
  // aurait redemande une resolution que la garde du canal fait deja.
  const bloc = client.slice(client.indexOf('map: (channelId, {'))
  assert.ok(!bloc.slice(0, 400).includes('property_id='), 'map n\'envoie pas de property_id')

  const ecran = lire('components/booking-connect.js')
  assert.ok(ecran.includes('if (S.channelId) {'), 'l\'ecran distingue les deux cas')
  const i = ecran.indexOf('if (S.channelId) {')
  const suite = ecran.slice(i, i + 700)
  assert.ok(suite.includes('api.channel.bcom.map('), 'canal existant -> map')
  assert.ok(suite.includes('api.channel.bcom.create('), 'sinon -> create')
  assert.ok(suite.indexOf('api.channel.bcom.map(') < suite.indexOf('api.channel.bcom.create('),
    'map est bien la branche du canal existant')
  // La cause du refus doit etre montree : sans elle, « Reessayer » invite a
  // rejouer un refus definitif.
  assert.ok(ecran.includes('Détail :'), 'l\'ecran affiche la cause rendue par le serveur')
})

test('LE TEST QUI COMPTE : la CREATION mappe le derive, pas seulement `map`', () => {
  // ⚠ J'AVAIS CORRIGE `map` ET OUBLIE `create` — la branche que l'ecran de
  // liaison utilise reellement. Constate le 10 septembre 2026 sur le canal
  // Booking de Cœur de vie 23, cree depuis le tableau de bord : mappe sur
  // `ad0a594e-…` = « Tarif Standard », le plan de BASE. L'OTA aurait lu le
  // prix non derive, et la commission comme le `min_stay` portes par
  // `property_channel_rate_plans` auraient disparu en silence.
  const src = lire('api/channel-bcom-write.js')

  // Plus AUCUNE branche n'envoie `provider_rate_plan_id` dans un payload de
  // mapping. C'est l'assertion qui aurait attrape l'oubli.
  assert.ok(!/rate_plan_id: prop\.provider_rate_plan_id/.test(src),
    'create n envoie plus le plan de base')
  assert.ok(!/rate_plan_id: propM\.provider_rate_plan_id/.test(src),
    'map non plus')

  // Les deux branches passent par la MEME decision.
  // Deux APPELS : un dans create, un dans map. La definition s'ecrit
  // `function choisirTarifDerive (liens)` — espace avant la parenthese, donc
  // elle n'est pas comptee ici, et l'export non plus (pas de parenthese).
  assert.equal((src.match(/choisirTarifDerive\(/g) || []).length, 2,
    'la meme decision est appelee par create ET par map')
  assert.ok(/function choisirTarifDerive \(/.test(src), 'definie une seule fois')
  assert.ok(src.includes('rate_plan_id: ratePlanCreate'), 'create utilise sa cible resolue')
  assert.ok(src.includes('rate_plan_id: ratePlanCible'), 'map utilise la sienne')

  // ⚠ MAIS SEULEMENT QUAND UN MAPPING EST DEMANDE. Sans codes, le canal se
  // cree vide : exiger le derive rendrait impossible la creation AVANT
  // l'approbation de l'OTA, ce que toute cette branche existe pour permettre.
  assert.ok(src.includes('if (avecMapping) {'),
    'la resolution du derive est conditionnee au mapping demande')

  // ⚠ ET `create` N'EST PAS GATE PAR canPushRates, contrairement a `map`.
  // `map` change la source de prix d'un canal deja en place ; `create` pose le
  // premier mapping d'un canal cree INACTIF, rien n'est pousse avant
  // l'activation. Gater ici refuserait l'onboarding de tout nouvel hote, dont
  // le bien nait en `rate_sync_mode = 'keep'`.
  // On retire les COMMENTAIRES avant de chercher : celui qui explique
  // l'absence de la garde nomme `canPushRates`, et le test se declenchait sur
  // sa propre justification.
  const blocCreate = src.slice(src.indexOf("if (action === 'create')"),
    src.indexOf('================= MAP'))
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  assert.ok(!blocCreate.includes('canPushRates'),
    'create ne gate pas : le canal nait inactif, et le bien neuf est en keep')
})
