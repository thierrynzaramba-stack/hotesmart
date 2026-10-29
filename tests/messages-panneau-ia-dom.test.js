// tests/messages-panneau-ia-dom.test.js
// LA RECETTE DU 28 OCTOBRE 2026, REJOUEE DANS UN VRAI DOM. Quatre points,
// tous mesures en CLIQUANT sur ce que l'hote clique.
//
// ⚠ POURQUOI CE FICHIER EXISTE PLUTOT QU'UN GREP DE PLUS, et c'est la lecon du
// point 1. La confirmation de sortie de « Je valide chaque reponse » — la garde
// produit de Thierry du 11 octobre 2026 — etait tenue par un test qui cherchait
// la LIGNE dans la source (`tests/messages-v5.test.js`, « LE TEST QUI
// COMPTE »). La ligne y etait, le test etait vert, et en recette aucune
// confirmation n'est apparue : le bouton etait `disabled`, parce qu'une
// ecriture de pause etait en vol — et un navigateur n'envoie AUCUN `click` sur
// un bouton desarme. Un grep prouve qu'un texte existe ; il ne prouve pas
// qu'un geste le traverse.
//
// ⚠ ET LES POINTS 1 ET 3 N'ETAIENT QU'UN SEUL DEFAUT : « aucune confirmation »
// et « le premier clic sur une pilule est perdu » sont le meme `disabled`, pose
// par une ecriture qui ne concernait ni l'un ni l'autre.

const test = require('node:test')
const assert = require('node:assert/strict')
const B = require('./outils/banc-messages.js')

const REF = 'STG-BIEN-3'
const AUTRE = 'STG-BIEN-1'
const FR = B.FR

// Un bien en validation manuelle, seul au compte, panneau ouvert.
function bancManuel (opts = {}) {
  const b = B.monter(opts)
  B.peupler(b, {
    biens: [{ ref: REF, nom: 'Loft Pilotable' }],
    config: { [REF]: { mode: 'test', delais: { reponse_ia: null, alerte_info: 0 } } },
    pauses: opts.pauses || {}
  })
  return b
}

// ── Point 1 : la garde du 11 octobre, en cliquant ─────────────────────────

test('LE TEST QUI COMPTE : sortir de « Je valide chaque reponse » DEMANDE confirmation', async () => {
  const b = bancManuel()
  assert.equal(b.msg.delaisEnCours(REF).reponse_ia, null, 'le bien part en validation manuelle')
  B.clic(b, B.pilManuel(b))
  // La PHRASE que l'hote lit, pas un compteur : une confirmation qui ne dirait
  // pas ce qui va partir ne serait pas la garde de Thierry.
  assert.deepEqual(b.confirmations, [FR['messages.mode_confirm_auto']])
  assert.equal(b.msg.delaisEnCours(REF).reponse_ia, 15, 'acceptee, la sortie pose le delai de repli')
  b.fermer()
})

test('LE TEST QUI COMPTE : refuser la confirmation laisse le bien en validation manuelle', async () => {
  const b = bancManuel({ confirme: false })
  B.clic(b, B.pilManuel(b))
  assert.equal(b.confirmations.length, 1, 'la question a bien ete posee')
  assert.equal(b.msg.delaisEnCours(REF).reponse_ia, null, 'refusee, rien ne bouge')
  // Et l'ecran le dit : la pilule reste cerclee, les pilules de delai absentes.
  assert.equal(B.pilManuel(b).getAttribute('aria-pressed'), 'true')
  assert.equal(B.pilules(b).length, 0)
  b.fermer()
})

test('ENTRER en validation manuelle ne demande rien : ce n est pas un armement', async () => {
  const b = B.monter()
  B.peupler(b, {
    biens: [{ ref: REF, nom: 'Loft Pilotable' }],
    config: { [REF]: { mode: 'test', delais: { reponse_ia: 15, alerte_info: 0 } } }
  })
  B.clic(b, B.pilManuel(b))
  assert.deepEqual(b.confirmations, [], 'couper les envois seuls ne se confirme pas')
  assert.equal(b.msg.delaisEnCours(REF).reponse_ia, null)
  b.fermer()
})

// ── Points 1 et 3 : l'ecriture de la pause ne desarme plus l'edition ───────

// Le geste exact de la recette : l'hote decoche la pause, et l'ecriture n'a pas
// encore repondu. On observe le panneau PENDANT ce vol.
async function pendantLEcriturePause (fn, { delai = null } = {}) {
  let debloquer = null
  const b = B.monter({
    appel: async (chemin) => {
      if (chemin === '/api/property-automation') {
        await new Promise(r => { debloquer = r })
        return { paused: {} }
      }
      return {}
    }
  })
  B.peupler(b, {
    biens: [{ ref: REF, nom: 'Loft Pilotable' }],
    config: { [REF]: { mode: 'test', delais: { reponse_ia: delai, alerte_info: 0 } } },
    pauses: { [REF]: true }
  })
  B.changer(b, B.casePause(b), false)
  await new Promise(r => setTimeout(r, 0))
  try { await fn(b) } finally { if (debloquer) debloquer(); b.fermer() }
}

test('LE TEST QUI COMPTE : pendant l ecriture de la pause, la sortie du mode manuel reste cliquable', async () => {
  await pendantLEcriturePause(async (b) => {
    // ⚠ C'EST `disabled` QU'ON MESURE, PAS LE CLIC. jsdom appelle les
    // gestionnaires d'un bouton desarme ; un navigateur, non. Affirmer le clic
    // ici rendrait le test vert sur le defaut meme qu'il doit fermer.
    assert.equal(B.pilManuel(b).disabled, false,
      'le bouton de la garde du 11 octobre ne se desarme pas pour une ecriture de pause')
    assert.equal(B.casePause(b).disabled, true,
      'la case de la pause, elle, reste gelee : c est elle qui ecrit')
    assert.equal(B.boutonSave(b).disabled, true,
      '« Enregistrer » reste gele : il ecrit aussi')
  })
})

test('LE TEST QUI COMPTE : pendant l ecriture de la pause, un clic de pilule n est pas perdu', async () => {
  await pendantLEcriturePause(async (b) => {
    const p = B.pilule(b, 60)
    assert.ok(p, 'les pilules sont rendues : le bien n est pas en validation manuelle ici')
    assert.equal(p.disabled, false, 'une pilule n ecrit rien, elle ne se desarme pas')
    B.clic(b, p)
    assert.equal(b.msg.delaisEnCours(REF).reponse_ia, 60, 'la valeur est posee')
  }, { delai: 15 })
  // Hors du vol : on refait le geste jusqu'au bout et on verifie la survie.
  let debloquer = null
  const b = B.monter({
    appel: async (chemin) => {
      if (chemin === '/api/property-automation') {
        if (debloquer === false) return { paused: {} }
        await new Promise(r => { debloquer = r })
        return { paused: {} }
      }
      return {}
    }
  })
  B.peupler(b, {
    biens: [{ ref: REF, nom: 'Loft Pilotable' }],
    config: { [REF]: { mode: 'test', delais: { reponse_ia: 15, alerte_info: 0 } } },
    pauses: { [REF]: true }
  })
  B.changer(b, B.casePause(b), false)
  await new Promise(r => setTimeout(r, 0))
  B.clic(b, B.pilule(b, 240))
  const fin = debloquer; debloquer = false; fin()
  await new Promise(r => setTimeout(r, 5))
  assert.equal(b.msg.delaisEnCours(REF).reponse_ia, 240,
    'la pause relue ne jette pas la valeur choisie pendant son vol')
  assert.equal(B.pilule(b, 240).getAttribute('aria-pressed'), 'true', 'et l ecran la montre')
  b.fermer()
})

