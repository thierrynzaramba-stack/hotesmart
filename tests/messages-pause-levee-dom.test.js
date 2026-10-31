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
function bancEnPause ({ echues = 2, confirme = true, apercuKo = false, desarmes = 2,
  dejaPrises = 0, configFraiche = undefined, delai = 15, bloquerApercu = false } = {}) {
  const envois = []
  let debloquer = null
  // La config telle que le serveur la rend. `configFraiche` permet a un test de
  // faire DIVERGER la relecture de ce que la page avait au demarrage.
  const config = { [REF]: { mode: 'auto', delais: { reponse_ia: delai, alerte_info: 0 } } }
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
        // ⚠ LA BRANCHE « GARDER » RELIT LA CONFIG AVANT D ECRIRE (constat d une
        // revue : la cible `delais` remplace le bloc ENTIER, donc ecrire un
        // instantane vieux de l ouverture de la page ressuscitait un delai
        // perime). Le double rend donc ce que rend le vrai GET.
        if (!charge) return { config: configFraiche === undefined ? config : configFraiche }
        if (charge.apercu === true) {
          if (bloquerApercu) await new Promise(r => { debloquer = r })
          return apercuKo
            ? { delais_ref: charge.delais_ref, apercu: { ok: false, motif: 'lecture_impossible' } }
            : { delais_ref: charge.delais_ref, apercu: { ok: true, motif: 'delai', echues } }
        }
        return { delais_ref: charge && charge.delais_ref,
          brouillons: { ok: true, motif: 'delai', desarmes, rearmes: 0, inchanges: 0,
            deja_prises: dejaPrises, echues, sans_creation: 0 } }
      }
      return {}
    }
  })
  B.peupler(b, { biens: [{ ref: REF, nom: 'Loft Pilotable' }], config, pauses: { [REF]: true } })
  return { b, envois, liberer: () => { if (debloquer) debloquer() } }
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

// ── Les huit constats de la revue de beee2ea0, mesures ────────────────────

test('LE TEST QUI COMPTE : le panneau est GELE pendant l apercu de la levee', async () => {
  // ⚠ CONSTAT MESURE D UNE REVUE. Avant ce correctif, `basculerPause` posait
  // `modeEnCours` PUIS `renderTiroir()` avant tout appel ; mon bloc d apercu
  // attendait sans ce rendu, donc `modeEnCours === true` avec la case et
  // « Enregistrer » encore ARMES. L hote qui re-cochait la pause pendant le vol
  // etait refuse par une note transitoire, l appel en cours levait la pause
  // quand meme — l etat final etait l inverse de son dernier geste — et le
  // refus posait `etat.pauseRefusee`, que le prochain enregistrement affichait
  // EN ROUGE alors que tout avait reussi.
  const { b, liberer } = bancEnPause({ bloquerApercu: true })
  B.changer(b, B.casePause(b), false)
  await new Promise(r => setTimeout(r, 0))
  try {
    assert.equal(b.msg.etat.modeEnCours, true, 'une ecriture est en vol')
    assert.equal(B.casePause(b).disabled, true, 'la case est desarmee des le premier instant')
    assert.equal(B.boutonSave(b).disabled, true, '« Enregistrer » aussi')
  } finally { liberer(); await B.reposer(b); b.fermer() }
})

