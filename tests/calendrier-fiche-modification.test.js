// tests/calendrier-fiche-modification.test.js
// Chantier UI calendrier desktop du 15 septembre 2026 :
//   1. rendu des bulles de reservation (milieu -> milieu, nom lisible)
//   2. acces a la conversation depuis la fiche
//   3. edition directe des reservations « Offline » + fermeture a la vente
//   4. marquage des week-ends
//
// Les invariants de COMPORTEMENT (verrou, intentions) sont testes en vrai ;
// ceux qui vivent dans du HTML/CSS sont lus dans le fichier, comme le fait deja
// tests/calendrier-resa.test.js.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test'
process.env.CHANNEL_BASE_URL = process.env.CHANNEL_BASE_URL || 'https://exemple.invalid/api/v1'
process.env.CHANNEL_API_KEY = process.env.CHANNEL_API_KEY || 'k'

const { verifierDisponibilite, intentionsEnCours } = require('../lib/reservation-directe')

const lire = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8')
// RETARGE le 13 octobre 2026 : les anciennes pages redirigent vers la V5.
const PAGE_BRUTE = lire('pages', 'calendrier.html')
// On teste le CODE, pas les commentaires : ceux-ci citent volontiers ce qu'on a
// supprime (« l'ancien calcul (span-0.5) »), et les chercher dans le fichier
// brut ferait echouer un test sur sa propre documentation.
const sansCommentaires = (s) => s.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
const PAGE = sansCommentaires(PAGE_BRUTE)
const MOBILE = lire('pages', 'calendrier.html')
// Depuis le chantier calendrier mobile (30 septembre 2026), la regle
// « modifiable », sa note et l'adresse de la conversation vivent dans le module
// commun aux deux ecrans : les tests la cherchent la, et verifient que la page
// l'appelle.
const MODULE = lire('shared', 'calendrier-resa.js')
const CORE = lire('shared', 'calendar-core.js')
// Meme raison que pour PAGE : les commentaires de `api/calendar.js` expliquent
// ce qui a ete RETIRE (« un `.in('booking_id', tousLesIds)` »), et chercher ces
// chaines dans le fichier brut ferait echouer un test sur sa propre explication.
const CAL = sansCommentaires(lire('api', 'calendar.js'))
const API = lire('api', 'reservation-directe.js')
const LIB = lire('lib', 'reservation-directe.js')
const MSG = lire('pages', 'messages.html')   // etape 4 : l'ancienne page est une redirection
const MSGAPI = lire('api', 'messages.js')
const CLIENT = lire('shared', 'api-client.js')

// ═══════════════════════════════════════════════════════════════════════════
// 1. LES INTENTIONS NE BLOQUENT PAS LA RESERVATION QUI LES A POSEES
// ═══════════════════════════════════════════════════════════════════════════

// `intentions` : [{ key, token }] encore valides dans write_locks.
function fakeSupabase ({ unites = 1, lignes = [], intentions = [], provider = 'channex' } = {}) {
  return {
    from (table) {
      const estVerrou = table === 'write_locks'
      const q = {
        select () { return q }, eq () { return q }, gte () { return q }, lte () { return q },
        in () { return q }, gt () { return q }, like () { return q },
        maybeSingle: async () => ({ data: { inventory_units: unites, name: 'Bien', provider }, error: null }),
        then (res, rej) {
          if (estVerrou) return Promise.resolve({ data: intentions, error: null }).then(res, rej)
          return Promise.resolve({ data: lignes, error: null }).then(res, rej)
        }
      }
      return q
    }
  }
}

const cle = (n) => `resa-nuit:u:p:${n}`

test('intentions : sans `ignorerToken`, une nuit tenue reste comptee', async () => {
  // ⚠ LE PIEGE A EVITER : un filtre ecrit `l.token === ignorerToken` ecarterait
  // TOUTES les intentions quand `ignorerToken` est absent (undefined ===
  // undefined), c'est-a-dire le verrou desarme sur le chemin ordinaire — celui
  // que passent la creation manuelle et le moteur public.
  const sb = fakeSupabase({ intentions: [{ key: cle('2026-10-12'), token: 'B-42' }] })
  const par = await intentionsEnCours(sb, { userId: 'u', propertyId: 'p', nuits: ['2026-10-12'] })
  assert.strictEqual(par['2026-10-12'], 1, 'la tenue d\'une AUTRE reservation compte toujours')
})