test('pendant l ENREGISTREMENT du panneau, les pilules sont bien gelees', async () => {
  // Le gel qui reste legitime : `enregistrerPanneau` a DEJA lu le formulaire.
  let debloquer = null
  const enregistre = { [REF]: { mode: 'test', delais: { reponse_ia: 15, alerte_info: 0 } } }
  const b = B.monter({
    appel: async (chemin, corps) => {
      if (corps && corps.apercu === true) { await new Promise(r => { debloquer = r }); return { ok: true, delais_ref: REF, apercu: { ok: true, echues: 0 } } }
      // ⚠ LA RELECTURE REND LA VRAIE CONFIG. Un `{}` ici renverrait le bien en
      // validation manuelle — les pilules disparaitraient, et le test
      // mesurerait une absence au lieu d un `disabled`.
      if (!corps) return { config: enregistre }
      return { ok: true }
    }
  })
  B.peupler(b, { biens: [{ ref: REF, nom: 'Loft Pilotable' }], config: enregistre })
  const promesse = b.msg.enregistrerPanneau(B.corps(b), REF)
  await new Promise(r => setTimeout(r, 0))
  assert.equal(B.pilule(b, 60).disabled, true, 'une valeur changee apres la lecture ferait mentir l ecran')
  assert.equal(B.pilManuel(b).disabled, true)
  debloquer()
  await promesse
  assert.equal(B.pilule(b, 60).disabled, false, 'et tout redevient vivant a la fin')
  b.fermer()
})

// ── Point 2 : le panneau s ouvre sur le bien du fil ouvert ────────────────

function bancDeuxBiens ({ ouverte = null } = {}) {
  const b = B.monter()
  B.peupler(b, {
    biens: [{ ref: AUTRE, nom: 'Maison Jardin' }, { ref: REF, nom: 'Loft Pilotable' }],
    config: {
      [AUTRE]: { mode: 'auto', delais: { reponse_ia: 0, alerte_info: 0 } },
      [REF]: { mode: 'test', delais: { reponse_ia: null, alerte_info: 0 } }
    },
    conversations: [
      { bookId: 'B-JARDIN', propertyId: AUTRE, guestName: 'A' },
      { bookId: 'B-LOFT', propertyId: REF, guestName: 'B' }
    ],
    ouverte
  })
  return b
}

test('LE TEST QUI COMPTE : le panneau s ouvre sur le bien du FIL OUVERT', async () => {
  const b = bancDeuxBiens({ ouverte: 'B-LOFT' })
  assert.equal(b.msg.etat.tiroirBien, REF,
    'le fil ouvert est Loft Pilotable, le panneau doit l etre aussi')
  assert.equal(B.selBien(b).value, REF, 'et le selecteur le montre')
  // La preuve que ce n est pas un hasard d ordre : Maison Jardin est refs[0].
  assert.equal([...b.msg.etat.biens.keys()][0], AUTRE)
  b.fermer()
})

test('sans fil ouvert, le panneau garde le premier bien', async () => {
  const b = bancDeuxBiens()
  assert.equal(b.msg.etat.tiroirBien, AUTRE)
  b.fermer()
})

test('un fil dont le bien est inconnu ne change rien', async () => {
  const b = B.monter()
  B.peupler(b, {
    biens: [{ ref: AUTRE, nom: 'Maison Jardin' }],
    config: { [AUTRE]: { mode: 'test', delais: { reponse_ia: 15, alerte_info: 0 } } },
    conversations: [{ bookId: 'B-X', propertyId: 'BIEN-PARTI', guestName: 'X' }],
    ouverte: 'B-X'
  })
  assert.equal(b.msg.etat.tiroirBien, AUTRE, 'jamais de panneau sur un bien absent du compte')
  b.fermer()
})

test('LE TEST QUI COMPTE : un bien choisi a la main n est pas ecrase par un re-rendu', async () => {
  // Le defaut symetrique de la correction : si le bien du fil etait recalcule
  // a chaque rendu, le choix de l hote sauterait au premier clic de pilule.
  const b = bancDeuxBiens({ ouverte: 'B-LOFT' })
  b.msg.etat.tiroirBien = AUTRE
  b.msg.renderTiroir()
  assert.equal(b.msg.etat.tiroirBien, AUTRE)
  B.clic(b, B.pilule(b, 60))
  assert.equal(b.msg.etat.tiroirBien, AUTRE, 'le re-rendu n a pas ramene le bien du fil')
  assert.equal(b.msg.delaisEnCours(AUTRE).reponse_ia, 60)
  b.fermer()
})

// ── Point 4 : refuser la liberation n est pas un echec ────────────────────

// L enregistrement complet, avec l apercu qui annonce `echues`.
function bancEnregistrement ({ echues = 0, brouillons = null, confirme = true, desarmes = 0, instant = null } = {}) {
  const envoyes = []
  const bilan = brouillons || { ok: true, desarmes, rearmes: desarmes ? 0 : 2, deja_prises: 0 }
  const b = B.monter({
    confirme,
    appel: async (chemin, corps) => {
      if (chemin.startsWith('/api/agent-config') && corps) {
        envoyes.push(corps)
        if (corps.apercu === true) {
          return { ok: true, delais_ref: REF, apercu: { ok: true, echues, instant: instant === null ? Date.now() : instant } }
        }
        if (corps.delais_ref) return { ok: true, delais_ref: REF, delais: corps.delais, brouillons: bilan }
        return { ok: true }
      }
      if (chemin.startsWith('/api/agent-config')) return { config: { [REF]: { mode: 'test', delais: { reponse_ia: 60, alerte_info: 0 } } } }
      return {}
    }
  })
  B.peupler(b, {
    biens: [{ ref: REF, nom: 'Loft Pilotable' }],
    config: { [REF]: { mode: 'test', delais: { reponse_ia: null, alerte_info: 0 } } }
  })
  return { b, envoyes }
}

