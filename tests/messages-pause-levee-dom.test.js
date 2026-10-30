// tests/messages-pause-levee-dom.test.js
// LA RECETTE DU 30 OCTOBRE 2026, REJOUEE DANS UN VRAI DOM. Deux constats, et
// l'hypothese de Thierry etait juste jusqu'au mecanisme :
//
//   « La proposition etait deja echue avec 1 h, donc le changement de delai ne
//     libere rien de neuf. Le vrai geste qui libere, c'est la levee de la
//     pause, et il ne demande rien. »
//
// ⚠ CE QUE LA MESURE SUR STAGING A AJOUTE. Le panneau POSE bien la question —
// mais il la SAUTE sur un bien qu'il sait en pause (`enPauseSure`), au motif
// que rien ne peut partir de la. C'est vrai TANT QUE LA PAUSE TIENT. Et
// l'enregistrement, lui, REARME quand meme : la proposition « cuisine » du
// 28 octobre est passee a `created_at + 15 min` — donc deja echue — a
// 18:58:14, sans un mot, et `properties.paused_at` porte 18:58:42. Elle
// attendait la levee pour partir, et la levee ne demandait rien.
//
// ⚠ ET LE SECOND CONSTAT EST LE MIEN AUSSI : mon garde-fou du 28 octobre ne
// repointe le panneau que si le tiroir etait FERME, pour qu'un choix fait au
// selecteur tienne contre une bascule de volet. Changer de FIL n'etait pas
// couvert — l'hote reglait le delai d'un AUTRE logement que celui qu'il lisait.

const test = require('node:test')
const assert = require('node:assert/strict')
const B = require('./outils/banc-messages.js')

const REF = 'STG-BIEN-3'      // Loft Pilotable
const AUTRE = 'STG-BIEN-2'    // Maison Jardin
const FR = B.FR

// Un bien EN PAUSE, en mode auto a 15 min, avec des propositions echues.
// `appel` repond l'apercu et garde tout ce qui part au serveur.
function bancEnPause ({ echues = 2, confirme = true, apercuKo = false, desarmes = 2 } = {}) {
  const envois = []
  const b = B.monter({
    confirme,
    appel: async (chemin, charge) => {
      envois.push({ chemin, charge: charge || null })
      if (chemin === '/api/property-automation') {
        // La relecture : la pause telle qu'elle est APRES l'ecriture.
        if (!charge) return { paused: { [REF]: false } }
        return {}
      }
      if (chemin === '/api/agent-config') {
        if (charge && charge.apercu === true) {
          return apercuKo
            ? { delais_ref: charge.delais_ref, apercu: { ok: false, motif: 'lecture_impossible' } }
            : { delais_ref: charge.delais_ref, apercu: { ok: true, motif: 'delai', echues } }
        }
        return { delais_ref: charge && charge.delais_ref,
          brouillons: { ok: true, motif: 'delai', desarmes, rearmes: 0, inchanges: 0,
            deja_prises: 0, echues, sans_creation: 0 } }
      }
      return {}
    }
  })
  B.peupler(b, {
    biens: [{ ref: REF, nom: 'Loft Pilotable' }],
    config: { [REF]: { mode: 'auto', delais: { reponse_ia: 15, alerte_info: 0 } } },
    pauses: { [REF]: true }
  })
  return { b, envois }
}

const versPropertyAutomation = (envois) =>
  envois.filter(e => e.chemin === '/api/property-automation' && e.charge)

test('LE TEST QUI COMPTE : lever la pause DEMANDE, quand des propositions sont echues', async () => {
  const { b, envois } = bancEnPause({ echues: 2 })
  B.changer(b, B.casePause(b), false)
  await B.reposer(b)
  // La PHRASE que l'hote lit, avec son nombre : une question qui ne dirait pas
  // ce qui part ne serait pas la garde de Thierry.
  assert.deepEqual(b.confirmations,
    [FR['messages.pause_lever_confirm'].replace('{n}', '2')])
  // Confirmee, la pause est bien levee.
  const ecrits = versPropertyAutomation(envois)
  assert.equal(ecrits.length, 1, 'une seule ecriture de pause')
  assert.equal(ecrits[0].charge.paused, false, 'et elle LEVE la pause')
  b.fermer()
})