test('intentions : une nuit tenue par des marqueurs SANS token compte aussi', async () => {
  const sb = fakeSupabase({ intentions: [{ key: cle('2026-10-12'), token: null }] })
  const par = await intentionsEnCours(sb, { userId: 'u', propertyId: 'p', nuits: ['2026-10-12'], ignorerToken: 'B-42' })
  assert.strictEqual(par['2026-10-12'], 1, 'un marqueur anonyme n\'appartient a personne : il compte')
})

test('intentions : `ignorerToken` ecarte les SIENNES, et elles seules', async () => {
  const sb = fakeSupabase({
    intentions: [{ key: cle('2026-10-12'), token: 'B-42' }, { key: cle('2026-10-13'), token: 'B-99' }]
  })
  const par = await intentionsEnCours(sb, {
    userId: 'u', propertyId: 'p', nuits: ['2026-10-12', '2026-10-13'], ignorerToken: 'B-42'
  })
  assert.strictEqual(par['2026-10-12'], undefined, 'sa propre tenue ne se compte pas')
  assert.strictEqual(par['2026-10-13'], 1, 'celle d\'une autre reservation, si')
})

test('MODIFICATION : une resa ne se heurte ni a son propre sejour ni a ses propres nuits tenues', async () => {
  // Scenario reel : l'hote cree 12->15, puis corrige aussitot en 12->16.
  // Sans `exclure`, le sejour deja dans le cœur refuse la prolongation ;
  // sans `ignorerToken`, les marqueurs de sa creation la refusent aussi.
  const sb = fakeSupabase({
    lignes: [{ booking_id: 'B-42', snapshot: { provider: 'channex', status: 'confirmed', arrival: '2026-10-12', departure: '2026-10-15' } }],
    intentions: [
      { key: cle('2026-10-12'), token: 'B-42' },
      { key: cle('2026-10-13'), token: 'B-42' },
      { key: cle('2026-10-14'), token: 'B-42' }
    ]
  })
  const r = await verifierDisponibilite(sb, {
    userId: 'u', propertyId: 'p', arrival: '2026-10-12', departure: '2026-10-16',
    exclure: 'B-42', ignorerToken: 'B-42'
  })
  assert.strictEqual(r.ok, true, 'la prolongation doit passer')
  assert.deepStrictEqual(r.conflits, [])
})