test('LE TEST QUI COMPTE : ANNULER garde les propositions pour validation, et le DIT', async () => {
  // ⚠ DEUX ISSUES REELLES (arbitrage de Thierry du 29 octobre 2026). Avant, ce
  // test s'appelait « refuser la liberation dit Enregistre » : le refus
  // n'ecrivait rien, et la revue a mesure que dans l'etat de sa recette la
  // proposition partait quand meme. Annuler DESARME maintenant les
  // propositions annoncees.
  // ⚠ `echues` ET `desarmes` DIFFERENT EXPRES (constat 5 d une revue) : les
  // deux fixtures posaient le meme nombre des deux cotes, donc l invariant
  // « c est le nombre du SERVEUR qui s affiche » n etait mesure par rien —
  // garder `ap.echues` dans la note laissait tout vert. Le serveur en desarme
  // 6 la ou l apercu en annoncait 4 : c est lui qui a raison, et c est son
  // chiffre que l hote doit lire.
  const { b, envoyes } = bancEnregistrement({ echues: 4, confirme: false, desarmes: 6 })
  // L hote sort de la validation manuelle, accepte la garde du 11 octobre,
  // puis REFUSE de liberer son arriere.
  b.repondreConfirm((texte) => texte === FR['messages.mode_confirm_auto'])
  B.clic(b, B.pilManuel(b))
  await b.msg.enregistrerPanneau(B.corps(b), REF)
  assert.match(b.note(), /^Enregistré\. 6 proposition\(s\) déjà en attente sont gardées pour votre validation/)
  assert.equal(b.noteOk(), true, 'la note est VERTE : c est son choix, pas un echec')
  // Et le serveur a recu l'ORDRE de desarmer, pas l'ordre de ne rien faire.
  const reel = envoyes.filter(c => c.delais_ref && c.apercu !== true)
  assert.equal(reel.length, 1)
  assert.equal(reel[0].propager, true, 'le reglage se propage : il est enregistre dans les deux cas')
  assert.equal(reel[0].garder, true, 'et les propositions annoncees sont gardees')
  assert.equal(reel[0].delais.reponse_ia, 15)
  b.fermer()
})

test('un ECHEC de la propagation, lui, reste rouge et se nomme', async () => {
  const { b } = bancEnregistrement({ echues: 0, brouillons: { ok: false, motif: 'lecture_illisible' } })
  b.repondreConfirm(true)
  B.clic(b, B.pilManuel(b))
  await b.msg.enregistrerPanneau(B.corps(b), REF)
  assert.match(b.note(), /Non enregistré/)
  assert.match(b.note(), new RegExp(FR['messages.partie_brouillons']))
  assert.equal(b.noteOk(), false)
  assert.ok(!/gardées pour votre validation/.test(b.note()),
    'un echec ne se deguise pas en choix de l hote')
  b.fermer()
})

test('un apercu ILLISIBLE reste un echec : l hote n a rien choisi', async () => {
  const b = B.monter({
    appel: async (chemin, corps) => {
      if (corps && corps.apercu === true) return { pas_du_json_attendu: true }
      if (corps && corps.delais_ref) return { ok: true, brouillons: { ok: true, desarmes: 0, rearmes: 0, deja_prises: 0 } }
      return {}
    }
  })
  B.peupler(b, {
    biens: [{ ref: REF, nom: 'Loft Pilotable' }],
    config: { [REF]: { mode: 'test', delais: { reponse_ia: 15, alerte_info: 0 } } }
  })
  await b.msg.enregistrerPanneau(B.corps(b), REF)
  assert.match(b.note(), /Non enregistré/)
  assert.ok(!/gardées pour votre validation/.test(b.note()),
    'ne pas pouvoir compter n est pas un choix de l hote')
  b.fermer()
})

test('sans arriere, la note reste le simple « Enregistre »', async () => {
  const { b } = bancEnregistrement({ echues: 0 })
  b.repondreConfirm(true)
  B.clic(b, B.pilManuel(b))
  await b.msg.enregistrerPanneau(B.corps(b), REF)
  assert.equal(b.note(), FR['messages.panneau_saved'])
  assert.equal(b.noteOk(), true)
  b.fermer()
})

// ── Les constats des deux revues de ce lot ────────────────────────────────
// ⚠ L'EN-TETE DISAIT « les six constats », ET C'ETAIT FAUX : la revue en a
// rendu DIX (constat 5 de la revue suivante — un chiffre perime se lit comme
// une mesure et ne rougit jamais).
//
// ⚠ ET ELLE DISAIT « chacun ci-dessous a ete MESURE rouge contre c0d1ec0d », ce
// qui etait faux aussi. Mesure refaite, tests et banc d'aujourd'hui contre le
// `pages/messages.html` de `c0d1ec0d` : 4 rouges sur 9 — les constats 1, 7, 5
// et 6. Les cinq autres sont VERTS contre ce commit, et c'est normal : ils
// ferment des faux verts, c'est-a-dire du code deja juste que rien ne tenait.
// Leur preuve est une MUTATION, pas une contre-epreuve, et chacun dit laquelle.

// L'amorce lance la VRAIE `init()` : sans elle, le selecteur de bien et les
// deux boutons de volet ne sont pas branches, et c'est exactement ce qui avait
// rendu les constats 1 et 7 invisibles au banc.
async function bancAmorce ({ ouverte = 'B-LOFT' } = {}) {
  const b = B.monter({ appel: async () => ({}) })
  await B.amorcer(b)
  B.peupler(b, {
    biens: [{ ref: AUTRE, nom: 'Maison Jardin' }, { ref: REF, nom: 'Loft Pilotable' }],
    config: {
      [AUTRE]: { mode: 'test', delais: { reponse_ia: 15, alerte_info: 0 } },
      [REF]: { mode: 'test', delais: { reponse_ia: null, alerte_info: 0 } }
    },
    conversations: [
      { bookId: 'B-JARDIN', propertyId: AUTRE, guestName: 'A' },
      { bookId: 'B-LOFT', propertyId: REF, guestName: 'B' }
    ],
    ouverte
  })
  return b
}

test('LE TEST QUI COMPTE : un aller-retour entre volets ne reprend pas le bien du fil', async () => {
  // Constat 1 : `ouvrirTiroir(true)` est rappele a CHAQUE bascule de volet,
  // panneau deja ouvert. Presellectionner la ecrasait le bien choisi a la
  // main — et `delaisEnCours` remet `etat.delaisEdit` a zero des que la
  // reference change, donc l edition non enregistree partait avec.
  const b = await bancAmorce()
  assert.equal(b.msg.etat.tiroirBien, REF, 'a l ouverture, le bien du fil')
  // L hote choisit l autre logement et y pose 4 h.
  B.changer(b, B.selBien(b), AUTRE)
  assert.equal(b.msg.etat.tiroirBien, AUTRE, 'le selecteur de init() est bien branche')
  B.clic(b, B.pilule(b, 240))
  assert.equal(b.msg.delaisEnCours(AUTRE).reponse_ia, 240)
  // Il va voir les messages programmes, puis revient.
  B.clic(b, B.boutonVolet(b, 'programmes'))
  assert.equal(B.tiroirOuvert(b), true, 'le panneau reste ouvert, il change de volet')
  await B.reposer(b)
  B.clic(b, B.boutonVolet(b, 'ia'))
  assert.equal(b.msg.etat.tiroirBien, AUTRE, 'son logement n a pas ete repris par le fil')
  assert.equal(b.msg.delaisEnCours(AUTRE).reponse_ia, 240, 'et son edition est toujours la')
  await B.reposer(b)
  b.fermer()
})

