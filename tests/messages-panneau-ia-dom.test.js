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
