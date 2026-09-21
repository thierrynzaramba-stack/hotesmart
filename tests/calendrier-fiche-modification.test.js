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
const PAGE_BRUTE = lire('pages', 'biens-calendrier.html')
// On teste le CODE, pas les commentaires : ceux-ci citent volontiers ce qu'on a
// supprime (« l'ancien calcul (span-0.5) »), et les chercher dans le fichier
// brut ferait echouer un test sur sa propre documentation.
const sansCommentaires = (s) => s.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
const PAGE = sansCommentaires(PAGE_BRUTE)
const MOBILE = lire('pages', 'calendrier-mobile.html')
const CORE = lire('shared', 'calendar-core.js')
// Meme raison que pour PAGE : les commentaires de `api/calendar.js` expliquent
// ce qui a ete RETIRE (« un `.in('booking_id', tousLesIds)` »), et chercher ces
// chaines dans le fichier brut ferait echouer un test sur sa propre explication.
const CAL = sansCommentaires(lire('api', 'calendar.js'))
const API = lire('api', 'reservation-directe.js')
const LIB = lire('lib', 'reservation-directe.js')
const MSG = lire('apps', 'agent-ai', 'messagerie.html')
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
  // ⚠ REGRESSION FERMEE. L'ancien calcul `width:(span-0.5)*100%` avec
  // `left:50%` s'arretait a la FIN du dernier jour occupe, soit une
  // demi-cellule trop tot : la bulle ne touchait jamais le jour de depart, et
  // deux sejours qui s'enchainent laissaient un blanc la ou ils se croisent.
  assert.ok(!/\(bk\.span-0\.5\)\*100/.test(PAGE), 'l\'ancien calcul a disparu')
  assert.match(PAGE, /function barresResa/)
  const bloc = PAGE.slice(PAGE.indexOf('function barresResa'), PAGE.indexOf('function renderBienBlock'))
  assert.match(bloc, /iDebut\+0\.5/, 'demarre au milieu de la cellule d\'arrivee')
  assert.match(bloc, /iFin\+0\.5/, 'finit au milieu de la cellule de depart')
})

test('bulles : un sejour DEJA COMMENCE reste visible', () => {
  // ⚠ La grille demarre AUJOURD'HUI et l'ancien rendu ne dessinait la barre que
  // dans la cellule `startISO`. Un sejour commence hier n'avait donc aucune
  // cellule ou s'afficher : le planning montrait LIBRE la nuit ou quelqu'un dort.
  const bloc = PAGE.slice(PAGE.indexOf('function barresResa'), PAGE.indexOf('function renderBienBlock'))
  assert.ok(bloc.includes('bk.startISO<iso0'), 'le debordement a gauche est traite')
  assert.ok(bloc.includes('bk.checkout>isoN'), 'le debordement a droite aussi')
  assert.ok(bloc.includes('cont-left') && bloc.includes('cont-right'), 'bords droits quand le sejour est coupe')
  assert.match(PAGE, /\.resa-bar\.cont-left/, 'le style existe')
})