test('fermer puis reouvrir le panneau, EN REVANCHE, revient au bien du fil', async () => {
  // La contrepartie : une vraie ouverture doit suivre le fil, sinon le point 2
  // de la recette serait referme a moitie.
  const b = await bancAmorce()
  B.changer(b, B.selBien(b), AUTRE)
  assert.equal(b.msg.etat.tiroirBien, AUTRE)
  b.msg.ouvrirTiroir(false)
  b.msg.ouvrirTiroir(true)
  assert.equal(b.msg.etat.tiroirBien, REF, 'une ouverture, elle, suit le fil ouvert')
  b.fermer()
})

test('LE TEST QUI COMPTE : bienDuFilOuvert refuse un bien hors du compte, par LUI-MEME', async () => {
  // Constat 2 : l assertion d avant etait satisfaite par le repli de
  // `renderTiroir` (`!etat.biens.has(...) -> refs[0]`), pas par la garde
  // qu elle nommait. Mutation mesuree par la revue : retirer la garde de
  // `bienDuFilOuvert` laissait les 6813 tests verts. On l execute donc.
  const b = B.monter()
  B.peupler(b, {
    biens: [{ ref: AUTRE, nom: 'Maison Jardin' }],
    config: { [AUTRE]: { mode: 'test', delais: { reponse_ia: 15, alerte_info: 0 } } },
    conversations: [
      { bookId: 'B-X', propertyId: 'BIEN-D-UN-AUTRE-COMPTE', guestName: 'X' },
      { bookId: 'B-OK', propertyId: AUTRE, guestName: 'Y' }
    ],
    ouverte: 'B-X'
  })
  assert.equal(b.msg.bienDuFilOuvert(), null,
    'un bien absent de etat.biens — donc du compte courant — ne designe rien')
  b.msg.etat.ouverte = 'B-OK'
  assert.equal(b.msg.bienDuFilOuvert(), AUTRE, 'un bien du compte, lui, est designe')
  // ⚠ LES DEUX ASSERTIONS QUI SUIVENT DECRIVENT LE CONTRAT, ELLES NE LE
  // MESURENT PAS — et c est un constat de la derniere revue, mesure : retirer
  // le `if (etat.ouverte === null) return null` de `bienDuFilOuvert` laisse ce
  // fichier a 25/25, parce que `etat.biens.has('')` rend deja false. La garde
  // qui MORD est celle du compte, eprouvee juste au-dessus par mutation. On les
  // garde parce qu elles disent l intention, pas parce qu elles la prouvent.
  b.msg.etat.ouverte = null
  assert.equal(b.msg.bienDuFilOuvert(), null, 'et sans fil ouvert, rien')
  b.msg.etat.ouverte = 'B-INCONNU'
  assert.equal(b.msg.bienDuFilOuvert(), null, 'ni pour une conversation introuvable')
  b.fermer()
})

test('LE TEST QUI COMPTE : une ecriture de pause ne gele PAS l en-tete du tiroir', async () => {
  // Constat 4 de la seconde revue : le premier correctif avait pose
  // `sel.disabled = etat.modeEnCours`, or `modeEnCours` est aussi pose par
  // `basculerPause` et par les quatre ecritures du volet Programmes. Changer de
  // bien ou de volet n ECRIT rien — c est de l etat local et un re-rendu — donc
  // le geler la rouvrait, pour ces contrôles, la famille de defaut que les
  // points 1 et 3 de la recette viennent de fermer.
  await pendantLEcriturePause(async (b) => {
    assert.equal(B.selBien(b).disabled, false, 'le selecteur n ecrit rien')
    assert.equal(B.boutonVolet(b, 'programmes').disabled, false, 'les volets non plus')
    assert.equal(B.casePause(b).disabled, true, 'la case de pause, elle, ecrit')
  }, { delai: 15 })
})

test('LE TEST QUI COMPTE : la sourdine aussi reste editable pendant l ecriture de la pause', async () => {
  // Constat 3 : le comportement etait juste, mais AUCUN test ne le tenait —
  // remettre les trois controles de sourdine sous le gel de la pause laissait
  // les 6813 tests verts, et la spec affirmait « un test le tient ».
  await pendantLEcriturePause(async (b) => {
    const c = B.corps(b)
    const active = c.querySelector('[data-sourdine-active]')
    const debut = c.querySelector('[data-sourdine-debut]')
    const fin = c.querySelector('[data-sourdine-fin]')
    assert.equal(active.disabled, false, 'la case de sourdine n ecrit rien')
    assert.equal(debut.disabled, false)
    assert.equal(fin.disabled, false)
    B.changer(b, active, true)
    B.changer(b, debut, '23:30')
    // ⚠ CHAMP PAR CHAMP, PAS `deepEqual` : l objet vient du realm de la
    // fenetre jsdom, donc son prototype n est pas celui du test et un
    // `deepEqual` strict rougit sur deux objets identiques (lecon deja payee
    // par le depot, tests/outils/banc-calendrier.js la porte aussi).
    const sd = b.msg.delaisEnCours(REF).sourdine
    assert.equal(sd.active, true)
    assert.equal(sd.debut, '23:30')
    assert.equal(sd.fin, '08:00')
  }, { delai: 15 })
})

test('LE TEST QUI COMPTE : le selecteur de bien est gele pendant l enregistrement', async () => {
  // Constat 7 : il vit HORS de `tiroir-corps`, donc ni `geler(corps, …)` ni
  // `off`/`offEdition` ne l atteignaient. Changer de bien pendant les six
  // allers-retours d un enregistrement faisait atterrir le « Enregistré » VERT
  // sous un logement dont rien n avait ete enregistre.
  let debloquer = null
  const enregistre = { [REF]: { mode: 'test', delais: { reponse_ia: 15, alerte_info: 0 } } }
  const b = B.monter({
    appel: async (chemin, corps) => {
      if (corps && corps.apercu === true) {
        await new Promise(r => { debloquer = r })
        return { ok: true, delais_ref: REF, apercu: { ok: true, echues: 0 } }
      }
      if (!corps) return { config: enregistre }
      return { ok: true }
    }
  })
  await B.amorcer(b)
  B.peupler(b, {
    biens: [{ ref: REF, nom: 'Loft Pilotable' }, { ref: AUTRE, nom: 'Maison Jardin' }],
    config: { ...enregistre, [AUTRE]: { mode: 'test', delais: { reponse_ia: 60, alerte_info: 0 } } },
    bien: REF
  })
  const promesse = b.msg.enregistrerPanneau(B.corps(b), REF)
  await new Promise(r => setTimeout(r, 0))
  assert.equal(B.selBien(b).disabled, true, 'on ne change pas de logement pendant une ecriture')
  // ⚠ ET LES DEUX BOUTONS DE VOLET AUSSI (constat 1 de la seconde revue, qui a
  // mesure que le premier correctif n'avait ferme qu'un des deux chemins) :
  // basculer de volet en cours d'ecriture faisait atterrir le « Enregistré »
  // VERT sous le volet Programmes, dont rien n'avait ete enregistre.
  assert.equal(B.boutonVolet(b, 'programmes').disabled, true, 'ni de volet')
  assert.equal(B.boutonVolet(b, 'ia').disabled, true)
  debloquer()
  await promesse
  assert.equal(b.msg.etat.tiroirBien, REF, 'la note tombe sous le bien enregistre')
  assert.equal(b.msg.etat.tiroirVolet, 'ia', 'et sous le volet enregistre')
  assert.equal(B.selBien(b).disabled, false, 'et l en-tete redevient vivante')
  assert.equal(B.boutonVolet(b, 'programmes').disabled, false)
  b.fermer()
})