test('LE TEST QUI COMPTE : refuser laisse la PAUSE ACTIVE et desarme les propositions', async () => {
  // ⚠ C'EST LA DECISION DE THIERRY, MOT POUR MOT : « si je ne reponds pas, la
  // pause reste active ». `window.confirm` n'a que deux issues : Echap tombe
  // donc sur la branche prudente, celle-ci.
  const { b, envois } = bancEnPause({ echues: 3, confirme: false, desarmes: 3 })
  B.changer(b, B.casePause(b), false)
  await B.reposer(b)
  assert.equal(b.confirmations.length, 1, 'la question a bien ete posee')
  assert.equal(versPropertyAutomation(envois).length, 0,
    'AUCUNE ecriture de pause : la pause reste active')
  // Et la branche ECRIT, sinon ce n'est pas une confirmation (lecon du 29
  // octobre : un « Annuler » qui ne change rien laissait partir).
  const garder = envois.filter(e => e.chemin === '/api/agent-config'
    && e.charge && e.charge.garder === true)
  assert.equal(garder.length, 1, 'les propositions annoncees sont desarmees')
  assert.equal(garder[0].charge.delais_ref, REF, 'sur le bien de la pause')
  assert.equal(garder[0].charge.apercu, undefined, 'et ce n est plus un apercu')
  // L'ecran le dit, en vert, avec le compte rendu par le SERVEUR.
  const note = b.doc.querySelector('[data-bind="tiroir-note"]')
  assert.equal(note.hidden, false)
  assert.equal(note.textContent, FR['messages.pause_gardees'].replace('{n}', '3'))
  // Et la case revient a la verite : la pause tient.
  assert.equal(B.casePause(b).checked, true, 'la case montre la pause encore active')
  b.fermer()
})

test('sans proposition echue, lever la pause ne demande rien', async () => {
  const { b, envois } = bancEnPause({ echues: 0 })
  B.changer(b, B.casePause(b), false)
  await B.reposer(b)
  assert.deepEqual(b.confirmations, [], 'aucune question : rien ne peut partir')
  assert.equal(versPropertyAutomation(envois)[0].charge.paused, false, 'la pause est levee')
  b.fermer()
})

test('un apercu impossible laisse la PAUSE ACTIVE, et le dit', async () => {
  // ⚠ NE PAS SAVOIR COMBIEN PARTIRAIENT N'AUTORISE PAS A LES LIBERER : c'est la
  // discipline de 4.6.6, et la cible est le telephone d'un voyageur.
  const { b, envois } = bancEnPause({ apercuKo: true })
  B.changer(b, B.casePause(b), false)
  await B.reposer(b)
  assert.deepEqual(b.confirmations, [], 'on ne demande pas ce qu on ne sait pas compter')
  assert.equal(versPropertyAutomation(envois).length, 0, 'la pause reste active')
  const note = b.doc.querySelector('[data-bind="tiroir-note"]')
  assert.equal(note.textContent, FR['messages.pause_apercu_ko'])
  assert.equal(B.casePause(b).checked, true)
  b.fermer()
})

test('METTRE en pause ne demande jamais rien : couper l automatique est un geste d urgence', async () => {
  const envois = []
  const b = B.monter({ appel: async (chemin, charge) => {
    envois.push({ chemin, charge: charge || null })
    if (chemin === '/api/property-automation' && !charge) return { paused: { [REF]: true } }
    return {}
  } })
  B.peupler(b, {
    biens: [{ ref: REF, nom: 'Loft Pilotable' }],
    config: { [REF]: { mode: 'auto', delais: { reponse_ia: 15, alerte_info: 0 } } },
    pauses: { [REF]: false }
  })
  B.changer(b, B.casePause(b), true)
  await B.reposer(b)
  assert.deepEqual(b.confirmations, [])
  assert.equal(envois.filter(e => e.chemin === '/api/agent-config').length, 0,
    'et aucun apercu : on ne fait pas d aller-retour pour couper')
  assert.equal(versPropertyAutomation(envois)[0].charge.paused, true)
  b.fermer()
})

