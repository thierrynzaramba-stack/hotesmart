// tests/calendrier-mobile-parite.test.js — chantier « calendrier mobile »
// (30 septembre 2026) : le telephone rattrape l'ordinateur, par UNE regle
// commune (shared/calendrier-resa.js).
//
// CE QU'ILS DEFENDENT, dans l'ordre d'importance :
//   1. la couleur d'une reservation vient de SA source, jamais d'un tirage
//      (`SRC[idx % 3]` faisait afficher une reservation Booking en rouge Airbnb
//      sur le telephone) ;
//   2. les deux ecrans suivent la MEME regle : aucun ne redefinit la famille de
//      source, la transformation des reservations ni le droit de modifier ;
//   3. « modifiable » = les quatre conditions de l'ordinateur ; une resa OTA ou
//      une vente du moteur reste en consultation, et la note dit pourquoi ;
//   4. le telephone porte la fiche, « Écrire au voyageur », l'ajout
//      (Réservation / Indisponible), la modification et les indisponibilites,
//      par les memes appels serveur que l'ordinateur.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const RACINE = path.join(__dirname, '..')
const lire = f => fs.readFileSync(path.join(RACINE, f), 'utf8')
const sansCommentaires = s => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
// Le VRAI module, execute (pas une copie) : une adresse data: se lit en module ES.
const charger = () => import('data:text/javascript,' + encodeURIComponent(lire('shared/calendrier-resa.js')))

test('LE TEST QUI COMPTE : la couleur vient de la source de CHAQUE reservation — jamais d un tirage par position', async () => {
  const M = await charger()
  const r = M.mapResa([
    { booking_id: 'B1', checkin: '2026-10-01', checkout: '2026-10-03', source: 'Booking.com', guest_name: 'Ana', status: 'confirmed' },
    { booking_id: 'B2', checkin: '2026-10-05', checkout: '2026-10-06', source: 'Booking.com', guest_name: 'Léo', status: 'confirmed' },
    { booking_id: 'A1', checkin: '2026-10-07', checkout: '2026-10-09', source: 'AirBNB', guest_name: 'Zoé', status: 'confirmed' },
    { booking_id: 'O1', checkin: '2026-10-10', checkout: '2026-10-12', source: 'Offline', guest_name: 'Max', status: 'confirmed' },
    { booking_id: 'X1', checkin: '2026-10-13', checkout: '2026-10-14', source: 'Booking.com', status: 'cancelled' },
    { booking_id: 'X2', checkin: '2026-10-15', checkout: '2026-10-16', source: 'AirBNB', status: 'demapped' }])
  assert.deepEqual(r.map(x => [x.id, x.source, x.color, x.offline]),
    [['B1', 'booking', 'blue', false], ['B2', 'booking', 'blue', false], ['A1', 'airbnb', 'red', false], ['O1', 'direct', 'green', true]])
  assert.deepEqual([r[0].startISO, r[0].checkout, r[0].span, r[0].name], ['2026-10-01', '2026-10-03', 2, 'Ana'])
})

test('LE TEST QUI COMPTE : le telephone ne tire plus la source au sort, et lit les reservations par le module commun', () => {
  const m = sansCommentaires(lire('pages/calendrier-mobile.html'))
  assert.ok(!/SRC\s*\[\s*idx\s*%\s*3\s*\]/.test(m), 'plus de SRC[idx % 3] dans le code')
  assert.ok(!/platformLogo/.test(m), 'plus de logo de plateforme dans la bulle (comme l ordinateur)')
  assert.match(m, /import \{[^}]*\bmapResa\b[^}]*\} from '\/shared\/calendrier-resa\.js'/)
  assert.match(m, /resaList=mapResa\(/)
  assert.match(m, /bar\.className='resa-bar '\+rz\.source/)
})

