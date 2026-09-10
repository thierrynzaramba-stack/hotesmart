// tests/cles-migrees.test.js
// LE DEFAUT : le cron rapatriait les donnees d'un bien migre, et lui envoyait
// des messages.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const lire = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

const { clesMigrees, estCleMigree, noterCleMigree, _vider } = require('../lib/cles-migrees')

// Faux client : `.from().select().eq().eq()` rend `data`/`error`, et enregistre
// les filtres pour qu'on puisse verifier le cloisonnement.
function faux ({ data = [], error = null, erreurUpsert = null } = {}) {
  const journal = { filtres: [], upserts: [], lectures: 0 }
  const chaine = {
    select () { journal.lectures++; return chaine },
    eq (c, v) { journal.filtres.push([c, v]); return Promise.resolve({ data, error }).then ? Object.assign(Promise.resolve({ data, error }), chaine) : chaine },
    upsert (row, opts) { journal.upserts.push({ row, opts }); return Promise.resolve({ error: erreurUpsert }) }
  }
  // `.eq().eq()` doit etre chainable ET awaitable : on rend un thenable.
  const faireEq = () => {
    const p = Promise.resolve({ data, error })
    p.eq = (c, v) => { journal.filtres.push([c, v]); return faireEq() }
    p.select = () => { journal.lectures++; return faireEq() }
    p.upsert = (row, opts) => { journal.upserts.push({ row, opts }); return Promise.resolve({ error: erreurUpsert }) }
    return p
  }
  return { from () { return faireEq() }, journal }
}

test('LE TEST QUI COMPTE : une cle migree est reconnue, et le filtre est CLOISONNE PAR COMPTE', async () => {
  // ⚠ `provider_property_id` N'A AUCUNE UNICITE GLOBALE. Deux hotes d'un meme
  // property manager Beds24 partagent l'espace de numerotation. Filtrer sur la
  // seule cle aurait coupe la synchro du bien `209413` d'un AUTRE hote le jour
  // ou celui-ci migre le sien. C'est la raison d'etre de la table.
  _vider()
  const sb = faux({ data: [{ provider_property_id: '209413' }] })
  assert.equal(await estCleMigree(sb, 'hote-A', '209413', 'beds24'), true)
  assert.equal(await estCleMigree(sb, 'hote-A', '169567', 'beds24'), false)

  const filtres = sb.journal.filtres
  assert.ok(filtres.some(([c, v]) => c === 'user_id' && v === 'hote-A'), 'filtre par compte')
  assert.ok(filtres.some(([c, v]) => c === 'provider' && v === 'beds24'), 'et par provider')
})

test('LE TEST QUI COMPTE : un echec de lecture retombe OUVERT, pas ferme', async () => {
  // ⚠ FERMER SUR UN ECHEC ARRETERAIT LA SYNCHRO DE TOUS LES BIENS DE TOUS LES
  // HOTES des que cette table devient illisible — une panne locale devenue
  // panne generale, pour une table vide chez 99 % des comptes.
  // Le risque du repli ouvert est borne : le seul degat serait un message
  // renvoye, et l'empreinte de sejour (`message_sent_log.stay_key`) le
  // reconnait meme sous un nouvel identifiant de reservation.
  _vider()
  const sb = faux({ data: null, error: { message: 'table absente' } })
  assert.equal(await estCleMigree(sb, 'hote-A', '209413', 'beds24'), false,
    'sur echec, la cle n est PAS consideree migree : le cron continue')
  // Et l'echec n'est pas mis en cache : le cycle suivant retente.
  const sb2 = faux({ data: [{ provider_property_id: '209413' }] })
  assert.equal(await estCleMigree(sb2, 'hote-A', '209413', 'beds24'), true,
    'un echec ne gele pas la reponse pour 60 s')
})

test('clesMigrees : sans supabase ou sans compte, ensemble vide et aucune lecture', async () => {
  _vider()
  assert.equal((await clesMigrees(null, 'hote-A')).size, 0)
  const sb = faux({ data: [{ provider_property_id: 'x' }] })
  assert.equal((await clesMigrees(sb, null)).size, 0)
  assert.equal(sb.journal.lectures, 0, 'aucun aller-retour inutile')
})

