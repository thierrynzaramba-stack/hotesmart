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
function bancEnregistrement ({ echues = 0, brouillons = { ok: true, desarmes: 0, rearmes: 2, deja_prises: 0 }, confirme = true } = {}) {
  const envoyes = []
  const b = B.monter({
    confirme,
    appel: async (chemin, corps) => {
      if (chemin.startsWith('/api/agent-config') && corps) {
        envoyes.push(corps)
        if (corps.apercu === true) return { ok: true, delais_ref: REF, apercu: { ok: true, echues } }
        if (corps.delais_ref) return { ok: true, delais_ref: REF, delais: corps.delais, brouillons }
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

test('LE TEST QUI COMPTE : refuser la liberation dit « Enregistre », pas « Non enregistre »', async () => {
  const { b, envoyes } = bancEnregistrement({ echues: 4, confirme: false })
  // L hote sort de la validation manuelle, accepte la garde du 11 octobre,
  // puis REFUSE de liberer son arriere.
  b.repondreConfirm((texte) => texte === FR['messages.mode_confirm_auto'])
  B.clic(b, B.pilManuel(b))
  await b.msg.enregistrerPanneau(B.corps(b), REF)
  assert.equal(b.note(), FR['messages.echeances_gardees_ok'])
  assert.equal(b.note(), 'Enregistré. Les propositions déjà en attente gardent leur échéance.')
  assert.equal(b.noteOk(), true, 'la note est VERTE : rien n a rate')
  // Et le reglage est bien parti, avec `propager: false` : la sourdine et les
  // delais sont enregistres, les propositions en attente gardent leur echeance.
  const reel = envoyes.filter(c => c.delais_ref && c.apercu !== true)
  assert.equal(reel.length, 1)
  assert.equal(reel[0].propager, false)
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
  assert.ok(!b.note().includes(FR['messages.echeances_gardees']),
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
  assert.ok(!b.note().includes(FR['messages.echeances_gardees']),
    'ne pas pouvoir compter n est pas un refus de l hote')
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

// ── Les six constats de la revue de ce commit ─────────────────────────────
// ⚠ CES TESTS N'EXISTAIENT PAS, ET C'EST LE VRAI CONSTAT DE LA REVUE : cinq
// affirmations de la spec et des commentaires annonçaient une couverture qui
// n'existait pas. Chacun ci-dessous a ete MESURE rouge contre `c0d1ec0d`.

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
  b.msg.etat.ouverte = null
  assert.equal(b.msg.bienDuFilOuvert(), null, 'et sans fil ouvert, rien')
  b.msg.etat.ouverte = 'B-INCONNU'
  assert.equal(b.msg.bienDuFilOuvert(), null, 'ni pour une conversation introuvable')
  b.fermer()
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
  debloquer()
  await promesse
  assert.equal(b.msg.etat.tiroirBien, REF, 'la note tombe sous le bien enregistre')
  assert.equal(B.selBien(b).disabled, false, 'et le selecteur redevient vivant')
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
  // On retire du squelette une ancre dont `renderTiroir` a besoin : il leve.
  B.selBien(b).remove()
  await assert.rejects(() => b.msg.enregistrerPanneau(B.corps(b), REF))
  assert.equal(b.msg.etat.panneauEnCours, false, 'le filet a rendu le drapeau du panneau')
  assert.equal(b.msg.etat.modeEnCours, false, 'et celui des ecritures')
  b.fermer()
})

test('LE TEST QUI COMPTE : un refus ne fabrique pas une note qui se contredit', async () => {
  // Constat 6 : avec `propager: false` le serveur n a RIEN propage — c est ce
  // qu on lui a demande — donc un bilan absent est normal. Forcer le
  // rechargement du fil ouvrait un chemin ou son echec poussait
  // `partie_brouillons`, et la note disait sur le MEME sujet, dans la meme
  // phrase : « Non enregistré : les propositions déjà en attente. Les
  // propositions déjà en attente gardent leur échéance. »
  let taches = 0
  const b = B.monter({
    confirme: (texte) => texte === FR['messages.mode_confirm_auto'],
    appel: async (chemin, corps) => {
      if (corps && corps.apercu === true) return { ok: true, delais_ref: REF, apercu: { ok: true, echues: 7 } }
      // Le serveur repond SANS bilan `brouillons` : il n a rien propage.
      if (corps && corps.delais_ref) return { ok: true, delais_ref: REF }
      if (!corps) return { config: { [REF]: { mode: 'test', delais: { reponse_ia: 15, alerte_info: 0 } } } }
      return { ok: true }
    }
  })
  B.peupler(b, {
    biens: [{ ref: REF, nom: 'Loft Pilotable' }],
    config: { [REF]: { mode: 'test', delais: { reponse_ia: null, alerte_info: 0 } } }
  })
  // ⚠ ET LA RELECTURE DES TACHES LEVE, pas « rend une erreur » : ma premiere
  // version posait `__echecTable`, et `rechargerTaches` fait `if (error)
  // return` — l echec etait avale, le chemin que ce test pretend eprouver
  // n etait jamais pris, et la mutation du correctif restait VERTE. Mesure
  // faite : 0 rouge. C est un lever qui atteint le `catch` de l appelant,
  // lequel pousse `partie_brouillons`.
  b.window.__leveTable = 'agent_tasks'
  B.clic(b, B.pilManuel(b))
  await b.msg.enregistrerPanneau(B.corps(b), REF)
  taches = b.note()
  assert.equal(taches, FR['messages.echeances_gardees_ok'],
    'son choix, dit une seule fois, et en vert')
  assert.ok(!taches.includes(FR['messages.partie_brouillons']),
    'la note ne se contredit pas sur le meme sujet')
  assert.equal(b.noteOk(), true)
  b.fermer()
})