test('LE TEST QUI COMPTE : un echec des consignes rend la note partielle', async () => {
  // Constat 9 : le double supabase du banc acceptait n importe quelle table et
  // n importe quel maillon, donc l etape 3 du panneau ne pouvait PAS echouer —
  // et toutes les assertions de note etaient inconditionnelles. La revue l a
  // mesure en reecrivant `ecrireConsigne` vers une table inexistante : 14 verts.
  const { b } = bancEnregistrement({ echues: 0 })
  b.window.__echecTable = 'agent_prompting'
  await b.msg.enregistrerPanneau(B.corps(b), REF)
  assert.match(b.note(), /Non enregistré/)
  assert.match(b.note(), new RegExp(FR['messages.partie_consignes']))
  assert.equal(b.noteOk(), false)
  b.fermer()
})

test('le banc REFUSE une table ou un maillon que la page n a pas', async () => {
  // Le double doit refuser ce que le vrai refuse : sans ca il valide du code
  // qui ne pourrait pas tourner en production.
  const b = B.monter()
  assert.throws(() => b.window.__table('table_inexistante'), /table inconnue/)
  assert.throws(() => b.window.__table('agent_prompting').maillonInvente(),
    /maillon inconnu/)
  b.fermer()
})

test('LE TEST QUI COMPTE : un lever pendant l enregistrement rend les deux drapeaux', async () => {
  // Constat 5 : les drapeaux etaient poses hors de tout `try`. Un lever de
  // `renderTiroir` laissait `panneauEnCours` colle a vrai — panneau desarme
  // pour le reste de la session, et `enregistrerPanneau` mort par sa propre
  // garde de reentrance.
  const b = B.monter({ appel: async () => ({}) })
  B.peupler(b, {
    biens: [{ ref: REF, nom: 'Loft Pilotable' }],
    config: { [REF]: { mode: 'test', delais: { reponse_ia: 15, alerte_info: 0 } } }
  })
  // On retire du squelette une ancre dont `renderTiroir` a besoin : il leve, et
  // c'est le PREMIER re-rendu — celui du chemin d'entree.
  const volet = B.boutonVolet(b, 'programmes')
  B.selBien(b).remove()
  await assert.rejects(() => b.msg.enregistrerPanneau(B.corps(b), REF))
  assert.equal(b.msg.etat.panneauEnCours, false, 'le filet a rendu le drapeau du panneau')
  assert.equal(b.msg.etat.modeEnCours, false, 'et celui des ecritures')
  // ⚠ ET IL DIT QUELQUE CHOSE (constat 2 de la seconde revue) : il rendait les
  // drapeaux sans poser AUCUNE note — l'hote cliquait « Enregistrer » et ne
  // lisait rien, ni succes ni echec. Le filet ne sait pas ce qui est passe,
  // donc il sur-annonce : c'est la doctrine du depot a cet endroit.
  assert.equal(b.note(), FR['messages.mode_error'], 'l hote lit quelque chose')
  assert.equal(b.noteOk(), false)
  // ⚠ ET L EN-TETE EST RENDUE A VIF (constat 3) : `geler(corps, false)` ne
  // balaie que le corps, et le lever est tombe AVANT la ligne qui degele
  // l en-tete. Sans ce second geste, les boutons de volet restaient desarmes
  // sans aucun chemin de retour.
  assert.equal(volet.disabled, false, 'les boutons de volet sont rendus')
  b.fermer()
})

test('LE TEST QUI COMPTE : ANNULER ecrit, et le fil est relu', async () => {
  // ⚠ CE TEST DISAIT L'INVERSE AVANT L'ARBITRAGE DE THIERRY DU 29 OCTOBRE :
  // « un refus ne fabrique pas une note qui se contredit », et il affirmait que
  // le fil n'etait PAS relu, parce que refuser n'ecrivait rien. C'est
  // exactement ce que la revue a mesure comme defaut : la proposition partait
  // quand meme. Annuler DESARME maintenant — donc ca ecrit, donc le fil doit
  // etre relu, sinon les bulles gardent a l'ecran un compte a rebours qui
  // n'existe plus.
  const brouillons = {
    ok: true, motif: 'desarmement_demande',
    desarmes: 3, rearmes: 0, inchanges: 0, deja_prises: 0, echues: 3, sans_creation: 0
  }
  const envoyes = []
  const b = B.monter({
    // Il accepte la garde du 11 octobre, puis ANNULE la liberation.
    confirme: (texte) => texte === FR['messages.mode_confirm_auto'],
    appel: async (chemin, corps) => {
      if (corps) envoyes.push(corps)
      // ⚠ `echues` ET `desarmes` DIFFERENT ICI AUSSI (constat 5 de la
      // re-revue : la fixture complice avait resservi, cinquieme fois). Le
      // serveur en desarme 3 la ou l apercu en annoncait 5 ; les 2 manquantes
      // ont quitte la file pendant que l hote lisait le dialogue.
      if (corps && corps.apercu === true) return { ok: true, delais_ref: REF, apercu: { ok: true, echues: 5 } }
      if (corps && corps.delais_ref) return { ok: true, delais_ref: REF, delais: corps.delais, brouillons }
      if (!corps) return { config: { [REF]: { mode: 'test', delais: { reponse_ia: 15, alerte_info: 0 } } } }
      return { ok: true }
    }
  })
  B.peupler(b, {
    biens: [{ ref: REF, nom: 'Loft Pilotable' }],
    config: { [REF]: { mode: 'test', delais: { reponse_ia: null, alerte_info: 0 } } }
  })
  const avant = b.tables.filter(x => x === 'agent_tasks').length
  B.clic(b, B.pilManuel(b))
  await b.msg.enregistrerPanneau(B.corps(b), REF)
  const reel = envoyes.filter(c => c.delais_ref && c.apercu !== true)
  assert.equal(reel.length, 1)
  assert.equal(reel[0].garder, true, 'l ordre de desarmer part')
  assert.equal(reel[0].propager, true, 'et le reglage est enregistre quand meme')
  // ⚠ AUCUN INSTANT NE REPART AU SERVEUR (constat 1 d une revue, de SECURITE) :
  // une borne venue du navigateur ne peut que REDUIRE l ensemble desarme, donc
  // laisser partir un brouillon que l hote croit garde.
  //
  // ⚠ CE BLOC PORTAIT ENCORE, JUSTE AU-DESSUS, LA PHRASE INVERSE — « l instant
  // de l apercu est repasse : sans lui la difference partirait au voyageur ».
  // C est celle que la revue a mesuree fausse en trois copies ; les deux autres
  // avaient ete reecrites, celle-ci etait restee au-dessus de son propre
  // dementi (releve en re-revue).
  assert.equal('cutoff' in reel[0], false, 'aucune borne ne part du navigateur')
  // Le NOMBRE affiche est celui du SERVEUR, pas celui compte avant.
  assert.match(b.note(), /3 proposition\(s\) déjà en attente sont gardées pour votre validation/,
    'le nombre du SERVEUR, pas celui de l apercu')
  assert.match(b.note(), /2 proposition\(s\) annoncée\(s\) n’étaient plus en attente/,
    'et l ecart avec l annonce se dit : elles sont parties au voyageur')
  assert.equal(b.noteOk(), false, 'donc la note n est pas verte')
  assert.ok(b.tables.filter(x => x === 'agent_tasks').length > avant,
    'le fil est relu : des echeances ont disparu')
  b.fermer()
})