test('MODIFICATION : elle reste refusee sur les nuits d\'une AUTRE reservation', async () => {
  // La contrepartie du test precedent : desarmer le verrou pour soi-meme ne doit
  // pas le desarmer tout court. C'est exactement la surreservation a empecher.
  const sb = fakeSupabase({
    lignes: [
      { booking_id: 'B-42', snapshot: { provider: 'channex', status: 'confirmed', arrival: '2026-10-12', departure: '2026-10-15' } },
      { booking_id: 'B-99', snapshot: { provider: 'channex', status: 'confirmed', arrival: '2026-10-16', departure: '2026-10-18' } }
    ]
  })
  const r = await verifierDisponibilite(sb, {
    userId: 'u', propertyId: 'p', arrival: '2026-10-12', departure: '2026-10-18',
    exclure: 'B-42', ignorerToken: 'B-42'
  })
  assert.strictEqual(r.ok, false)
  assert.deepStrictEqual(r.conflits, ['2026-10-16', '2026-10-17'])
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. L'ENDPOINT DE MODIFICATION (PUT)
// ═══════════════════════════════════════════════════════════════════════════

test('PUT : passe par le verrou anti-surreservation, comme la creation', () => {
  // Un chemin de modification moins garde que la creation suffirait a la
  // contourner : creer sur des dates libres, puis deplacer sur des dates prises.
  assert.match(LIB, /async function modifierReservationDirecte/)
  const bloc = LIB.slice(LIB.indexOf('async function modifierReservationDirecte'))
  assert.ok(bloc.includes('poserVerrou'), 'verrou pose')
  assert.ok(bloc.includes('verifierDisponibilite'), 'disponibilite verifiee')
  assert.ok(bloc.includes('libererVerrou'), 'verrou libere')
  assert.ok(/finally\s*\{[\s\S]*libererVerrou/.test(bloc), 'libere meme en cas d\'echec')
})

test('PUT : la reservation est exclue d\'elle-meme, cœur ET intentions', () => {
  const bloc = LIB.slice(LIB.indexOf('async function modifierReservationDirecte'))
  assert.match(bloc, /exclure: String\(bookingId\)/)
  assert.match(bloc, /ignorerToken: String\(bookingId\)/)
})

test('PUT : l\'ecriture passe par la couche canal, jamais le provider en dur', () => {
  const bloc = LIB.slice(LIB.indexOf('async function modifierReservationDirecte'))
  assert.match(bloc, /getProvider\(dispo\.provider\)/)
  assert.match(bloc, /updateBooking/)
  assert.ok(!/channelCall|fetch\(/.test(bloc), 'aucun appel provider direct depuis le lib metier')
})

test('PUT : ne modifie QUE des reservations Offline, verifiees dans le cœur', () => {
  // Une resa OTA doit etre modifiee chez l'OTA. La verification porte sur le
  // cœur : un `offline: true` envoye par le front ne prouve rien.
  assert.match(API, /async function reservationOfflineDuCoeur/)
  assert.match(API, /source !== 'offline'/)
  const put = API.slice(API.indexOf("if (req.method === 'PUT')"))
  assert.ok(put.includes('reservationOfflineDuCoeur'), 'le PUT passe la verification')
})

test('PUT : le total est recalcule, jamais recu du client', () => {
  const put = API.slice(API.indexOf("if (req.method === 'PUT')"))
  assert.ok(!/\bamount\b\s*[,}]/.test(put.slice(0, put.indexOf('modifierReservationDirecte'))),
    '`amount` ne doit pas etre destructure du body')
  assert.ok(put.includes('repartirParNuit'), 'la repartition nuit par nuit est refaite')
  assert.ok(put.includes('amount: total'), 'seul le total recalcule part')
})

test('PUT : le plafond de voyageurs est REVERIFIE cote serveur', () => {
  const put = API.slice(API.indexOf("if (req.method === 'PUT')"))
  assert.ok(put.includes('occupationValidee'), 'meme garde qu\'a la creation')
  assert.ok(put.includes('bien.capacity'), 'le plafond vient du bien')
  // Et c'est l'occupation VALIDEE qui part au provider, pas l'objet du client.
  assert.match(put, /occupancy: \{ adults: occ\.adultes, children: occ\.enfants, infants: occ\.bebes \}/)
})

test('PUT : la garde de capacite est PARTAGEE avec la creation, pas recopiee', () => {
  // La recopier, c'est se donner deux endroits ou reperdre les cas fermes en
  // review (children negatifs, NaN, infants hors compte).
  assert.match(API, /function occupationValidee/)
  assert.strictEqual((API.match(/const entierPositif/g) || []).length, 1,
    'un seul exemplaire de la validation des compteurs')
})

test('PUT : le code OTA du sejour est CONSERVE, jamais regenere', () => {
  // C'est la cle de deduplication chez Channex : en generer un neuf ferait
  // entrer la modification dans le cœur comme une reservation supplementaire,
  // a cote de l'ancienne.
  const put = API.slice(API.indexOf("if (req.method === 'PUT')"))
  assert.match(put, /otaReservationCode: s\.otaReservationCode \|\| String\(bookingId\)/)
  assert.ok(!/HS-\$\{Date\.now\(\)\}/.test(put), 'pas de nouveau code a la modification')
})

test('PUT : un conflit de disponibilite rend 409, pas 400', () => {
  const put = API.slice(API.indexOf("if (req.method === 'PUT')"))
  assert.match(put, /nuits_completes/)
  assert.match(put, /409/)
})

test('PUT : les appels qui LEVENT sont entoures d\'un try', () => {
  // Sans try, l'hote recevrait un 500 sans corps JSON, donc une SyntaxError a
  // l'ecran — le front parse avant de tester `ok`.
  const put = API.slice(API.indexOf("if (req.method === 'PUT')"))
  assert.ok(/try \{[\s\S]*modifierReservationDirecte/.test(put))
  assert.ok(put.includes('bien_incomplet'), 'room type / rate plan verifies aussi')
})

test('PUT : le cœur n\'est jamais ecrit par l\'endpoint', () => {
  // La modification revient par le feed, comme la creation et comme toute
  // reservation OTA. Seule la LECTURE de verification touche bookings_snapshot.
  assert.ok(!/from\('bookings_snapshot'\)[\s\S]{0,200}(upsert|insert|update)\(/.test(API))
})

test('client : `modifier` existe et emploie la methode PUT', () => {
  assert.match(CLIENT, /modifier: \(payload\)\s*=> apiCall\('reservation-directe', 'PUT', payload\)/)
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. LES BULLES DE RESERVATION
// ═══════════════════════════════════════════════════════════════════════════

test('bulles : du MILIEU du jour d\'arrivee au MILIEU du jour de depart', () => {
  // RETARGE 13/10/2026 (V5). Ordinateur : left = (d + .5)/n, width = f - d
  // (f = index du checkout) ; telephone : demi-cases arrivee/depart.
  const css = lire('shared', 'ui.css')
  assert.match(css, /left: calc\(\(var\(--d\) \+ \.5\) \/ var\(--n\) \* 100%\)/)
  assert.match(PAGE, /commence \? 0\.5 : 0/)
  assert.match(PAGE, /finit \? 0\.5 : 1/)
})

test('bulles : un sejour DEJA COMMENCE reste visible', () => {
  // Chevauchement par DATES : couvrir toute la plage ne fait pas disparaitre.
  assert.match(PAGE, /if \(co <= etat\.joursISO\[0\] \|\| r\.startISO > etat\.joursISO\[etat\.joursISO\.length - 1\]\) return ''/)
})

test('bulles : le nom est tronque par le CSS, avec le nom complet en infobulle', () => {
  const css = lire('shared', 'ui.css')
  assert.match(css, /\.cal-barre \{[^}]*text-overflow: ellipsis/)
  assert.match(PAGE, /title="\$\{esc\(\(r\.name \|\| ''\)/)
})

test('bulles : colonne et bande partagent la MEME largeur de jour', () => {
  const css = lire('shared', 'ui.css')
  assert.match(css, /grid-auto-columns: 46px/)
  assert.match(css, /\.cal-table td, \.cal-table th \{ width: 46px/)
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. LA CONVERSATION DEPUIS LA FICHE
// ═══════════════════════════════════════════════════════════════════════════

test('conversation : le bouton existe et vise la messagerie par booking_id', () => {
  assert.match(PAGE, /\/api\/messages\?booking_id=/)
  assert.match(PAGE, /urlConversation\(bien, r\)/)
})

test('conversation : le bouton nait DESACTIVE et se resout a l\'ouverture', () => {
  assert.match(PAGE, /data-fiche-conv disabled/)
  assert.match(PAGE, /btn\.disabled = false/)
})

test('conversation : l\'existence du fil est lue UNE RESERVATION A LA FOIS', () => {
  // ⚠ REGRESSION FERMEE EN REVIEW. La premiere version demandait toute la
  // fenetre a api/calendar.js via `.in('booking_id', …)` sur `messages`. Deux
  // ruptures silencieuses : `messages` est un JOURNAL (une ligne par message),
  // donc le plafond de 1000 lignes de PostgREST tronquait le rendu SANS erreur
  // et des sejours revenaient « sans conversation » a tort ; et la liste
  // d'identifiants sur « 1 an » depassait la longueur d'URL admise en GET.
  assert.ok(!CAL.includes('has_conversation'), 'le calendrier ne calcule plus ce booleen')
  assert.ok(!CAL.includes("tousLesIds"), 'et n\'assemble plus de liste d\'identifiants')
  assert.ok(!/\.from\('messages'\)/.test(CAL), 'il ne lit plus la table des messages')
  // La lecture vit la ou la table est deja gardee, et elle est bornee.
  const bloc = MSGAPI.slice(MSGAPI.indexOf("req.query.booking_id"))
  assert.ok(bloc.includes(".eq('booking_id', bookingId)"), 'une seule reservation')
  assert.ok(bloc.includes('.limit(1)'), 'une seule ligne suffit a conclure')
  assert.ok(bloc.includes('.or(filtreOr)'), 'le perimetre par bien reste applique')
  assert.ok(bloc.includes(".eq('user_id', userId)"), 'et le compte cible aussi')
})

test('conversation : « je ne sais pas » n\'est jamais presente comme « aucun fil »', () => {
  assert.match(PAGE, /cal\.thread_unavailable/)
  assert.match(PAGE, /cal\.no_thread/)
})

test('messagerie : `?conv=` ouvre le fil demande par la fiche', () => {
  // L'integration fiche -> messagerie vit desormais dans /messages (etape 4) :
  // urlConversation pointe `?conv=` seul, et la page ouvre le fil s'il existe.
  assert.match(MSG, /params\.get\('conv'\)/)
  assert.ok(MSG.includes("etat.conversations.some(x => String(x.bookId) === String(demandee))"),
    'le fil demande n\'ouvre que s\'il existe — jamais un ecran « introuvable » depuis un lien interne (decision de l\'etape 1)')
})

test('messagerie : une PANNE de chargement est DITE, pas lue comme une absence de fil', () => {
  // La fiche n'envoie ici que si has_conversation a dit vrai : si la page
  // n'ouvre rien, c'est une panne — et elle s'affiche en toutes lettres.
  assert.ok(MSG.includes('etat.chargementOk = false'), 'le chargement en echec est memorise')
  assert.ok(MSG.includes("t('messages.load_error')"), 'et il se dit a l\'ecran')
})

test('messagerie : le lien de la fiche ne porte plus `?bien=`', () => {
  // /messages n'a pas de filtre par bien qui masquerait le fil : le parametre
  // est mort avec l'ancienne page (sa valeur inconnue vide:ait l'ecran).
  const module_ = lire('shared', 'calendrier-resa.js')
  assert.ok(module_.includes("'/messages?conv=' + encodeURIComponent(resa.id)"))
  assert.ok(!module_.includes('&bien='), 'plus de second parametre')
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. EDITION DIRECTE ET FERMETURE A LA VENTE
// ═══════════════════════════════════════════════════════════════════════════

test('fiche : l\'edition exige Offline + Channex + droit + pas lecture seule', () => {
  assert.match(PAGE, /droitsResa\(bien, r, peutEcrire\('reservations'\) && !etat\.lectureSeule\)/)
  assert.match(PAGE, /\$\{droits\.modifiable \?/)
})

test('fiche : une vente du MOTEUR PUBLIC n\'est pas modifiable depuis le planning', () => {
  // ⚠ « Offline » ne veut pas dire « saisie par l'hote » : le moteur de
  // reservation cree lui aussi des sejours `ota_name: "Offline"`, mais PAYES par
  // le voyageur. En deplacer dates ou prix depuis le planning ne declencherait ni
  // remboursement ni complement, et ne toucherait pas la ligne de vente.
  const bloc = PAGE.slice(PAGE.indexOf('function ouvrirFicheResa'), PAGE.indexOf('function blocConversation'))
  const regle = MODULE.slice(MODULE.indexOf('export function droitsResa'), MODULE.indexOf('export function sansMessagerieOta'))
  assert.ok(regle.includes("resa.metaSource === 'hotesmart-engine'"), 'la sous-origine est lue')
  assert.ok(regle.includes('!venteEnLigne'), 'et elle ferme l\'edition')
  assert.ok(bloc.includes('droitsResa('), 'et la page passe par cette regle')
  // Garde SERVEUR, la seule qui compte : une garde d'interface n'est pas une garde.
  const put = API.slice(API.indexOf("if (req.method === 'PUT')"))
  assert.match(put, /sousOrigine === 'hotesmart-engine'/)
  assert.match(put, /reservation_moteur/)
  // Et la sous-origine doit etre servie, sinon la fiche ne peut pas la connaitre.
  assert.match(CAL, /metaSource:raw->meta->>source/)
})

test('PUT : seul un sejour ACTIF se modifie — sinon il ressusciterait', () => {
  // ⚠ L'annulation est un PUT porteur de `status: 'cancelled'` ; la modification
  // est le MEME PUT sans ce champ. L'envoyer sur un sejour annule le remettrait
  // `confirmed` chez Channex et refermerait les nuits que l'hote vient de liberer.
  const put = API.slice(API.indexOf("if (req.method === 'PUT')"))
  assert.match(put, /!isActiveStatus\(s, 'channex'\)/)
  assert.match(put, /reservation_non_modifiable/)
  assert.match(API, /require\('\.\.\/lib\/bookings-snapshot-status'\)/)
})

test('PUT : le client et l\'heure d\'arrivee SURVIVENT a la modification', () => {
  // ⚠ `payloadCRS` reecrit `customer` en entier et met `null` a tout champ
  // absent. Le reconstruire depuis le snapshot resume (prenom + nom seulement)
  // effacait chez Channex le MAIL et le TELEPHONE du voyageur a chaque
  // correction de dates. `raw` porte le payload provider integral.
  const put = API.slice(API.indexOf("if (req.method === 'PUT')"))
  assert.ok(put.includes('lu.raw?.customer'), 'le client vient du payload integral')
  assert.match(put, /mail:\s+clientRaw\.mail/)
  assert.match(put, /phone:\s+clientRaw\.phone/)
  assert.match(put, /arrivalHour: s\.arrivalHour/)
  assert.ok(put.includes('lu.raw?.meta'), '`meta` est conserve, pas reecrit')
  assert.ok(!/meta: \{ source: 'hotesmart-manual' \},/.test(put),
    'plus d\'ecrasement inconditionnel de la sous-origine')
  assert.match(API, /avecRaw \? 'snapshot, raw' : 'snapshot'/, 'le payload brut est demande')
})

test('colonne `raw` absente : on DEGRADE, on ne tombe pas', () => {
  // ⚠ La colonne peut manquer — migration pas encore appliquee, ou cache de
  // schema PostgREST pas encore recharge apres l'avoir ete. `lib/bookings-snapshot.js`
  // defend deja ce cas A L'ECRITURE ; en faire dependre une LECTURE sans repli,
  // c'etait un calendrier a 500 sur un hoquet de cache, pour un simple confort
  // d'interface. Les deux nouveaux lecteurs de `raw` rejouent sans elle.
  assert.match(CAL, /colonneRawAbsente\(snapErr\)/)
  assert.match(CAL, /lireReservations\(false\)/)
  assert.match(API, /colonneRawAbsente\(error\)/)
  assert.match(API, /lire\(false\)/)
  // Et la garde qui compte ne depend pas d'elle : le refus « vente du moteur »
  // est SERVEUR, la sous-origine servie au front n'est qu'un confort.
  const put = API.slice(API.indexOf("if (req.method === 'PUT')"))
  assert.match(put, /reservation_moteur/)
})

test('PRIX : ne pas toucher au prix ne doit PAS repricer le sejour', () => {
  // ⚠ 100,00 sur 3 nuits : `amount / nuits` arrondi au centime donne
  // 33,33 x 3 = 99,99. Garde SERVEUR (inchangee par le retargage) :
  const put = API.slice(API.indexOf("if (req.method === 'PUT')"))
  assert.ok(put.includes('memeDuree'), 'le cas « meme duree » est distingue')
  assert.match(put, /totalActuelCents - base \* \(listeNuits\.length - 1\)/,
    'montant exact conserve, reliquat sur la derniere nuit')
  // Cote V5 : meme total a l'arrondi pres = prix OMIS du payload.
  assert.match(PAGE, /Math\.abs\(p \* r\.span - r\.amount\) < 0\.005/)
  assert.match(PAGE, /charge\.prixParNuit === undefined/)
})

test('fiche : une resa OTA garde une fiche en CONSULTATION seule', () => {
  assert.match(PAGE, /droits\.modifiable \? `<div class="msg-tiroir__bloc">/)
  assert.match(PAGE, /esc\(droits\.note \|\| ''\)/)
})

test('fiche : les champs demandes sont editables (dates, voyageurs, prix)', () => {
  for (const champ of ['data-f="arrivee"', 'data-f="depart"', 'data-f="adultes"', 'data-f="enfants"', 'data-f="prix"']) {
    assert.ok(PAGE.includes(champ), champ)
  }
})

test('fiche : l\'enregistrement passe par le PUT serveur, pas par une ecriture locale', () => {
  assert.match(PAGE, /fetch\('\/api\/reservation-directe', \{ method: 'PUT'/)
  assert.ok(!PAGE.includes('bookings_snapshot'), 'le coeur revient par le feed')
})

test('fiche : une modification vide ne part pas au canal', () => {
  assert.match(PAGE, /cal\.no_change/)
})

test('stop-sell : action directe depuis la selection, memes gardes que l\'ajout', () => {
  // La barre d'actions n'existe pas sans droit ; « Fermer » part en stop_sell.
  assert.match(PAGE, /if \(!jours\.length \|\| etat\.lectureSeule \|\| !peutEcrire\('reservations'\)\) \{ barre\.hidden = true/)
  assert.match(PAGE, /stop_sell: true/)
})

test('stop-sell : UI SEULEMENT — le chemin serveur est celui qui existe deja', () => {
  assert.match(PAGE, /appel\('\/api\/calendar', \{ action: 'save', property_id: bienId, segments/)
})

test('stop-sell : les jours contigus partent en PLAGES, pas un segment par jour', () => {
  assert.match(PAGE, /plagesContigues\(/)
  assert.match(PAGE, /date_from: p\[0\], date_to: p\[1\]/)
})

test('stop-sell : le libelle dit ce que le clic va faire', () => {
  // Fermer / Rouvrir selon l'etat REEL de la selection (cleInverse du contrat).
  assert.match(PAGE, /a\.id === 'fermer' && toutFerme \? a\.cleInverse : a\.cle/)
})

test('stop-sell : une nuit fermee se voit quelle que soit la VUE affichee', () => {
  // V5 : la couleur d'etat est posee sur la cellule INDEPENDAMMENT de la vue.
  assert.match(PAGE, /cal-nuit--\$\{e\}/)
  const css = lire('shared', 'ui.css')
  assert.match(css, /\.cal-nuit--fermee \{ background: repeating-linear-gradient/)
})

// ═══════════════════════════════════════════════════════════════════════════
// 5 bis. CE QUE LA SECONDE REVIEW A FERME
// ═══════════════════════════════════════════════════════════════════════════

test('perimetre : `.or()` n\'est pose QUE si le filtre existe', () => {
  // ⚠ REGRESSION FERMEE. `refsDuPerimetre` rend `null` — pas `''` — pour un
  // PROPRIETAIRE de compte (perimetre total), et `filtrePerimetreSql` propage ce
  // `null` : la garde `=== ''` ne l'attrape pas. Un `.or(null)` inconditionnel
  // part en `or=(null)`, que PostgREST refuse : l'endpoint rendait 500 pour le
  // cas NORMAL, et le bouton « Ouvrir la conversation » restait eteint pour tout
  // le monde. L'idiome correct est celui des deux requetes de la collection.
  const bloc = MSGAPI.slice(MSGAPI.indexOf('req.query.booking_id'))
  assert.match(bloc, /if \(filtreOr\) q = q\.or\(filtreOr\)/)
  assert.ok(!/\.eq\('booking_id', bookingId\)\s*\n\s*\.or\(filtreOr\)/.test(bloc),
    'plus de .or() inconditionnel dans la chaine')
})

test('perimetre : le filtre nul est bien le cas du proprietaire (non regresse)', () => {
  // Contre-epreuve reelle, pas une lecture de fichier : c'est la valeur rendue
  // qui a piege, pas le code qui l'appelle.
  const { refsDuPerimetre, filtrePerimetreSql } = require('../lib/permissions')
  const refs = refsDuPerimetre({ userId: 'u1', accountUserId: 'u1' })
  assert.strictEqual(refs, null, 'un proprietaire n\'a pas de perimetre restreint')
  assert.strictEqual(filtrePerimetreSql(refs), null, 'et le filtre SQL vaut null, pas \'\'')
})

test('refus : la PHRASE va dans `error`, le code dans `code`', () => {
  // Garde SERVEUR (inchangee par le retargage) : les refus metier portent
  // une phrase dans error, leur identifiant dans code, via le helper.
  assert.match(API, /function reponseRefus/)
  assert.match(API, /error: resultat\.message \|\| 'La demande a ete refusee\.'/)
  for (const code of ['reservation_ota', 'reservation_non_modifiable', 'reservation_moteur']) {
    assert.ok(!new RegExp(`error: '${code}'`).test(API), `${code} ne doit plus etre dans error`)
    assert.ok(API.includes(`code: '${code}'`), `${code} doit etre dans code`)
  }
  assert.ok(!/\.json\(resultat\)/.test(API), 'plus de resultat brut rendu au front')
  assert.strictEqual((API.match(/\.json\(reponseRefus\(resultat\)\)/g) || []).length, 2,
    'creation ET modification')
  // Cote V5 : le front construit son message depuis corps.message/error et
  // route par corps.code.
  assert.match(PAGE, /new Error\(corps\.message \|\| corps\.error/)
  assert.match(PAGE, /e\.code = corps\.code \|\| corps\.error/)
})

test('total : « inchange » n\'est affiche que si rien n\'a bouge', () => {
  assert.match(PAGE, /charge\.arrival === r\.startISO && charge\.departure === String\(r\.checkout\)\.slice\(0, 10\)/)
})

test('stop-sell : rouvrir releve AUSSI la disponibilite', () => {
  assert.match(PAGE, /stop_sell: false, avail: 1/)
})

test('stop-sell : « ferme » a UNE seule definition dans toute la page', () => {
  assert.match(PAGE, /function nuitFermee \(s\)/)
  assert.strictEqual((PAGE.match(/avail === 'closed' \|\| s\.stopSell === 'closed'/g) || []).length, 1)
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. LES WEEK-ENDS
// ═══════════════════════════════════════════════════════════════════════════

test('week-ends : fond de colonne ET en-tete distinct', () => {
  const css = lire('shared', 'ui.css')
  assert.match(css, /\.cal-we \{ background-color: color-mix/)
  assert.match(css, /\.cal-mois__jour\.cal-we \{[^}]*font-weight: var\(--fw-bold\)/)
})

test('week-ends : le marquage est pose par UN seul helper, partout', () => {
  assert.match(PAGE, /function classesWE \(jourSemaine\)/)
  assert.ok((PAGE.match(/classesWE\(/g) || []).length >= 4, 'bande, fond des resas, cellules, cases mobiles')
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. DESKTOP SEUL
// ═══════════════════════════════════════════════════════════════════════════

// ⚠ CE TEST FIGEAIT « le mobile n'a recu aucune de ces nouveautes » jusqu'au
// chantier calendrier mobile du 30 septembre 2026 : le telephone porte
// desormais la fiche, la modification et la saisie (`reservationDirecte`,
// `ouvrirFicheResa`), par le module commun. Restent propres a l'ordinateur la
// grille en barres, la fermeture a la vente d'un jour et ses identifiants de
// champs. Regle 17 : un test peut figer ce qu'on a decide de changer.
test('DESKTOP SEUL : ce que le telephone n\'a pas repris de la grille de l\'ordinateur', () => {
  for (const marqueur of ['barresResa', 'jour-ferme', 'btn-stop-sell', 'fiche-arrivee',
                          'resa-conversation']) {
    assert.ok(!MOBILE.includes(marqueur), `${marqueur} ne doit pas exister sur mobile`)
  }
})

test('DESKTOP SEUL : CELL_W n\'est consomme que par le desktop', () => {
  // Le mobile importe `loadCalendarData` uniquement : elargir la colonne du
  // planning ne doit pas pouvoir deplacer la grille mensuelle.
  assert.ok(!MOBILE.includes('CELL_W'))
})

// ─── Lot 4.6.2 : les fermetures de l'hote dans l'ecran ──────────────────────
// Dessin du 21 septembre 2026 (Thierry) : une fermeture est un objet manipule
// COMME UNE RESERVATION — creee par le parcours « nouvelle reservation » (type
// « indisponible »), affichee comme une barre FONCEE, modifiee a la main par
// l'hote seul, jamais scindee par le calendrier.

test('fermetures : le formulaire porte un type « Bloquer » avec dates et raison', () => {
  assert.match(PAGE, /cal\.type_block/)
  assert.match(PAGE, /data-aj="raison"/)
  assert.match(PAGE, /cal\.block_reason_required/)
})

test('fermetures : le parcours s ouvre sur TOUT bien ; la reservation directe reste Channex-only et le dit', () => {
  assert.match(PAGE, /\$\{channex \? '' : 'disabled'\}/)
  assert.match(PAGE, /cal\.booking_channex_only/)
  assert.match(PAGE, /typeCourant = channex \? type : 'bloquer'/)
})

test('fermetures : un blocage est une barre DISTINCTE, avec sa raison, de la premiere a la derniere nuit', () => {
  assert.match(PAGE, /cal-barre--blocage/)
  assert.match(PAGE, /esc\(f\.raison \|\| t\('cal\.blocked'\)\)/)
  assert.match(PAGE, /i1 < 0 \? etat\.joursISO\.length : i1 \+ 1/, 'date_fin INCLUSE')
})

test('LE TEST QUI COMPTE : la fiche de blocage modifie dates et raison, et supprime — par l hote seul', () => {
  assert.match(PAGE, /data-b="debut"/)
  assert.match(PAGE, /data-b="raison"/)
  assert.match(PAGE, /data-b-suppr/)
  assert.match(PAGE, /api\.calendar\.rouvrirFermeture\(bienId,/)
})

test('LE TEST QUI COMPTE : rouvrir une nuit couverte est REFUSE par l ecran, qui renvoie vers la fiche', () => {
  assert.match(PAGE, /cal\.blocked_reopen/)
  assert.match(PAGE, /ouvrirFicheBlocage\(bienId, String\(f\.id\)\)/)
})

test('fermetures : l ecran les affiche mais la VENDABILITE vient de calendar_inventory', () => {
  // nuitFermee lit inv (avail/stopSell) ; fermeeParBlocage ne sert qu'a
  // distinguer « fermee par l hote » de « pas encore ouverte ».
  assert.match(PAGE, /function nuitFermee \(s\)/)
  // `fermee` derive de nuitFermee(s) — l'etat d'inventaire — jamais des
  // fermetures (comportement, pas commentaire).
  assert.match(PAGE, /const fermee = nuitFermee\(s\)/)
})