// ── Constat 2 : le panneau suit le logement du fil ────────────────────────

const dans = (jours) => new Date(Date.now() + jours * 86400000).toISOString().slice(0, 10)

function bancDeuxFils () {
  const b = B.monter({ appel: async () => ({}) })
  B.peupler(b, {
    biens: [{ ref: AUTRE, nom: 'Maison Jardin' }, { ref: REF, nom: 'Loft Pilotable' }],
    config: {
      [AUTRE]: { mode: 'test', delais: { reponse_ia: null, alerte_info: 0 } },
      [REF]: { mode: 'auto', delais: { reponse_ia: 15, alerte_info: 0 } }
    },
    conversations: [
      // ⚠ DATES RELATIVES : ce test LIT l horloge (la liste « a traiter » ne
      // garde que les sejours a venir ou en cours), il n injecte rien. Regle du
      // depot — une date figee ici rougirait le jour ou elle serait passee.
      { bookId: 'B-JARDIN', propertyId: AUTRE, guestName: 'Jardin', lastNight: dans(2), messages: [] },
      { bookId: 'B-LOFT', propertyId: REF, guestName: 'Loft', lastNight: dans(2), messages: [] }
    ],
    ouverte: 'B-JARDIN'
  })
  // La liste n est pas peinte par `peupler` : c est elle qui porte les lignes
  // cliquables, et c est le geste reel de l hote.
  b.msg.renderListe()
  return b
}

test('LE TEST QUI COMPTE : ouvrir un autre fil REPOINTE le panneau deja ouvert', async () => {
  const b = bancDeuxFils()
  assert.equal(B.tiroirOuvert(b), true, 'le panneau est ouvert')
  assert.equal(b.msg.etat.tiroirBien, AUTRE, 'il part sur le bien du fil ouvert')
  // Le geste REEL : cliquer la ligne de l autre fil dans la liste.
  const ligne = b.doc.querySelector('[data-conv="B-LOFT"]')
  assert.ok(ligne, 'la ligne du fil est rendue')
  B.clic(b, ligne)
  await B.reposer(b)
  assert.equal(b.msg.etat.ouverte, 'B-LOFT', 'le fil a bien change')
  assert.equal(b.msg.etat.tiroirBien, REF,
    'et le panneau suit : plus de reglage applique au mauvais logement')
  // Le selecteur le montre, parce que c est lui que l hote lit.
  assert.equal(B.selBien(b).value, REF)
  b.fermer()
})

test('et il le DIT quand une saisie non enregistree est abandonnee', async () => {
  const b = bancDeuxFils()
  // L hote tape un delai sur Maison Jardin, sans enregistrer.
  b.msg.delaisEnCours(AUTRE).alerte_info = 120
  B.clic(b, b.doc.querySelector('[data-conv="B-LOFT"]'))
  await B.reposer(b)
  assert.equal(b.msg.etat.tiroirBien, REF, 'le panneau suit quand meme')
  const note = b.doc.querySelector('[data-bind="tiroir-note"]')
  assert.equal(note.hidden, false, 'une perte silencieuse serait la dette D4 elargie')
  assert.equal(note.textContent,
    FR['messages.panneau_suit_le_fil'].replace('{nom}', 'Maison Jardin'))
  b.fermer()
})

test('un panneau FERME n est pas repointe par un changement de fil', async () => {
  const b = bancDeuxFils()
  b.msg.ouvrirTiroir(false)
  b.msg.etat.tiroirBien = AUTRE
  B.clic(b, b.doc.querySelector('[data-conv="B-LOFT"]'))
  await B.reposer(b)
  // Rien a repointer : la preselection de `ouvrirTiroir` fera le travail a
  // l ouverture, et elle seule.
  assert.equal(b.msg.etat.tiroirBien, AUTRE)
  b.msg.ouvrirTiroir(true)
  assert.equal(b.msg.etat.tiroirBien, REF, 'a l ouverture, il part sur le bien du fil')
  b.fermer()
})