test('un bilan ABSENT, lui, fait relire le fil — c est la fenetre de deploiement', async () => {
  // ⚠ ET C EST LE CONSTAT 2 DE LA DERNIERE REVUE, a l envers. J avais ecrit
  // `brouillonsRepris = !propager ? 0 : …`, ce qui retirait le rechargement
  // dans la SEULE fenetre ou il servait : un endpoint anterieur a `apercu`
  // aurait enregistre ET PROPAGE des l appel d apercu, puis ignore
  // `propager: false` — et il ne rend pas de `brouillons`. Sans relecture, le
  // fil gardait a l ecran une echeance perimee.
  // ⚠ LA BRANCHE VISEE EST « REPONSE ILLISIBLE », ET MA PREMIERE VERSION VISAIT
  // A COTE : elle faisait repondre un `{ ok: true, delais_ref: REF }`, que
  // l ecran reconnait comme un endpoint ancien — et la, `propager` reste VRAI,
  // donc la mutation du correctif ne changeait rien (mesure : 0 rouge). Pour
  // poser `propager = false`, la reponse d apercu doit etre ILLISIBLE : ni
  // `apercu`, ni `delais_ref` qui corresponde. C est la forme d un 200 non-JSON
  // — page HTML d un proxy, d un edge, d une protection de deploiement — que
  // `appel()` convertit en `{}`.
  const b = B.monter({
    appel: async (chemin, corps) => {
      if (corps && corps.apercu === true) return {}
      // Et l endpoint qui repond ensuite est ANCIEN : il ignore `propager` et
      // ne rend aucun bilan. C est la fenetre de deploiement.
      if (corps && corps.delais_ref) return { ok: true, delais_ref: REF, delais: corps.delais }
      if (!corps) return { config: { [REF]: { mode: 'test', delais: { reponse_ia: 60, alerte_info: 0 } } } }
      return { ok: true }
    }
  })
  B.peupler(b, {
    biens: [{ ref: REF, nom: 'Loft Pilotable' }],
    config: { [REF]: { mode: 'test', delais: { reponse_ia: 15, alerte_info: 0 } } }
  })
  const avant = b.tables.filter(x => x === 'agent_tasks').length
  await b.msg.enregistrerPanneau(B.corps(b), REF)
  assert.ok(b.tables.filter(x => x === 'agent_tasks').length > avant,
    'bilan absent = on relit dans le doute, sinon l ecran garde une echeance perimee')
  b.fermer()
})

test('LE TEST QUI COMPTE : un lever du DERNIER re-rendu laisse quand meme la note et un panneau utilisable', async () => {
  // ⚠ CONSTAT 3 DE LA DERNIERE REVUE, mesure par sonde : le filet de
  // l enveloppe ne couvre pas CE lever-la (les drapeaux sont deja retombes,
  // donc son `if` est faux). Resultat mesure avant correctif : panneau
  // entierement `disabled`, note vide, « Enregistrer » desarme — l hote a
  // clique, tout est passe cote serveur, il ne lit rien et ne peut pas
  // reessayer.
  const enregistre = { [REF]: { mode: 'test', delais: { reponse_ia: 15, alerte_info: 0 } } }
  // ⚠ LE RETRAIT SE FAIT DANS LE DOUBLE, PAS DANS UN `setTimeout` : mes doubles
  // resolvent en MICROTACHES, donc une macrotache programmee avant l appel
  // tombait APRES la fin de l enregistrement — et la mutation restait verte
  // (mesure : 0 rouge). En le faisant pendant l appel d apercu, l ordre est
  // deterministe : le premier re-rendu a deja eu lieu (le panneau est gele),
  // c est le DERNIER qui va lever.
  const casser = { fait: false, cible: null }
  const b = B.monter({
    appel: async (chemin, corps) => {
      if (corps && corps.apercu === true) {
        if (!casser.fait && casser.cible) { casser.cible.remove(); casser.fait = true }
        return { ok: true, delais_ref: REF, apercu: { ok: true, echues: 0 } }
      }
      if (!corps) return { config: enregistre }
      return { ok: true, delais_ref: REF, brouillons: { ok: true, desarmes: 0, rearmes: 0, deja_prises: 0 } }
    }
  })
  B.peupler(b, { biens: [{ ref: REF, nom: 'Loft Pilotable' }], config: enregistre })
  const corps = B.corps(b)
  casser.cible = B.selBien(b)
  await b.msg.enregistrerPanneau(corps, REF).catch(() => {})
  assert.equal(casser.fait, true, 'le geste a MORDU : sans ca le test ne mesure rien')
  assert.equal(b.msg.etat.panneauEnCours, false, 'les drapeaux sont rendus')
  assert.equal(b.msg.etat.modeEnCours, false)
  assert.equal(corps.querySelector('[data-panneau-save]').disabled, false,
    'le panneau est utilisable sans dependre d un rendu : l hote peut reessayer')
  assert.equal(B.pilule(b, 60).disabled, false, 'et ses pilules aussi')
  // ⚠ ET L EN-TETE AUSSI (constat 3 de la seconde revue). Ici le premier
  // re-rendu a REUSSI, donc il a gele le selecteur et les boutons de volet ;
  // c est le dernier qui leve, et `geler(corps, false)` ne les atteint pas —
  // ils vivent hors du corps. Sans `gelerEnTete(false)` dans ce `catch`, ils
  // restaient desarmes sans aucun chemin de retour.
  assert.equal(B.boutonVolet(b, 'programmes').disabled, false, 'les boutons de volet sont rendus')
  b.fermer()
})

// ── La recette du 29 octobre 2026 : un refus de garde ne peut pas etre muet ─