test('noterCleMigree : upsert idempotent sur la cle composite, et vide le cache', async () => {
  _vider()
  const sb = faux({ data: [] })
  // Avant : pas migree (et donc mise en cache).
  assert.equal(await estCleMigree(sb, 'hote-A', '209413'), false)
  await noterCleMigree(sb, { userId: 'hote-A', provider: 'beds24', propId: 209413, cibleFiche: 'uuid-cible' })
  const u = sb.journal.upserts[0]
  assert.equal(u.opts.onConflict, 'user_id,provider,provider_property_id')
  assert.equal(u.row.provider_property_id, '209413', 'la cle est ecrite en TEXTE')
  assert.equal(u.row.target_property_id, 'uuid-cible')

  // ⚠ LE CACHE DOIT ETRE VIDE PAR L'ECRITURE. Sinon la cle fraichement
  // enregistree resterait « non migree » pendant 60 s — soit un cycle de cron
  // entier a rapatrier les donnees qu'on vient de deplacer. C'est exactement
  // la fenetre qui a produit le defaut.
  const sb2 = faux({ data: [{ provider_property_id: '209413' }] })
  assert.equal(await estCleMigree(sb2, 'hote-A', '209413'), true)
})

test('noterCleMigree : refuse un appel incomplet plutot que d ecrire un demi-enregistrement', async () => {
  const sb = faux({})
  for (const args of [
    { provider: 'beds24', propId: '1' },
    { userId: 'a', propId: '1' },
    { userId: 'a', provider: 'beds24' }
  ]) {
    await assert.rejects(() => noterCleMigree(sb, args), /userId, provider et propId requis/)
  }
  assert.equal(sb.journal.upserts.length, 0)
})

test('LE TEST QUI COMPTE : les TROIS portes du cron sont gardees, pas seulement la materialisation', () => {
  // ⚠ CORRIGER LA SEULE MATERIALISATION NE SUFFISAIT PAS, ET C'EST MESURE.
  // `api/cron.js` boucle sur la liste LIVE du compte Beds24 et appelle, pour
  // chaque bien : materializeBeds24Properties, detectBookingChanges (qui ecrit
  // bookings_snapshot) et processMessageTemplates (qui ENVOIE au voyageur).
  // Garder la premiere aurait arrete la recreation de la fiche, pendant que
  // les sejours revenaient sous l'ancienne cle et que les messages partaient
  // en double.
  const cron = lire('api/cron.js')
  for (const appel of ['materializeBeds24Properties', 'detectBookingChanges', 'processMessageTemplates']) {
    assert.ok(cron.includes(appel), `${appel} est bien appele par le cron`)
  }
  // La boucle lit Beds24, PAS `properties` : supprimer la fiche ne protege rien.
  assert.ok(/fetchProperties\(beds24Key\)/.test(cron),
    'la liste des biens vient de Beds24, donc la garde ne peut pas etre dans properties')

  assert.ok(lire('lib/cron-beds24-props.js').includes("clesMigrees(supabase, userId, 'beds24')"),
    'materialisation gardee')
  assert.ok(lire('lib/cron-bookings.js').includes("estCleMigree(supabase, userId, property.id, 'beds24')"),
    'writer de snapshots garde')
  assert.ok(lire('lib/cron-messages.js').includes("estCleMigree(supabase, userId, property.id, 'beds24')"),
    'envoi de messages garde')
})

test('LE TEST QUI COMPTE : la garde des messages precede le kill switch, donc rien ne peut la contourner', () => {
  // Si elle venait apres, un bien migre mais NON en pause enverrait quand meme.
  const src = lire('lib/cron-messages.js')
  const i = src.indexOf('async function processMessageTemplates')
  const bloc = src.slice(i, i + 2200)
  assert.ok(bloc.indexOf('estCleMigree') < bloc.indexOf('isAutomationPaused'),
    'la garde de cle migree est la premiere sortie de la fonction')
})

test('LE TEST QUI COMPTE : la materialisation n IGNORE pas en silence', () => {
  // ⚠ `clesMigrees` retombe volontairement OUVERT sur un echec de lecture. Un
  // filtre muet aurait rendu « aucun bien migre » indiscernable de « la lecture
  // a echoue » — et c'est ce genre de silence qui a laisse le defaut ouvert.
  const src = lire('lib/cron-beds24-props.js')
  assert.ok(src.includes('bien(s) migre(s) ignore(s)'), 'le compte des ignores est journalise')
  assert.ok(src.includes('results.beds24MigratedSkipped'), 'et rendu dans le bilan du cron')
})