test('LE TEST QUI COMPTE : les deux ecrans suivent la MEME regle — aucun ne la redefinit', () => {
  for (const f of ['pages/biens-calendrier.html', 'pages/calendrier-mobile.html']) {
    const s = sansCommentaires(lire(f))
    assert.match(s, /from '\/shared\/calendrier-resa\.js'/, `${f} importe le module commun`)
    for (const def of [/function familleSource\s*\(/, /function mapResa\s*\(/, /function sansMessagerieOta\s*\(/, /function estOffline\s*\(/, /COLORS_BY_SOURCE\s*=/, /LIBELLE_CANAL\s*=/]) {
      assert.ok(!def.test(s), `${f} redefinit ${def}`)
    }
    assert.match(s, /droitsResa\(/, `${f} juge « modifiable » par droitsResa`)
    assert.match(s, /urlConversation\(/, `${f} ouvre la messagerie par urlConversation`)
  }
})

test('LE TEST QUI COMPTE : modifiable = reservation directe, bien relie, pas une vente du moteur, droit d ecriture — et la note dit pourquoi sinon', async () => {
  const M = await charger()
  const channex = { provider: 'channex', provider_property_id: 'P1' }
  const directe = { offline: true, source: 'direct', sourceBrute: 'Offline', metaSource: null }
  assert.equal(M.droitsResa(channex, directe, true).modifiable, true)
  assert.equal(M.droitsResa(channex, directe, false).modifiable, false)
  assert.equal(M.droitsResa(channex, directe, false).note, 'Réservation directe — vous n\'avez pas le droit de la modifier.')
  const moteur = { ...directe, metaSource: 'hotesmart-engine' }
  assert.equal(M.droitsResa(channex, moteur, true).modifiable, false)
  assert.match(M.droitsResa(channex, moteur, true).note, /payée en ligne/)
  const ota = { offline: false, source: 'airbnb', sourceBrute: 'AirBNB' }
  assert.deepEqual([M.droitsResa(channex, ota, true).modifiable, M.droitsResa(channex, ota, true).note],
    [false, 'Réservation venue de Airbnb : modifiable uniquement chez Airbnb.'])
  assert.equal(M.droitsResa({ provider: 'beds24' }, directe, true).modifiable, false)
})

test('module : messagerie, capacite, e-mail manquant', async () => {
  const M = await charger()
  assert.equal(M.urlConversation({ provider_property_id: 'P 1' }, { id: 'B/1' }), '/apps/agent-ai/messagerie?conv=B%2F1&bien=P%201')
  assert.equal(M.messageCapacite(0, 0, 4), 'Il faut au moins un adulte.')
  assert.equal(M.messageCapacite(3, 2, 4), 'Ce bien accueille 4 personnes au maximum — vous en avez saisi 5.')
  assert.equal(M.messageCapacite(2, 2, 4), null)
  // Le statut s'affiche en francais sur la fiche (apercu du 1er octobre : « confirmed »).
  assert.equal(M.libelleStatut('confirmed'), 'Confirmée')
  assert.equal(M.libelleStatut('MODIFIED'), 'Modifiée')
  assert.equal(M.libelleStatut('etrange'), 'etrange')
  assert.equal(M.libelleStatut(null), null)
  assert.equal(M.badgeSansEmailVisible({ offline: true, aEmail: false }), true)
  assert.equal(M.badgeSansEmailVisible({ offline: false, sourceBrute: 'AirBNB', aEmail: false }), false, 'une resa Airbnb passe par la messagerie OTA')
})

test('LE TEST QUI COMPTE : le telephone porte la fiche, « Écrire au voyageur », l ajout, la modification et les indisponibilites — par les memes appels que l ordinateur', () => {
  const m = sansCommentaires(lire('pages/calendrier-mobile.html'))
  const d = sansCommentaires(lire('pages/biens-calendrier.html'))
  for (const appel of ['api.messages.aUneConversation(', 'api.reservationDirecte.creer(', 'api.reservationDirecte.modifier(', 'api.reservationDirecte.annuler(',
    'api.calendar.fermer(', 'api.calendar.modifierFermeture(', 'api.calendar.rouvrirFermeture(']) {
    assert.ok(d.includes(appel), `l ordinateur appelle ${appel}`)
    assert.ok(m.includes(appel), `le telephone appelle ${appel}`)
  }
  assert.match(m, /Écrire au voyageur/)
  assert.match(m, /id="aj-type-resa"[\s\S]*Réservation[\s\S]*id="aj-type-indispo"[\s\S]*Indisponible/)
  assert.match(m, /ouvrirFicheResa\(rz\.id\)/, 'le tap sur une bulle ouvre sa fiche')
  assert.match(m, /ouvrirFicheFermeture\(f\.id\)/, 'le tap sur une indisponibilite ouvre sa fiche')
  assert.match(m, /pointer-events: auto/, 'les bulles se touchent')
  assert.match(m, /if\(!peutEcrire\('reservations'\)\)\{ document\.getElementById\('btn-ajout'\)\.style\.display='none'/, 'lecture seule : pas de +')
})