test('LE TEST QUI COMPTE : « Enregistrer » refuse en le DISANT, et n envoie rien', async () => {
  // ⚠ SECONDE ANOMALIE DE LA RECETTE, non reproduite par Thierry : « sortie du
  // manuel -> 1 h -> Enregistrer n a pas ete conserve ». Je n ai pas su
  // reproduire la perte ; j ai trouve le seul chemin par lequel « Enregistrer »
  // pouvait ne RIEN faire sans RIEN dire — sa garde de reentrance. Le bouton est
  // normalement `disabled` dans cet etat, mais `off` est pose au RENDU : si
  // `modeEnCours` passe a vrai sans qu un rendu suive, le DOM reste a vif et la
  // garde mord en silence.
  const envoyes = []
  const b = B.monter({ appel: async (chemin, corps) => { if (corps) envoyes.push(corps); return {} } })
  B.peupler(b, {
    biens: [{ ref: REF, nom: 'Loft Pilotable' }],
    config: { [REF]: { mode: 'test', delais: { reponse_ia: 15, alerte_info: 0 } } }
  })
  // Une autre ecriture est en vol, et le DOM ne le sait pas encore.
  b.msg.etat.modeEnCours = true
  await b.msg.enregistrerPanneau(B.corps(b), REF)
  assert.equal(b.note(), FR['messages.reglage_en_cours'], 'le refus se dit')
  assert.equal(b.noteOk(), false)
  assert.equal(envoyes.length, 0, 'et rien ne part')
  // Et le re-rendu a repare l incoherence : le bouton montre l etat reel.
  assert.equal(B.boutonSave(b).disabled, true, 'le bouton est repeint desarme')
  b.fermer()
})

test('LE TEST QUI COMPTE : une pause refusee ne laisse pas la case MENTIR', async () => {
  // Ici le silence est pire : le `change` a DEJA bascule la case a l ecran. Un
  // `return` muet laissait l hote lire « en pause » alors que rien n etait
  // ecrit — un ecran qui affirme ce qui n est pas, la famille de defaut que ce
  // chantier passe son temps a fermer.
  const envoyes = []
  const b = B.monter({ appel: async (chemin, corps) => { if (corps) envoyes.push(corps); return {} } })
  B.peupler(b, {
    biens: [{ ref: REF, nom: 'Loft Pilotable' }],
    config: { [REF]: { mode: 'test', delais: { reponse_ia: 15, alerte_info: 0 } } },
    pauses: {}
  })
  assert.equal(B.casePause(b).checked, false, 'au depart, pas en pause')
  b.msg.etat.modeEnCours = true
  B.changer(b, B.casePause(b), true)
  await B.reposer(b)
  assert.equal(b.note(), FR['messages.reglage_en_cours'], 'le refus se dit')
  assert.equal(envoyes.length, 0, 'rien n est ecrit')
  assert.equal(B.casePause(b).checked, false,
    'et la case est remise sur l etat REEL, pas sur le geste refuse')
  b.fermer()
})

// ── Les constats de la revue du correctif de recette ──────────────────────

test('LE TEST QUI COMPTE : un refus ne DETRUIT PAS la saisie non enregistree', async () => {
  // Constat 2 de la revue, mesure : mon premier jet appelait `renderTiroir()`
  // pour repeindre le bouton desarme. Il reconstruit le volet depuis `etat`,
  // donc il effacait tout ce qui ne vit que dans le DOM — les consignes de l IA
  // et les destinataires d alerte en cours de frappe. Et la note invitait a
  // recommencer un geste dont l entree venait d etre detruite.
  const b = B.monter({ appel: async () => ({}) })
  B.peupler(b, {
    biens: [{ ref: REF, nom: 'Loft Pilotable' }],
    config: { [REF]: { mode: 'test', delais: { reponse_ia: 15, alerte_info: 0 } } },
    prompting: { global: 'ancien global', overrides: {} }
  })
  const champ = B.corps(b).querySelector('[data-consignes="bien"]')
  const mail = B.corps(b).querySelector('[data-alerte="intervention|email_lines"]')
  champ.value = 'CONSIGNE-TAPEE-A-LA-MAIN'
  mail.value = 'nouveau@exemple.test'
  b.msg.etat.modeEnCours = true
  await b.msg.enregistrerPanneau(B.corps(b), REF)
  assert.equal(b.note(), FR['messages.reglage_en_cours'], 'le refus se dit')
  assert.equal(B.corps(b).querySelector('[data-consignes="bien"]').value,
    'CONSIGNE-TAPEE-A-LA-MAIN', 'sa consigne est toujours la')
  assert.equal(B.corps(b).querySelector('[data-alerte="intervention|email_lines"]').value,
    'nouveau@exemple.test', 'et son destinataire aussi')
  b.fermer()
})

test('LE TEST QUI COMPTE : un refus de pause survit au « Enregistre » de l ecriture en cours', async () => {
  // Constat 4 de la revue, mesure : `enregistrerPanneau` pose TOUJOURS une note
  // en sortant, donc son « Enregistré » VERT ecrasait le refus du kill switch
  // quelques centaines de millisecondes plus tard. L hote finissait sur un
  // succes alors que sa pause n avait pas pris — « croire l IA en pause pendant
  // qu elle envoie est le pire des silences ».
  let debloquer = null
  const envoyes = []
  const enregistre = { [REF]: { mode: 'test', delais: { reponse_ia: 15, alerte_info: 0 } } }
  const b = B.monter({
    appel: async (chemin, corps) => {
      if (corps) envoyes.push(chemin)
      if (corps && corps.apercu === true) {
        await new Promise(r => { debloquer = r })
        return { ok: true, delais_ref: REF, apercu: { ok: true, echues: 0 } }
      }
      if (!corps) return { config: enregistre }
      return { ok: true, delais_ref: REF, brouillons: { ok: true, desarmes: 0, rearmes: 0, deja_prises: 0 } }
    }
  })
  B.peupler(b, { biens: [{ ref: REF, nom: 'Loft Pilotable' }], config: enregistre, pauses: {} })
  const promesse = b.msg.enregistrerPanneau(B.corps(b), REF)
  await new Promise(r => setTimeout(r, 0))
  // L hote coupe l automatique PENDANT l enregistrement : c est un geste
  // d urgence, il ne regarde pas si une autre ecriture est en vol.
  await b.msg.basculerPause(REF, true)
  assert.equal(b.note(), FR['messages.reglage_en_cours'], 'le refus se dit tout de suite')
  assert.ok(!envoyes.includes('/api/property-automation'), 'et rien n est ecrit')
  debloquer()
  await promesse
  assert.ok(b.note().includes(FR['messages.reglage_en_cours']),
    'le refus du kill switch survit a la note de l enregistrement')
  assert.equal(b.noteOk(), false, 'et il emporte le vert : la pause n a pas pris')
  b.fermer()
})