test('bulles : le nom est tronque par le CSS, avec le nom complet en infobulle', () => {
  // Une coupe a 16 caracteres ne sait rien de la largeur reelle : elle amputait
  // un nom long sur une bulle de dix nuits qui avait la place.
  assert.ok(!/bk\.name\.length>16/.test(PAGE), 'plus de troncature a l\'aveugle')
  assert.match(PAGE, /\.resa-bar \.nom \{[^}]*text-overflow: ellipsis/)
  assert.match(PAGE, /\.resa-bar \.nom \{[^}]*min-width: 0/,
    'sans min-width:0, un enfant flex ne retrecit pas et l\'ellipse ne se declenche jamais')
  assert.match(PAGE, /title="'\+escapeHtmlLocal\(bk\.name/, 'nom complet en infobulle, echappe')
  assert.match(PAGE, /const nameShort=escapeHtmlLocal\(/, 'le libelle reste echappe')
})

test('bulles : colonne elargie et ligne plus haute, de facon coherente', () => {
  // La largeur de colonne vit a DEUX endroits : le CSS qui la dessine et CELL_W
  // qui compte les jours. Les laisser diverger produit une barre de defilement
  // la ou le remplissage devait tomber juste.
  assert.match(CORE, /export const CELL_W = 46/)
  assert.match(PAGE, /table\.cal th, table\.cal td \{[^}]*width: 46px/)
  assert.ok(!/const COLW = 34/.test(CORE), 'plus de copie en dur du pas de colonne')
  assert.match(CORE, /const COLW = CELL_W/)
  assert.match(PAGE, /\.resa-cell \{[^}]*height: 36px/)
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. LA CONVERSATION DEPUIS LA FICHE
// ═══════════════════════════════════════════════════════════════════════════

test('conversation : le bouton existe et vise la messagerie par booking_id', () => {
  assert.match(PAGE, /id="resa-conversation"/)
  assert.match(PAGE, /Ouvrir la conversation/)
  assert.match(PAGE, /messagerie\?conv=' \+ encodeURIComponent\(resa\.id\)/)
})

test('conversation : le bouton nait DESACTIVE et se resout a l\'ouverture', () => {
  // Naitre actif puis s'eteindre ferait rater un clic parti trop tot vers une
  // page vide.
  const bloc = PAGE.slice(PAGE.indexOf('function blocConversation'), PAGE.indexOf('async function resoudreConversation'))
  assert.ok(bloc.includes('disabled'), 'desactive a la construction')
  assert.ok(bloc.includes('Recherche du fil'), 'et il le dit')
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
  // Un echec de lecture ne doit pas affirmer au sujet du voyageur quelque chose
  // qu'on n'a pas pu regarder.
  const bloc = PAGE.slice(PAGE.indexOf('async function resoudreConversation'), PAGE.indexOf('function champsModifiables'))
  assert.ok(bloc.includes('Fil indisponible'), 'l\'echec a son propre message')
  assert.ok(bloc.includes('resaCourante.resa.id'), 'une reponse tardive ne repeint pas une autre fiche')
})

test('messagerie : `?conv=` ouvre le fil, et n\'est consommee qu\'UNE fois', () => {
  // Sans cela, chaque rafraichissement ramenerait l'hote de force sur la
  // conversation d'origine, y compris apres qu'il en a ouvert une autre.
  assert.match(MSG, /URLSearchParams\(location\.search\)\.get\('conv'\)/)
  assert.match(MSG, /function ouvrirConversationDemandee/)
  const bloc = MSG.slice(MSG.indexOf('function ouvrirConversationDemandee'), MSG.indexOf('window.loadConversations ='))
  assert.ok(bloc.includes('convDemandee = null'), 'la cible est consommee')
  assert.ok(bloc.includes('introuvable'), 'un fil absent est DIT, pas ignore')
})

test('messagerie : une PANNE de chargement ne se dit pas « conversation introuvable »', () => {
  // ⚠ Les deux chemins de chargement rattrapent leur propre erreur pour peindre
  // le panneau de gauche : la promesse tient donc meme quand /api/messages est
  // tombe, et `conversations` reste vide. Sans drapeau, l'hote lisait que le fil
  // n'existe pas — et la cible etait consommee, donc un rechargement reussi ne
  // l'ouvrait plus.
  const bloc = MSG.slice(MSG.indexOf('function ouvrirConversationDemandee'), MSG.indexOf('window.loadConversations ='))
  assert.ok(bloc.includes('if (!charge) return'), 'on ne conclut rien sans chargement reussi')
  assert.ok(bloc.indexOf('if (!charge) return') < bloc.indexOf('convDemandee = null'),
    'et la cible n\'est pas consommee avant d\'avoir pu conclure')
  // Les deux chemins rendent bien le drapeau.
  assert.strictEqual((MSG.match(/\n      return true\n/g) || []).length, 2, 'succes des deux chemins')
  assert.strictEqual((MSG.match(/\n      return false\n/g) || []).length, 2, 'echec des deux chemins')
})

test('messagerie : `?bien=` n\'est applique que si le bien existe', () => {
  // Une valeur inconnue viderait l'ecran par un filtre qui ne correspond a rien.
  assert.match(MSG, /window\._props\.some\(p => String\(p\.provider_property_id\) === String\(bienDemande\)\)/)
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. EDITION DIRECTE ET FERMETURE A LA VENTE
// ═══════════════════════════════════════════════════════════════════════════

test('fiche : l\'edition exige Offline + Channex + droit + pas lecture seule', () => {
  const bloc = PAGE.slice(PAGE.indexOf('function ouvrirFicheResa'), PAGE.indexOf('function blocConversation'))
  assert.ok(bloc.includes('resa.offline'), 'reserve aux reservations directes')
  assert.ok(bloc.includes('channex'), 'reserve aux biens Channex')
  assert.ok(bloc.includes("peutEcrire('reservations')"), 'exige le droit')
  assert.ok(bloc.includes('LECTURE_SEULE'), 'exclut la lecture seule')
  assert.ok(bloc.includes('champsModifiables'), 'les champs ne sortent que dans ce cas')
})

test('fiche : une vente du MOTEUR PUBLIC n\'est pas modifiable depuis le planning', () => {
  // ⚠ « Offline » ne veut pas dire « saisie par l'hote » : le moteur de
  // reservation cree lui aussi des sejours `ota_name: "Offline"`, mais PAYES par
  // le voyageur. En deplacer dates ou prix depuis le planning ne declencherait ni
  // remboursement ni complement, et ne toucherait pas la ligne de vente.
  const bloc = PAGE.slice(PAGE.indexOf('function ouvrirFicheResa'), PAGE.indexOf('function blocConversation'))
  assert.ok(bloc.includes("resa.metaSource === 'hotesmart-engine'"), 'la sous-origine est lue')
  assert.ok(bloc.includes('!venteEnLigne'), 'et elle ferme l\'edition')
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
  // 33,33 x 3 = 99,99 ; sur 7 nuits, 14,29 x 7 = 100,03. Un hote qui ne corrige
  // que le nombre de voyageurs changeait ainsi le prix de vente sans le savoir.
  const put = API.slice(API.indexOf("if (req.method === 'PUT')"))
  assert.ok(put.includes('memeDuree'), 'le cas « meme duree » est distingue')
  assert.match(put, /totalActuelCents - base \* \(listeNuits\.length - 1\)/,
    'montant exact conserve, reliquat sur la derniere nuit')
  // Cote front : champ vide = prix inchange, et il n'est alors PAS envoye.
  const envoi = PAGE.slice(PAGE.indexOf('async function enregistrerResaCourante'), PAGE.indexOf('function showToast'))
  assert.ok(envoi.includes('prixTouche'), 'le front distingue « vide » de « zero »')
  assert.ok(envoi.includes('if(prixTouche) charge.prixParNuit = prix'),
    'un prix non touche n\'est pas transmis')
  // Et le champ n'est pas pre-rempli avec le prix de base quand le montant est inconnu.
  const form = PAGE.slice(PAGE.indexOf('function champsModifiables'), PAGE.indexOf('function rafraichirFiche'))
  assert.ok(form.includes('montantConnu'), 'prix inconnu = champ vide, pas le prix de base du bien')
})

test('fiche : une resa OTA garde une fiche en CONSULTATION seule', () => {
  const bloc = PAGE.slice(PAGE.indexOf('function ouvrirFicheResa'), PAGE.indexOf('function blocConversation'))
  assert.ok(bloc.includes('ligneFiche(\'Arrivée\''), 'les dates restent du texte hors Offline')
  assert.match(PAGE, /modifiable uniquement chez/)
})

test('fiche : les trois champs demandes sont editables', () => {
  // Dates, prix vendu et nombre de voyageurs. Les champs sont construits par le
  // helper `champ(id, …)` : on verifie les identifiants qu'il recoit, et qu'ils
  // sont tous les cinq relus a l'enregistrement.
  const form = PAGE.slice(PAGE.indexOf('function champsModifiables'), PAGE.indexOf('function rafraichirFiche'))
  for (const id of ['fiche-arrivee', 'fiche-depart', 'fiche-prix', 'fiche-adultes', 'fiche-enfants']) {
    assert.ok(form.includes(`'${id}'`), `${id} doit etre rendu`)
  }
  const envoi = PAGE.slice(PAGE.indexOf('async function enregistrerResaCourante'), PAGE.indexOf('function showToast'))
  for (const id of ['fiche-arrivee', 'fiche-depart', 'fiche-prix', 'fiche-adultes', 'fiche-enfants']) {
    assert.ok(envoi.includes(`'${id}'`), `${id} doit etre relu a l'enregistrement`)
  }
  assert.match(form, /type="'\+type\+'"/, 'le type du champ vient du helper (date, number)')
  assert.match(form, /champ\('fiche-arrivee','Arrivée','date'/, 'les dates sont de vrais champs date')
  assert.match(form, /champ\('fiche-prix','Prix par nuit','number'/)
})

test('fiche : l\'enregistrement passe par updateBooking, pas par une ecriture locale', () => {
  const bloc = PAGE.slice(PAGE.indexOf('async function enregistrerResaCourante'), PAGE.indexOf('function showToast'))
  assert.ok(bloc.includes('api.reservationDirecte.modifier'), 'passe par l\'endpoint garde')
  assert.ok(bloc.includes('prochain rafraîchissement'),
    'la resa revient par le feed : on n\'affirme pas qu\'elle est deja a jour')
  assert.ok(!bloc.includes('bookings_snapshot'), 'aucune ecriture directe du cœur')
})

test('fiche : une modification vide ne part pas au canal', () => {
  const bloc = PAGE.slice(PAGE.indexOf('async function enregistrerResaCourante'), PAGE.indexOf('function showToast'))
  assert.ok(bloc.includes('Aucune modification'))
})

test('stop-sell : action directe depuis la selection, memes gardes que l\'ajout', () => {
  assert.match(PAGE, /id="btn-stop-sell"/)
  const bloc = PAGE.slice(PAGE.indexOf('async function basculerStopSell'))
  assert.ok(bloc.includes("peutEcrire('reservations')"))
  assert.ok(bloc.includes('LECTURE_SEULE'))
})

test('stop-sell : UI SEULEMENT — le chemin serveur est celui qui existe deja', () => {
  // ⚠ `stop_sell` est une INTENTION memorisee dans calendar_inventory
  // (docs/kb/reservation-directe.md §8). Ce bouton ne doit rien reinventer :
  // il envoie les memes segments que la rubrique « Stop vente » de la popup.
  const bloc = PAGE.slice(PAGE.indexOf('async function basculerStopSell'))
  assert.ok(bloc.includes('api.calendar.save'), 'meme endpoint que la popup')
  assert.match(bloc, /stop_sell: fermer/)
  assert.ok(!bloc.includes('channel-'), 'aucun appel provider depuis la page')
})

test('stop-sell : les jours contigus partent en PLAGES, pas un segment par jour', () => {
  // Sur un mois entier, c'est la difference entre un appel et trente.
  const bloc = PAGE.slice(PAGE.indexOf('async function basculerStopSell'))
  assert.ok(bloc.includes('plages.push'), 'regroupement en plages contigues')
  assert.match(bloc, /date_from: toISO\(days\[a\]\), date_to: toISO\(days\[b\]\)/)
})

test('stop-sell : le libelle dit ce que le clic va faire', () => {
  assert.match(PAGE, /function selectionToutFermee/)
  assert.match(PAGE, /selectionToutFermee\(\) \? 'Rouvrir à la vente' : 'Fermer à la vente'/)
})

test('stop-sell : les jours fermes se voient sur TOUTES les lignes du bien', () => {
  // Un bien ferme ne doit pas se lire comme un bien simplement vide.
  assert.match(PAGE, /table\.cal td\.jour-ferme, table\.cal th\.jour-ferme/)
  assert.match(PAGE, /repeating-linear-gradient/)
  const bloc = PAGE.slice(PAGE.indexOf('function renderBienBlock'), PAGE.indexOf('let isDragging'))
  assert.strictEqual((bloc.match(/jour-ferme/g) || []).length, 3,
    'en-tete, ligne reservations et lignes de parametres')
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
  // `shared/api-client.js` construit son exception avec `data.error` seul.
  // Un code technique dans `error` affichait « reservation_moteur » a l'hote.
  assert.match(API, /function reponseRefus/)
  assert.match(API, /error: resultat\.message \|\| 'La demande a ete refusee\.'/)
  // Les trois refus metier portent une phrase, pas un identifiant.
  for (const code of ['reservation_ota', 'reservation_non_modifiable', 'reservation_moteur']) {
    assert.ok(!new RegExp(`error: '${code}'`).test(API), `${code} ne doit plus etre dans error`)
    assert.ok(API.includes(`code: '${code}'`), `${code} doit etre dans code`)
  }
  // Et les deux 409 passent par le helper, plus par `resultat` brut.
  assert.ok(!/\.json\(resultat\)/.test(API), 'plus de resultat brut rendu au front')
  assert.strictEqual((API.match(/\.json\(reponseRefus\(resultat\)\)/g) || []).length, 2,
    'creation ET modification')
  // Cote fiche, un 409 se lit dans les mots du metier.
  const envoi = PAGE.slice(PAGE.indexOf('async function enregistrerResaCourante'), PAGE.indexOf('function showToast'))
  assert.ok(envoi.includes('e.status===409'), 'le refus metier est distingue de la panne')
})

test('total : « inchangé » n\'est affiche que si la DUREE n\'a pas bouge', () => {
  // ⚠ Le serveur ne conserve le montant exact que si `memeDuree`. Afficher
  // « 300 € (inchangé, 5 nuits) » a un hote qui allonge un sejour de 3 nuits
  // mentait : 500 € partaient chez Channex et seraient factures au voyageur.
  const bloc = PAGE.slice(PAGE.indexOf('function rafraichirFiche'), PAGE.indexOf('async function enregistrerResaCourante'))
  assert.ok(bloc.includes('nOrig'), 'la duree d\'origine est calculee')
  assert.ok(bloc.includes('n===nOrig'), 'et comparee a la nouvelle')
  assert.ok(bloc.includes('au tarif actuel de'), 'sinon le total recalcule est annonce')
})

test('stop-sell : rouvrir releve AUSSI la disponibilite', () => {
  // ⚠ « Disponibilité → Fermé » ecrit `avail = 0` ET `stop_sell = true`. Ne
  // renvoyer que `stop_sell: false` laissait `avail = 0` : la relecture ramenait
  // la cellule en rouge apres un toast « Rouvert à la vente ». Le jour restait
  // invendable alors qu'on avait dit le contraire.
  const bloc = PAGE.slice(PAGE.indexOf('async function basculerStopSell'))
  assert.ok(bloc.includes('if(!fermer) seg.avail = 1'), 'la reouverture releve le stock')
  assert.ok(!/seg\.avail = 0/.test(bloc),
    'la fermeture, elle, ne touche pas au stock : stop_sell est l\'intention memorisee')
})

test('stop-sell : « fermé » a UNE seule definition dans toute la page', () => {
  // Les hachures ne regardaient que `stopSell` pendant que la cellule rouge du
  // tarif regardait les deux : un jour ferme par « Disponibilité » sortait rouge
  // mais sans hachures, et le bouton proposait « Fermer » sur un jour deja ferme.
  assert.match(PAGE, /const jourFerme = \(s\) =>/, 'une definition unique')
  assert.strictEqual((PAGE.match(/jourFerme\(/g) || []).length, 3,
    'ses trois usages : hachures, cellule tarif, libelle du bouton')
  assert.ok(!/s\.avail==='closed'\|\|s\.stopSell==='closed'/.test(PAGE), 'plus de predicat recopie')
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. LES WEEK-ENDS
// ═══════════════════════════════════════════════════════════════════════════

test('week-ends : fond de colonne franc ET en-tete distinct', () => {
  // Depuis le 21 septembre 2026, l'en-tete des jours vit dans la bande
  // (`tr.jours`), plus dans le thead de chaque bien : l'ancre suit.
  // L'ancien rgba(0,0,0,0.022) etait invisible au-dela de quelques colonnes.
  assert.ok(!/\.weekend \{ background: rgba\(0,0,0,0\.022\)/.test(PAGE), 'l\'ancien fond a disparu')
  assert.match(PAGE, /table\.cal \.weekend \{ background: #eef1f6/)
  assert.match(PAGE, /tr\.jours td\.weekend \.day-name \{[^}]*font-weight: 700/)
  assert.match(PAGE, /tr\.jours td\.weekend \.day-num\s+\{[^}]*font-weight: 700/)
})

test('week-ends : le marquage est pose par UN seul helper, pour les trois lignes', () => {
  // Les trois rendus recopiaient le calcul : un marquage ajoute a l'un manquait
  // aux deux autres et la colonne se lisait de travers.
  assert.match(PAGE, /function classesJour/)
  assert.ok(!/const we=d\.getDay\(\)===0\|\|d\.getDay\(\)===6/.test(PAGE), 'plus de calcul recopie')
  const bloc = PAGE.slice(PAGE.indexOf('function renderBienBlock'), PAGE.indexOf('let isDragging'))
  assert.strictEqual((bloc.match(/classesJour\(/g) || []).length, 3)
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. DESKTOP SEUL
// ═══════════════════════════════════════════════════════════════════════════

test('DESKTOP SEUL : le mobile n\'a recu aucune de ces nouveautes', () => {
  // Contrainte du chantier, et prolongement de la decision « desktop d'abord ».
  for (const marqueur of ['barresResa', 'jour-ferme', 'btn-stop-sell', 'fiche-arrivee',
                          'resa-conversation', 'reservationDirecte', 'ouvrirFicheResa']) {
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

test('fermetures : le parcours « nouvelle reservation » porte un type « indisponible » avec dates et raison', () => {
  assert.match(PAGE, /<input type="radio" name="ajout-type" value="reservation" id="ajout-type-resa">/)
  assert.match(PAGE, /<input type="radio" name="ajout-type" value="indisponible" id="ajout-type-indispo">/)
  assert.match(PAGE, /<input id="ajout-raison" type="text" maxlength="200"/)
  const valider = PAGE.slice(PAGE.indexOf('async function validerIndisponibilite'), PAGE.indexOf('async function validerAjout'))
  assert.ok(valider.includes('api.calendar.fermer(bien.id, b.arrival, derniereNuit, raison)'), 'un seul chemin serveur : l action fermer')
  assert.ok(valider.includes('toISO(days[tries[tries.length-1]])'), 'la derniere NUIT, pas le jour de depart')
  assert.ok(!valider.includes('api.calendar.save('), 'jamais un stop_sell nu')
  assert.match(PAGE, /if\(typeAjout\(\)==='indisponible'\) return validerIndisponibilite\(b, bien\)/)
})

test('fermetures : le parcours s ouvre sur TOUT bien ; la reservation directe reste Channex-only et le dit', () => {
  assert.match(PAGE, /const okAjout = !!\(bien && peutEcrire\('reservations'\) && !LECTURE_SEULE\)/)
  const ouvrir = PAGE.slice(PAGE.indexOf('function ouvrirFormulaireAjout(mode)'), PAGE.indexOf('function fermerFormulaireAjout'))
  assert.ok(ouvrir.includes('rResa.disabled = !channex'))
  assert.ok(ouvrir.includes("(typeof mode==='string') ? mode : (channex ? 'reservation' : 'indisponible')"))
})

test('fermetures : une INDISPONIBILITE est une barre FONCEE, avec sa raison, de la premiere a la derniere nuit', () => {
  assert.match(PAGE, /\.resa-bar\.fermeture \{ background: #3a3a3c/, 'anthracite, hors de la palette des canaux')
  const barres = PAGE.slice(PAGE.indexOf('function barresResa'), PAGE.indexOf('const jourFerme'))
  assert.ok(barres.includes("'<div class=\"resa-bar fermeture cliquable'"), 'une barre, cliquable')
  assert.ok(barres.includes('escapeHtmlLocal(f.raison)'), 'la raison, echappee')
  assert.ok(barres.includes('px(iFin+1-iDebut)'), 'bornes incluses : pas de demi-cellule d arrivee')
  // ⚠ `px` vit en tete de barresResa, AVANT les deux boucles (review : declare
  // dans la boucle des reservations, il etait hors de portee des fermetures et
  // un ReferenceError faisait tomber tout le rendu).
  const iPx = barres.indexOf('const px=(n)=>(n*CELL_W)'), iFerm = barres.indexOf("(fermByBien[bien.id]||[]).forEach"), iResa = barres.indexOf('(bien.resa||[]).forEach')
  assert.ok(iPx > 0 && iPx < iFerm && iPx < iResa, 'px declare avant les deux boucles')
  assert.equal(barres.split('const px=').length, 2, 'une seule declaration de px')
  assert.ok(iFerm < iResa, 'les fermetures se dessinent AVANT les reservations : la demi-cellule de depart d un sejour reste lisible')
  assert.ok(PAGE.includes('if(bar.dataset.fermeture) ouvrirFicheFermeture(bar.dataset.bien, bar.dataset.fermeture)'), 'le clic ouvre SA fiche')
  assert.ok(!PAGE.includes('fermetures-liste'), 'plus de liste sous la grille')
})

test('LE TEST QUI COMPTE : la fiche modifie dates et raison par l action dediee, et supprime — a la main, par l hote seul', () => {
  const fiche = PAGE.slice(PAGE.indexOf('function ouvrirFicheFermeture'), PAGE.indexOf('async function basculerStopSell'))
  assert.ok(fiche.includes("const modifiable = peutEcrire('reservations') && !LECTURE_SEULE"))
  assert.ok(fiche.includes("champ('ferm-debut','Première nuit','date',f.date_debut)") && fiche.includes("champ('ferm-raison','Raison','text',f.raison"))
  assert.ok(fiche.includes('api.calendar.modifierFermeture(bien.id, f.id, debut, fin, raison)'))
  assert.ok(fiche.includes('api.calendar.rouvrirFermeture(bien.id, f.id)') && fiche.includes('window.confirm('), 'supprimer previent que toute la periode rouvre')
  assert.ok(!PAGE.includes('window.prompt('), 'plus de prompt')
  assert.match(PAGE, /function fermerFiche\(\)\{[^\n]*resaCourante=null; fermetureCourante=null/, 'fermer la fiche oublie les deux objets')
  // Le libelle du bouton suit le type, APRES la reinitialisation du formulaire.
  const ouvrir = PAGE.slice(PAGE.indexOf('function ouvrirFormulaireAjout(mode)'), PAGE.indexOf('function fermerFormulaireAjout'))
  assert.ok(!/btnV\.textContent = 'Créer la réservation'/.test(ouvrir), 'plus d ecrasement du libelle')
  assert.ok(ouvrir.lastIndexOf('appliquerTypeAjout()') > ouvrir.indexOf('btnV.disabled = false'))
})

test('LE TEST QUI COMPTE : rouvrir une nuit couverte est REFUSE par l ecran, qui renvoie vers la fiche — plus de scission', () => {
  const bloc = PAGE.slice(PAGE.indexOf('async function basculerStopSell'))
  assert.ok(bloc.includes("if(fermer && estPiloteYield(bienId)){ ouvrirFormulaireAjout('indisponible'); return }"), 'fermer un bien pilote = le parcours, pre-rempli')
  assert.ok(bloc.includes('const f=fermetureCouvrant(bienId, toISO(days[i])); if(f){'), 'chaque nuit selectionnee est verifiee')
  assert.ok(bloc.includes('ouvrirFicheFermeture(bienId, f.id); return'), 'renvoi vers la fiche, sans ecrire')
  assert.ok(!/scind/i.test(PAGE), 'le mot meme a disparu de la page')
  // Sur un bien calendrier, fermer reste un stop_sell nu (inchange).
  const apres = bloc.slice(bloc.indexOf("ouvrirFormulaireAjout('indisponible'); return }"))
  assert.ok(apres.includes('api.calendar.save') && /stop_sell: fermer/.test(apres))
})

test('fermetures : l ecran les affiche mais ne les lit JAMAIS pour dire si une nuit est vendable', () => {
  assert.ok(PAGE.includes('fermByBien[id]=(fermetures&&fermetures[id])||[]'), 'rangees a la relecture, par bien')
  const jf = PAGE.slice(PAGE.indexOf('function jourFerme'), PAGE.indexOf('function jourFerme') + 400)
  assert.ok(!jf.includes('fermByBien'), 'jourFerme ne lit pas les fermetures')
  assert.ok(PAGE.includes("title=\"Fermé : '+echapper(rs)"), 'la raison est un TITRE sur le jour, pas une decision')
})