test('LE TEST QUI COMPTE : un clic sur un autre fil ne repointe PAS pendant une ecriture', async () => {
  // ⚠ CONSTAT MESURE D UNE REVUE. `remettreCasePause(ref)` ecrit dans le tiroir
  // COURANT avec la reference capturee a l entree de `basculerPause` : si le
  // panneau a ete repointe pendant le vol, on ecrivait l etat de pause du bien
  // d AVANT dans le panneau du bien d APRES — case « en pause » cochee et note
  // parlant d un autre logement.
  const { b, liberer } = bancEnPause({ bloquerApercu: true })
  b.msg.etat.biens.set(AUTRE, { name: 'Maison Jardin', photo: null })
  b.msg.etat.conversations = [{ bookId: 'B-AUTRE', propertyId: AUTRE, guestName: 'Jardin',
    lastNight: dans(2), messages: [] }]
  B.changer(b, B.casePause(b), false)
  await new Promise(r => setTimeout(r, 0))
  try {
    b.msg.etat.ouverte = 'B-AUTRE'
    b.msg.reporterLePanneauSurLeFil()
    assert.equal(b.msg.etat.tiroirBien, REF,
      'le panneau attend la fin du geste : il ne suit pas le fil pendant une ecriture')
  } finally { liberer(); await B.reposer(b); b.fermer() }
})

test('LE TEST QUI COMPTE : la branche « garder » RELIT la config avant d ecrire', async () => {
  // ⚠ CONSTAT D UNE REVUE. La cible `delais` REMPLACE le bloc entier cote
  // serveur. `avant.delais` venait de `etat.configIA`, charge au demarrage :
  // si le delai avait change ailleurs (autre onglet, telephone), ANNULER
  // reecrivait l ancienne valeur en silence — et avec `propager: true`, les
  // brouillons NON echus etaient rearmes a `created_at + N` avec ce N perime.
  const { b, envois } = bancEnPause({
    echues: 1, confirme: false, desarmes: 1,
    // Le serveur a 240 ; la page, elle, a encore 15 au demarrage.
    configFraiche: { [REF]: { mode: 'auto', delais: { reponse_ia: 240, alerte_info: 0 } } }
  })
  assert.equal(b.msg.delaisDuBien(REF).reponse_ia, 15, 'la page part de la valeur perimee')
  B.changer(b, B.casePause(b), false)
  await B.reposer(b)
  const ecrit = envois.find(e => e.chemin === '/api/agent-config' && e.charge && e.charge.garder === true)
  assert.ok(ecrit, 'la branche ecrit bien')
  assert.equal(ecrit.charge.delais.reponse_ia, 240,
    'et elle ecrit la valeur RELUE, pas l instantane du demarrage')
  b.fermer()
})

test('relecture impossible : on n ecrit pas, et la pause reste active', async () => {
  const { b, envois } = bancEnPause({ echues: 1, confirme: false, configFraiche: null })
  B.changer(b, B.casePause(b), false)
  await B.reposer(b)
  assert.equal(envois.filter(e => e.chemin === '/api/agent-config'
    && e.charge && e.charge.garder === true).length, 0, 'aucune ecriture a l aveugle')
  assert.equal(versPropertyAutomation(envois).length, 0, 'et la pause tient')
  const note = b.doc.querySelector('[data-bind="tiroir-note"]')
  assert.equal(note.textContent, FR['messages.pause_gardees_ko'])
  b.fermer()
})