test('LE TEST QUI COMPTE : la sequence de la recette, de bout en bout', async () => {
  // ⚠ CETTE SEQUENCE ETAIT AFFIRMEE DANS LA SPEC SANS LAISSER DE TRACE QUI
  // ROUGIRAIT (constat 8 de la revue) : « j ai rejoue la sequence exacte dans
  // le banc, le chemin nominal est sain ». Une mesure qui ne vit que dans une
  // phrase ne peut pas se dementir. La voici, executee.
  const envoyes = []
  const base = { [REF]: { mode: 'test', delais: { reponse_ia: null, alerte_info: 0 } } }
  const b = B.monter({
    appel: async (chemin, corps) => {
      if (corps) envoyes.push(corps)
      if (corps && corps.apercu === true) return { ok: true, delais_ref: REF, apercu: { ok: true, echues: 1 } }
      if (corps && corps.delais_ref) return { ok: true, delais_ref: REF, delais: corps.delais, brouillons: { ok: true, desarmes: 0, rearmes: 1, deja_prises: 0 } }
      if (!corps) return { config: base }
      return { ok: true }
    }
  })
  await B.amorcer(b)
  B.peupler(b, { biens: [{ ref: REF, nom: 'Loft Pilotable' }], config: base, pauses: {} })
  B.clic(b, B.pilManuel(b))                       // sortie du manuel
  B.clic(b, B.pilule(b, 60))                      // 1 h
  B.clic(b, B.boutonSave(b))                      // Enregistrer
  await B.reposer(b, 6)
  assert.deepEqual(b.confirmations, [
    FR['messages.mode_confirm_auto'],
    FR['messages.delai_arriere_confirm'].split('{n}').join('1')
  ], 'les DEUX confirmations sortent, dans cet ordre, avec leur texte')
  const reels = envoyes.filter(c => c.delais_ref && c.apercu !== true)
  assert.equal(reels.length, 1)
  assert.equal(reels[0].delais.reponse_ia, 60, 'et le reglage choisi est bien celui qui part')
  assert.equal(reels[0].propager, true)
  assert.equal(b.note(), FR['messages.panneau_saved'])
  b.fermer()
})

test('LE TEST QUI COMPTE : un ECHEC du desarmement ne se deguise pas en choix de l hote', async () => {
  // ⚠ CONSTAT 4 D UNE REVUE, MESURE : je posais `gardees = ap.echues` des la
  // question, donc quand l ecriture echouait la note disait, dans la meme
  // phrase, « Non enregistré : les propositions déjà en attente » ET
  // « 4 proposition(s) sont gardées pour votre validation ». Rien n etait
  // garde : les 4 gardaient leur echeance et partaient. `gardees` ne vient
  // plus que du bilan du SERVEUR.
  const { b } = bancEnregistrement({
    echues: 4, confirme: false, brouillons: { ok: false, motif: 'ecriture_impossible' }
  })
  // ⚠ IL FAUT SORTIR DU MANUEL : sous `reponse_ia: null` l apercu est saute,
  // donc la question n est jamais posee et `garder` reste faux — le test
  // mesurerait un autre chemin. `confirme: false` refuse les DEUX
  // confirmations, donc on pose la valeur directement.
  b.msg.delaisEnCours(REF).reponse_ia = 15
  await b.msg.enregistrerPanneau(B.corps(b), REF)
  assert.match(b.note(), /Non enregistré/)
  assert.ok(!/gardées pour votre validation/.test(b.note()),
    'aucune promesse de garde quand rien n a ete garde')
  assert.equal(b.noteOk(), false)
  b.fermer()
})

test('LE TEST QUI COMPTE : sous « garder », `deja_prises` se dit AUSSI', async () => {
  // ⚠ CONSTAT 3 D UNE REVUE : ma chaine de `else if` rendait cette branche
  // INATTEIGNABLE sous « garder ». Le serveur pouvait rendre « 1 gardee,
  // 8 deja prises » et l ecran affichait une note VERTE qui ne parlait que de
  // la premiere — alors que `deja_prises` est le SEUL cas ou un message peut
  // partir avec le reglage d avant.
  const { b } = bancEnregistrement({
    echues: 9, confirme: false,
    brouillons: { ok: true, desarmes: 1, rearmes: 0, inchanges: 0, deja_prises: 8 }
  })
  b.msg.delaisEnCours(REF).reponse_ia = 15
  await b.msg.enregistrerPanneau(B.corps(b), REF)
  assert.match(b.note(), /Non enregistré/, 'les 8 deja prises se disent')
  assert.match(b.note(), /8 proposition/)
  assert.match(b.note(), /gardées pour votre validation/, 'et la garde se dit aussi')
  assert.equal(b.noteOk(), false, 'la note n est pas verte : des messages peuvent partir')
  b.fermer()
})

test('LE TEST QUI COMPTE : si les propositions annoncees ont QUITTE la file, la note le dit', async () => {
  // ⚠ CONSTAT 1 DE LA RE-REVUE, mesure au banc : l apercu annonce 4 echues, et
  // le serveur rend `ok:true desarmes:0 deja_prises:0`. La note disait
  // « Enregistré », VERTE, sans un mot — et le fil n etait meme pas relu, donc
  // il gardait a l ecran le compte a rebours de propositions deja PARTIES.
  //
  // Mecanisme : `deja_prises` ne capte que la course LECTURE -> UPDATE, quelques
  // millisecondes. La course LARGE — tout le temps pendant lequel
  // `window.confirm` bloque l hote — fait sortir la tache de
  // `pending_validation` : elle n est alors plus LUE DU TOUT, donc ni desarmee
  // ni « deja prise ». Le cron passe toutes les 5 minutes.
  const { b } = bancEnregistrement({
    echues: 4, confirme: false,
    brouillons: { ok: true, desarmes: 0, rearmes: 0, inchanges: 0, deja_prises: 0 }
  })
  b.msg.delaisEnCours(REF).reponse_ia = 15
  const avant = b.tables.filter(x => x === 'agent_tasks').length
  await b.msg.enregistrerPanneau(B.corps(b), REF)
  assert.match(b.note(), /4 proposition\(s\) annoncée\(s\) n’étaient plus en attente/,
    'les 4 annoncees ont disparu, et ca se dit')
  assert.equal(b.noteOk(), false, 'la note n est pas verte : des messages sont partis')
  assert.ok(!/^Enregistré$/.test(b.note()))
  assert.ok(b.tables.filter(x => x === 'agent_tasks').length > avant,
    'et le fil est relu : il gardait des comptes a rebours perimes')
  b.fermer()
})

test('aucun ecart annonce/realise : la note reste simple et verte', async () => {
  // La borne de l autre cote : sans ecart, aucune phrase de plus.
  const { b } = bancEnregistrement({
    echues: 2, confirme: false,
    brouillons: { ok: true, desarmes: 2, rearmes: 0, inchanges: 0, deja_prises: 0 }
  })
  b.msg.delaisEnCours(REF).reponse_ia = 15
  await b.msg.enregistrerPanneau(B.corps(b), REF)
  assert.match(b.note(), /^Enregistré\. 2 proposition\(s\) déjà en attente sont gardées/)
  assert.ok(!/plus en attente/.test(b.note()), 'aucune phrase d ecart')
  assert.equal(b.noteOk(), true)
  b.fermer()
})