test('LE TEST QUI COMPTE : ce qui a ECHAPPE pendant le dialogue se dit', async () => {
  // ⚠ CONSTAT D UNE REVUE : mon commentaire promettait la comparaison, le code
  // ne comparait rien. `deja_prises` est la course LECTURE -> UPDATE ; l ecart
  // annonce/garde est la course LARGE, celle qui dure tout le temps du
  // dialogue. Dans les deux cas une reponse est PARTIE au voyageur, et une note
  // joyeuse serait un mensonge.
  const { b } = bancEnPause({ echues: 5, confirme: false, desarmes: 2, dejaPrises: 1 })
  B.changer(b, B.casePause(b), false)
  await B.reposer(b)
  const note = b.doc.querySelector('[data-bind="tiroir-note"]')
  assert.match(note.textContent, /2/, 'le nombre reellement garde')
  assert.match(note.textContent, new RegExp(FR['messages.partie_deja_prises'].replace('{n}', '1')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'une tache prise par l envoi est annoncee')
  assert.match(note.textContent, new RegExp(FR['messages.partie_envolees'].replace('{n}', '2')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'et les annoncees qui ne sont plus en attente')
  // ⚠ ET LA NOTE N EST PAS VERTE : ce n est pas un succes complet.
  assert.equal(note.classList.contains('msg-tiroir__note--ok'), false)
  b.fermer()
})

test('LE TEST QUI COMPTE : la question ne PROMET pas un depart, elle annonce une borne', () => {
  // ⚠ CONSTAT D UNE REVUE, ET C EST UN DEFAUT DEJA CORRIGE AILLEURS. Le nombre
  // vient du meme `apercu.echues` que la question du panneau, et
  // `lib/guestflow/appliquer-delai.js` l ecrit noir sur blanc : « POURRAIENT
  // partir, jamais partiront — le rendre assertif le 29 octobre etait un
  // defaut ». `encoreLegitime` rejoue onze motifs de refus que ce compte ne
  // connait pas, donc il sur-compte par construction.
  for (const lg of ['fr', 'en', 'es']) {
    const d = JSON.parse(require('fs').readFileSync(
      require('path').join(__dirname, '..', 'shared', 'i18n', lg + '.json'), 'utf8'))
    const q = d['messages.pause_lever_confirm']
    assert.ok(q, lg + ' porte la question')
    // ⚠ ON MESURE LA PROMESSE, PAS LE MOT. « elles ne partiront que sur votre
    // clic » est une NEGATION, et c'est exactement ce qu'on veut lire : ma
    // premiere version de ce test interdisait le mot « partiront » et rougissait
    // donc sur la phrase juste.
    for (const promesse of [/partiront sans attendre/i, /will send .* straight away/i,
      /saldrán de inmediato/i]) {
      assert.doesNotMatch(q, promesse, lg + ' : la question PROMET un depart')
    }
    const prudent = /pourraient|could|podrían/i.test(q)
    assert.ok(prudent, lg + ' : la question doit dire que le nombre est une borne')
  }
})

test('LE TEST QUI COMPTE : une consigne non enregistree ne disparait pas en silence', async () => {
  // ⚠ CONSTAT MESURE D UNE REVUE, et ma note promettait plus que le code ne
  // faisait. Les destinataires d alerte et les consignes IA ne vivent NULLE
  // PART dans l etat : `renderTiroir` fait `corps.innerHTML = voletIA(ref)`,
  // donc un repointage les efface. Comparer les seuls DELAIS laissait
  // disparaitre sans un mot une consigne par bien et une adresse d alerte — et
  // la consigne GLOBALE est partagee par tous les biens, donc elle etait jetee
  // meme quand le delai n avait pas bouge.
  const b = bancDeuxFils()
  const champ = B.corps(b).querySelector('[data-consignes="bien"]')
  assert.ok(champ, 'le champ des consignes du bien est rendu')
  champ.value = 'Ne jamais donner le code avant 15 h'
  assert.equal(b.msg.editionPanneauNonEnregistree(), 'Maison Jardin',
    'la saisie est vue, meme si aucun delai n a bouge')
  B.clic(b, b.doc.querySelector('[data-conv="B-LOFT"]'))
  await B.reposer(b)
  const note = b.doc.querySelector('[data-bind="tiroir-note"]')
  assert.equal(note.hidden, false, 'une perte silencieuse serait la dette D4 elargie')
  assert.equal(note.textContent,
    FR['messages.panneau_suit_le_fil'].replace('{nom}', 'Maison Jardin'))
  b.fermer()
})

test('LE TEST QUI COMPTE : la note du bien d avant ne survit pas au repointage', async () => {
  // ⚠ CONSTAT D UNE REVUE. Le gestionnaire du selecteur masque la note avant de
  // repointer, precisement pour ca (constat du 28 octobre : un « Enregistre »
  // VERT restait affiche sous les reglages NON enregistres du bien suivant).
  // Le nouveau chemin omettait ce geste : meme defaut, autre porte.
  const b = bancDeuxFils()
  b.msg.noteReglage('Enregistré', true)
  const note = b.doc.querySelector('[data-bind="tiroir-note"]')
  assert.equal(note.hidden, false, 'la note est bien posee au depart')
  B.clic(b, b.doc.querySelector('[data-conv="B-LOFT"]'))
  await B.reposer(b)
  assert.equal(b.msg.etat.tiroirBien, REF, 'le panneau a suivi')
  assert.equal(note.hidden, true, 'et la note du bien d avant a disparu')
  assert.equal(note.classList.contains('msg-tiroir__note--ok'), false)
  b.fermer()
})

test('LE TEST QUI COMPTE : la case ne s ecrit que dans le panneau du bien concerne', () => {
  // ⚠ SECONDE LIGNE DE DEFENSE DU CONSTAT 1. La garde de `reporterLePanneauSurLeFil`
  // empeche le repointage pendant une ecriture ; celle-ci protege le cas ou le
  // panneau aurait change par un AUTRE chemin (selecteur, re-rendu). Sans elle,
  // une ecriture en vol pose l etat de pause de SON bien dans le panneau
  // affiche — l hote lit « Maison Jardin » au selecteur et une case « en
  // pause » qui parle de Loft Pilotable.
  const { b } = bancEnPause({})
  b.msg.etat.biens.set(AUTRE, { name: 'Maison Jardin', photo: null })
  // Le panneau montre AUTRE ; la pause connue de REF est `true`.
  b.msg.etat.tiroirBien = AUTRE
  b.msg.renderTiroir()
  const caseP = B.casePause(b)
  caseP.checked = false
  b.msg.remettreCasePause(REF)
  assert.equal(caseP.checked, false,
    'le panneau affiche un autre bien : on n y ecrit pas l etat de celui-ci')
  // Et sur le bon bien, elle ecrit bien.
  b.msg.etat.tiroirBien = REF
  b.msg.renderTiroir()
  const caseRef = B.casePause(b)
  caseRef.checked = false
  b.msg.remettreCasePause(REF)
  assert.equal(caseRef.checked, true, 'sur son propre panneau, elle remet la verite connue')
  b.fermer()
})

// ── Les six constats de la DERNIERE revue, mesures ────────────────────────

test('LE TEST QUI COMPTE : un bien repasse en manuel ailleurs n annonce AUCUN envoi', async () => {
  // ⚠ CONSTAT HAUT D'UNE REVUE, ET C EST MOI QUI AI FABRIQUE DES ENVOIS
  // FANTOMES. `manquantes = avant.echues - gardees - prises` comparait un
  // nombre compte sous l ANCIEN delai a un bilan produit sous le delai RELU.
  // Si le bien est repasse en validation manuelle ailleurs, `gardees = 0` sans
  // ecriture, et la note annoncait « 3 propositions annoncees n etaient plus en
  // attente : l envoi les avait prises » alors que RIEN n etait arme et que
  // RIEN n est parti. Garanti, puisqu on n entre ici que si `echues > 0`.
  const { b, envois } = bancEnPause({
    echues: 3, confirme: false,
    configFraiche: { [REF]: { mode: 'test', delais: { reponse_ia: null, alerte_info: 0 } } }
  })
  B.changer(b, B.casePause(b), false)
  await B.reposer(b)
  const note = b.doc.querySelector('[data-bind="tiroir-note"]')
  assert.equal(note.textContent, FR['messages.pause_gardees_manuel'],
    'on dit l etat reel, pas un desarmement qui n a pas eu lieu')
  assert.doesNotMatch(note.textContent, /envoi/i, 'et surtout aucun envoi annonce')
  assert.equal(envois.filter(e => e.chemin === '/api/agent-config'
    && e.charge && e.charge.garder === true).length, 0, 'rien a desarmer, donc rien d ecrit')
  assert.equal(versPropertyAutomation(envois).length, 0, 'et la pause tient')
  b.fermer()
})

test('LE TEST QUI COMPTE : un delai allonge ailleurs n annonce pas d envolees', async () => {
  // Meme cause : les deux nombres ne sont plus comparables. On dit ce que le
  // serveur a desarme, et rien de plus.
  const { b } = bancEnPause({
    echues: 3, confirme: false, desarmes: 1,
    configFraiche: { [REF]: { mode: 'auto', delais: { reponse_ia: 240, alerte_info: 0 } } }
  })
  B.changer(b, B.casePause(b), false)
  await B.reposer(b)
  const note = b.doc.querySelector('[data-bind="tiroir-note"]')
  assert.equal(note.textContent, FR['messages.pause_gardees'].replace('{n}', '1'))
  assert.doesNotMatch(note.textContent,
    /n .taient plus en attente|no longer pending|ya no estaban/i,
    'aucune envolee annoncee sur deux nombres incomparables')
  b.fermer()
})

test('LE TEST QUI COMPTE : la relecture rafraichit AUSSI l ecran', async () => {
  // ⚠ CONSTAT MESURE D UNE REVUE : rafraichir `etat.configIA` sans toucher
  // `etat.delaisEdit` laissait la pilule active sur l ANCIENNE valeur, et
  // `editionPanneauNonEnregistree` accusait l hote d une saisie qu il n avait
  // jamais faite.
  const { b } = bancEnPause({
    echues: 1, confirme: false, desarmes: 1,
    configFraiche: { [REF]: { mode: 'auto', delais: { reponse_ia: 240, alerte_info: 0 } } }
  })
  assert.equal(b.msg.delaisEnCours(REF).reponse_ia, 15, 'l ecran part de la valeur perimee')
  B.changer(b, B.casePause(b), false)
  await B.reposer(b)
  assert.equal(b.msg.delaisEnCours(REF).reponse_ia, 240, 'l ecran suit la relecture')
  assert.equal(b.msg.editionPanneauNonEnregistree(), null,
    'et il n accuse personne d une saisie qui n a pas eu lieu')
  b.fermer()
})

test('une saisie REELLE survit a la relecture', async () => {
  const { b } = bancEnPause({
    echues: 1, confirme: false, desarmes: 1,
    configFraiche: { [REF]: { mode: 'auto', delais: { reponse_ia: 240, alerte_info: 0 } } }
  })
  B.clic(b, B.pilule(b, 60))   // l hote choisit 60, sans enregistrer
  B.changer(b, B.casePause(b), false)
  await B.reposer(b)
  assert.equal(b.msg.delaisEnCours(REF).reponse_ia, 60,
    'sa saisie est la seule chose qu on ne doit pas lui prendre')
  b.fermer()
})

test('LE TEST QUI COMPTE : une sortie sans ecriture ne repeint pas le volet', async () => {
  // ⚠ CONSTAT D UNE REVUE, MAIS PAS TOUT A FAIT SA CAUSE. Mes deux sorties sans
  // ecriture appelaient `renderTiroir()` pour rendre les controles, donc un
  // SECOND `corps.innerHTML = voletIA(ref)`. La revue en concluait que la
  // saisie du volet survivait avant ce chantier : MESURE, non —
  // `basculerPause` repeint DEJA a l entree, et le faisait avant. Toute bascule
  // de pause efface donc la consigne non enregistree, c est la dette D4, et
  // elle n est ni creee ni fermee ici.
  // Ce qui se mesure vraiment : le volet n est peint qu UNE fois, et les
  // controles sont rendus a l hote. On marque le noeud peint a l entree ; s il
  // est detache, un second rendu a eu lieu.
  // ⚠ IL FAUT UNE FENETRE POUR OBSERVER, SINON LE TEST NE MESURE RIEN. Ma
  // premiere version capturait le noeud apres un seul tick, sans bloquer
  // l apercu : le geste etait DEJA fini, donc le noeud capture etait celui
  // d APRES la sortie, et l assertion etait vraie par construction — mutation
  // faite, elle restait verte. On bloque l apercu, on capture pendant le vol,
  // puis on libere.
  const { b, liberer } = bancEnPause({ apercuKo: true, bloquerApercu: true })
  B.changer(b, B.casePause(b), false)
  await new Promise(r => setTimeout(r, 0))
  const peintALEntree = B.casePause(b)
  assert.ok(peintALEntree, 'le volet est peint, et gele')
  assert.equal(peintALEntree.disabled, true, 'gele pendant le vol')
  liberer()
  await B.reposer(b)
  assert.equal(b.doc.contains(peintALEntree), true,
    'le meme noeud est encore la : aucune seconde peinture')
  // Et les controles sont rendus a l hote, sans repeindre.
  assert.equal(peintALEntree.disabled, false, 'la case est degelee')
  assert.equal(B.boutonSave(b).disabled, false, '« Enregistrer » aussi')
  b.fermer()
})

test('LE TEST QUI COMPTE : une note ne s affiche jamais sous un AUTRE logement', async () => {
  // ⚠ ARBITRAGE ENTRE DEUX REVUES, ET LA RECETTE DE THIERRY L EMPORTE. La
  // derniere revue demandait de GELER le selecteur de bien pendant une ecriture
  // de pause. Le risque qu elle decrit est reel — la note atterrit sous un autre
  // logement —, mais geler un controle qui n ECRIT RIEN est exactement ce qui a
  // produit les points 1 et 3 de la recette du 28 octobre (« aucune
  // confirmation », « le premier clic sur une pilule est perdu ») : un
  // navigateur n envoie aucun clic sur un element desarme. On ferme donc le
  // defaut a la SOURCE : une note qui parle d un bien ne s affiche que sous ce
  // bien.
  const { b, liberer } = bancEnPause({ apercuKo: true, bloquerApercu: true })
  b.msg.etat.biens.set(AUTRE, { name: 'Maison Jardin', photo: null })
  B.changer(b, B.casePause(b), false)
  await new Promise(r => setTimeout(r, 0))
  // Le selecteur reste VIVANT : c est la lecon du 28 octobre.
  assert.equal(B.selBien(b).disabled, false, 'un controle qui n ecrit rien ne se desarme pas')
  // L hote change de bien pendant le vol, comme le ferait le selecteur.
  b.msg.etat.tiroirBien = AUTRE
  b.msg.renderTiroir()
  liberer()
  await B.reposer(b)
  const note = b.doc.querySelector('[data-bind="tiroir-note"]')
  assert.equal(note.hidden, true,
    'la note du bien d avant ne s affiche pas sous celui que l hote regarde')
  b.fermer()
})

test('LE TEST QUI COMPTE : le panneau rattrape le fil a la FIN du geste', async () => {
  // ⚠ CONSTAT MESURE D UNE REVUE, et ma propre garde l avait ouvert : le
  // repointage est refuse pendant une ecriture, et RIEN ne le rappelait apres.
  // L hote cliquait un autre fil pendant l aller-retour, et le panneau restait
  // sur le bien d avant POUR DE BON — le defaut de la recette du 30 octobre,
  // reouvert par le correctif.
  const { b, liberer } = bancEnPause({ echues: 0, bloquerApercu: true })
  b.msg.etat.biens.set(AUTRE, { name: 'Maison Jardin', photo: null })
  b.msg.etat.conversations = [{ bookId: 'B-AUTRE', propertyId: AUTRE, guestName: 'Jardin',
    lastNight: dans(2), messages: [] }]
  B.changer(b, B.casePause(b), false)
  await new Promise(r => setTimeout(r, 0))
  b.msg.etat.ouverte = 'B-AUTRE'
  b.msg.reporterLePanneauSurLeFil()
  assert.equal(b.msg.etat.tiroirBien, REF, 'pas pendant le vol')
  liberer()
  await B.reposer(b)
  assert.equal(b.msg.etat.tiroirBien, AUTRE,
    'mais a la fin du geste, le panneau rejoint le fil que l hote lit')
  b.fermer()
})

test('un echec de pause garde sa note, et le panneau ne bouge pas sous elle', async () => {
  // La note parle de CE bien : repointer la ferait atterrir sous un autre
  // logement. Le panneau suivra au prochain clic sur un fil.
  const envois = []
  const b = B.monter({ appel: async (chemin, charge) => {
    envois.push({ chemin, charge: charge || null })
    if (chemin === '/api/agent-config' && !charge) {
      return { config: { [REF]: { mode: 'auto', delais: { reponse_ia: 15, alerte_info: 0 } } } }
    }
    if (chemin === '/api/agent-config' && charge && charge.apercu === true) {
      return { delais_ref: charge.delais_ref, apercu: { ok: true, motif: 'delai', echues: 0 } }
    }
    // La relecture dit que la pause est TOUJOURS active : l ecriture a echoue.
    if (chemin === '/api/property-automation' && !charge) return { paused: { [REF]: true } }
    return {}
  } })
  B.peupler(b, {
    biens: [{ ref: REF, nom: 'Loft Pilotable' }, { ref: AUTRE, nom: 'Maison Jardin' }],
    config: { [REF]: { mode: 'auto', delais: { reponse_ia: 15, alerte_info: 0 } } },
    pauses: { [REF]: true },
    conversations: [{ bookId: 'B-AUTRE', propertyId: AUTRE, guestName: 'J',
      lastNight: dans(2), messages: [] }],
    bien: REF
  })
  b.msg.etat.ouverte = 'B-AUTRE'
  B.changer(b, B.casePause(b), false)
  await B.reposer(b)
  assert.equal(b.doc.querySelector('[data-bind="tiroir-note"]').textContent, FR['messages.mode_error'])
  assert.equal(b.msg.etat.tiroirBien, REF, 'le panneau reste sous sa note')
  b.fermer()
})

test('LE TEST QUI COMPTE : un destinataire d alerte compte, meme consignes illisibles', async () => {
  // ⚠ CONSTAT MESURE D UNE REVUE. `etat.prompting === null` est un etat
  // documente ; `voletIA` ne rend alors AUCUN `[data-consignes="global"]`, donc
  // `editionPanneauNonEnregistree` sortait par ce garde — et les destinataires
  // d alerte, qui restent editables, disparaissaient en silence.
  const b = B.monter({ appel: async () => ({}) })
  B.peupler(b, {
    biens: [{ ref: AUTRE, nom: 'Maison Jardin' }, { ref: REF, nom: 'Loft Pilotable' }],
    config: {
      [AUTRE]: { mode: 'test', delais: { reponse_ia: null, alerte_info: 0 } },
      [REF]: { mode: 'auto', delais: { reponse_ia: 15, alerte_info: 0 } }
    },
    prompting: null,
    conversations: [
      { bookId: 'B-JARDIN', propertyId: AUTRE, guestName: 'J', lastNight: dans(2), messages: [] },
      { bookId: 'B-LOFT', propertyId: REF, guestName: 'L', lastNight: dans(2), messages: [] }
    ],
    ouverte: 'B-JARDIN'
  })
  b.msg.renderListe()
  const champ = B.corps(b).querySelector('[data-alerte="intervention|email_lines"]')
  assert.ok(champ, 'le destinataire reste editable quand les consignes sont illisibles')
  champ.value = 'nouveau@exemple.test'
  assert.equal(b.msg.editionPanneauNonEnregistree(), 'Maison Jardin',
    'la saisie est vue, sans le bloc des consignes')
  B.clic(b, b.doc.querySelector('[data-conv="B-LOFT"]'))
  await B.reposer(b)
  assert.equal(b.doc.querySelector('[data-bind="tiroir-note"]').textContent,
    FR['messages.panneau_suit_le_fil'].replace('{nom}', 'Maison Jardin'))
  b.fermer()
})
