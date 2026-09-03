// tests/menages-public-vue-avis.test.js
// La vue « Avis » de la PWA prestataire, cote NAVIGATEUR.
//
// ⚠ POURQUOI CE TEST EXISTE. Le serveur est deja garde par
// tests/menages-public-avis.test.js — mais tout son travail se perd au dernier
// metre si l'affichage lit mal ce qu'il recoit. Deux pieges concrets :
//   1. `ratio.erreur` signale une PANNE. Un ecran qui l'ignore affiche
//      « 0 avis, 0 remarque » a une prestataire qui en a 98 ; elle en tire une
//      conclusion fausse sur son propre travail et la garde. C'est exactement ce
//      qui est arrive une fois sur pages/avis.html.
//   2. L'extrait est du texte ecrit par un voyageur. Non echappe, il s'execute.
//
// Le script de la page est inline. On en extrait le bloc « Vue Avis » et on
// l'evalue avec un DOM minimal : ce sont les VRAIES fonctions qui tournent ici,
// pas une copie qui pourrait deriver.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const HTML = fs.readFileSync(path.join(__dirname, '..', 'apps/menages/public.html'), 'utf8')

const DEBUT = '  // ─── Vue « Avis » ─'
const FIN   = '  // ─── Helpers dates ─'

function extraireBloc () {
  const i = HTML.indexOf(DEBUT)
  const j = HTML.indexOf(FIN)
  assert.ok(i > 0 && j > i, 'le bloc « Vue Avis » doit rester delimite par ses deux commentaires')
  return HTML.slice(i, j)
}

function elem (id, dataset = {}) {
  const e = {
    id, innerHTML: '', textContent: '', dataset,
    // `style.display` part de la valeur POSEE PAR LE HTML, pas de `undefined` :
    // sinon « masque » et « jamais touche » se confondent, et une mutation qui
    // supprime le masquage laisse les tests verts.
    style: { display: DEPART[id] === undefined ? '' : DEPART[id] },
    classes: new Set(),
    classList: {
      toggle (c, on) { if (on) e.classes.add(c); else e.classes.delete(c) },
      add (c) { e.classes.add(c) }, remove (c) { e.classes.delete(c) }
    },
    listeners: [],
    addEventListener (ev, fn) { e.listeners.push([ev, fn]) },
    click () { e.listeners.filter(l => l[0] === 'click').forEach(l => l[1]()) },
    querySelectorAll: () => []
  }
  return e
}

// L'etat de depart que le HTML pose reellement. Il est RELU du fichier : un
// `style="display:none"` supprime par megarde doit faire tomber un test, pas
// etre recopie ici a la main.
const DEPART = {}
for (const id of ['tabs', 'avis-vue', 'avis-ratio', 'entete-ratio']) {
  const m = HTML.match(new RegExp('id="' + id + '"[^>]*'))
  DEPART[id] = (m && /style="display:none"/.test(m[0])) ? 'none' : ''
}

test('le HTML masque les onglets et la vue Avis AU DEPART', async () => {
  // La garantie centrale du commit — self_view_reviews coupe ⇒ pas d'onglet —
  // repose d'abord sur cet attribut : si le HTML les affiche, tout le monde
  // voit l'onglet avant meme qu'une ligne de script ne tourne.
  assert.strictEqual(DEPART['tabs'], 'none', '#tabs doit partir masque')
  assert.strictEqual(DEPART['avis-vue'], 'none', '#avis-vue doit partir masque')
  assert.strictEqual(DEPART['avis-ratio'], 'none', '#avis-ratio doit partir masque')
  assert.strictEqual(DEPART['entete-ratio'], 'none', '#entete-ratio doit partir masque')
})

// Un DOM juste assez reel pour que le bloc tourne, et qui garde ce qui a ete
// ecrit dans chaque conteneur.
function contexte ({ reponses = [], enLigne = true, reveils = [] } = {}) {
  const els = new Map()
  const get = id => { if (!els.has(id)) els.set(id, elem(id)); return els.get(id) }
  const appels = []
  // Les deux vrais boutons d'onglet : sans eux, `setTab` n'est exerce par aucun
  // test et sept mutations du basculement passaient inapercues.
  const boutons = [elem('btn-planning', { tab: 'planning' }), elem('btn-avis', { tab: 'avis' })]
  els.set('tabs', Object.assign(elem('tabs'), { querySelectorAll: () => boutons }))
  const ctx = {
    console,
    document: {
      getElementById: get,
      querySelector: sel => get(sel.replace(/^[.#]/, '')),
      querySelectorAll: sel => /button/.test(sel) ? boutons : [],
      // Le vrai listener de re-sonde est branche ici : on le retient pour
      // pouvoir le declencher, au lieu de faire semblant de le couvrir.
      addEventListener (ev, fn) { if (ev === 'visibilitychange') reveils.push(fn) },
      visibilityState: 'visible'
    },
    navigator: { onLine: enLigne },
    fetch: async (url) => {
      appels.push(url)
      const r = reponses.shift()
      if (!r) throw new Error('reseau')
      if (r.jete) throw new Error('reseau')
      return { ok: r.status < 400, status: r.status, json: async () => r.body }
    },
    currentToken: 'tok-test',
    routeRender () {}
  }
  vm.createContext(ctx)
  vm.runInContext(extraireBloc(), ctx)
  // `let avisCharge` vit dans le scope lexical du script, pas sur l'objet
  // contexte : on le relit par une evaluation dans ce meme contexte.
  const lire = expr => vm.runInContext(expr, ctx)
  // Un reveil comme le navigateur en produit : l'onglet redevient visible.
  const reveiller = () => { reveils.forEach(fn => fn()) }
  return { ctx, els, get, appels, lire, boutons, reveils, reveiller }
}

const RATIO_OK = { total: 98, positif: 10, remarque: 15, rien_signale: 73, periode: 'toujours' }

// ─── Le contrat `ratio.erreur` ─────────────────────────────────────────────

test('PANNE de compteurs : jamais « 0 avis », un etat de panne explicite', async () => {
  const { ctx, get } = contexte()
  ctx.renderAvis({ autorise: true, ratio: { total: 0, positif: 0, remarque: 0, erreur: true }, avis: [] })
  const etat = get('avis-etat').innerHTML
  assert.ok(/indisponible/i.test(etat), 'l\'ecran doit dire que le service est indisponible')
  // ⚠ Assertion sur le CONTENU REEL du bloc de compteurs, pas sur une chaine
  // « 0 avis » que le gabarit n'emet jamais : la version precedente se lisait
  // comme le garde-fou du risque principal et ne testait rien.
  assert.strictEqual(get('avis-ratio').innerHTML, '', 'aucun compteur ne doit etre rendu')
  assert.strictEqual(get('avis-ratio').style.display, 'none', 'les compteurs restent caches')
  assert.strictEqual(get('avis-liste').innerHTML, '', 'et la liste aussi')
})

test('ratio ABSENT : traite comme une panne, pas comme un zero', async () => {
  // Une reponse tronquee ou un champ renomme cote serveur ne doit pas se lire
  // comme « aucun avis ».
  const { ctx, get } = contexte()
  ctx.renderAvis({ autorise: true, avis: [] })
  assert.ok(/indisponible/i.test(get('avis-etat').innerHTML))
})

test('la panne laisse la vue REESSAYABLE a la prochaine ouverture', async () => {
  const { ctx, lire } = contexte()
  ctx.renderAvis({ autorise: true, ratio: { erreur: true }, avis: [] })
  assert.strictEqual(lire('avisCharge'), false, 'rien n\'a ete affiche : il ne faut pas marquer la vue chargee')
})

// ─── Les deux etats vides, qui ne disent pas la meme chose ─────────────────

test('« aucun avis » REEL : total a zero', async () => {
  const { ctx, get } = contexte()
  ctx.renderAvis({ autorise: true, ratio: { total: 0, positif: 0, remarque: 0 }, avis: [] })
  assert.ok(/Aucun avis pour l/.test(get('avis-liste').innerHTML))
  assert.strictEqual(get('avis-ratio').style.display, '', 'le ratio s\'affiche : zero est ici un vrai resultat')
})

test('des avis, mais aucun qui parle de proprete : message DIFFERENT', async () => {
  const { ctx, get } = contexte()
  ctx.renderAvis({
    autorise: true, ratio: { total: 12, positif: 0, remarque: 0 },
    avis: [{ id: 'a', verdict: 'rien_signale', extrait: null, bien: 'COL', bienNom: 'Colomiers' }]
  })
  const html = get('avis-liste').innerHTML
  assert.ok(/Aucune mention/.test(html), 'ne pas dire « aucun avis » quand il y en a 12')
  assert.ok(!/Aucun avis pour l/.test(html))
})

// ─── La liste ──────────────────────────────────────────────────────────────

test('seuls les avis qui parlent de proprete sont listes', async () => {
  const { ctx, get } = contexte()
  ctx.renderAvis({
    autorise: true, ratio: RATIO_OK,
    avis: [
      { id: '1', verdict: 'remarque',     extrait: 'bouilloire sale',  bien: 'COL', bienNom: 'Colomiers' },
      { id: '2', verdict: 'positif',      extrait: 'impeccable',       bien: 'COL', bienNom: 'Colomiers' },
      { id: '3', verdict: 'rien_signale', extrait: null,               bien: 'COL', bienNom: 'Colomiers' }
    ]
  })
  const html = get('avis-liste').innerHTML
  assert.ok(html.includes('bouilloire sale') && html.includes('impeccable'))
  assert.strictEqual((html.match(/avis-card/g) || []).length, 2, 'l\'avis sans mention n\'a pas sa place dans la liste')
  // Le ratio garde le TOTAL reel : les deux chiffres ne disent pas la meme chose
  // et l'ecran doit porter les deux.
  assert.ok(get('avis-ratio').innerHTML.includes('98'))
})

test('l\'etiquette « retour prive » n\'apparait que quand elle est posee', async () => {
  const { ctx, get } = contexte()
  ctx.renderAvis({
    autorise: true, ratio: RATIO_OK,
    avis: [
      { id: '1', verdict: 'remarque', extrait: 'un', bien: 'C', bienNom: 'C', prive: true },
      { id: '2', verdict: 'remarque', extrait: 'deux', bien: 'C', bienNom: 'C', prive: false }
    ]
  })
  assert.strictEqual((get('avis-liste').innerHTML.match(/retour privé/g) || []).length, 1)
})

test('un extrait hostile est ECHAPPE', async () => {
  // L'extrait vient d'un voyageur. Il finit dans un innerHTML.
  const { ctx, get } = contexte()
  ctx.renderAvis({
    autorise: true, ratio: RATIO_OK,
    avis: [{ id: '1', verdict: 'remarque', bien: 'C', bienNom: '<b>x</b>',
             extrait: '<img src=x onerror="alert(1)">' }]
  })
  const html = get('avis-liste').innerHTML
  assert.ok(!html.includes('<img'), 'la balise ne doit pas etre injectee')
  // `onerror=` subsiste comme TEXTE, et c'est inoffensif ; ce qui compte est
  // que le guillemet soit echappe, donc qu'aucun attribut ne se referme.
  assert.ok(!html.includes('onerror="'), 'l\'attribut ne doit pas pouvoir se former')
  assert.ok(!html.includes('<b>x</b>'), 'le nom du bien est echappe lui aussi')
  assert.ok(html.includes('&lt;img'))
})

test('l\'identifiant technique du bien ne s\'affiche pas quand le nom manque', async () => {
  const { ctx, get } = contexte()
  ctx.renderAvis({
    autorise: true, ratio: RATIO_OK,
    avis: [{ id: '1', verdict: 'remarque', extrait: 'x', bien: '287031', bienNom: null }]
  })
  assert.ok(!get('avis-liste').innerHTML.includes('287031'), '« 287031 » ne dit rien a une femme de menage')
})

// ─── La sonde de demarrage : qui voit l'onglet ─────────────────────────────

test('self_view_reviews coupe : PAS d\'onglet', async () => {
  const { ctx, get } = contexte({ reponses: [{ status: 200, body: { prenom: 'Régina', autorise: false, ratio: null, avis: [] } }] })
  await ctx.initAvis()
  assert.strictEqual(get('tabs').style.display, 'none', 'l\'onglet ne doit meme pas apparaitre')
})

test('profil desactive : PAS d\'onglet', async () => {
  const { ctx, get } = contexte({ reponses: [{ status: 200, body: { actif: false, ratio: null, avis: [] } }] })
  await ctx.initAvis()
  assert.strictEqual(get('tabs').style.display, 'none')
})

test('hors ligne : PAS d\'onglet, et surtout aucune exception', async () => {
  const { ctx, get } = contexte({ reponses: [{ jete: true }] })
  await ctx.initAvis()
  assert.strictEqual(get('tabs').style.display, 'none')
})

test('token refuse : PAS d\'onglet', async () => {
  const { ctx, get } = contexte({ reponses: [{ status: 401, body: { error: 'Token invalide' } }] })
  await ctx.initAvis()
  assert.strictEqual(get('tabs').style.display, 'none')
})

test('autorisee : l\'onglet apparait', async () => {
  const { ctx, get } = contexte({ reponses: [{ status: 200, body: { prenom: 'Régina', autorise: true, ratio: RATIO_OK, avis: [] } }] })
  await ctx.initAvis()
  assert.strictEqual(get('tabs').style.display, '')
})

test('503 a la sonde : l\'onglet apparait, en etat de panne', async () => {
  // Masquer sur 503 ferait passer une panne pour un droit retire — et la
  // prestataire n'aurait aucun moyen de savoir qu'il faut reessayer.
  const { ctx, get } = contexte({ reponses: [{ status: 503, body: { error: 'Service temporairement indisponible' } }] })
  await ctx.initAvis()
  assert.strictEqual(get('tabs').style.display, '')
})

test('la sonde ne demande PAS la liste : un seul aller-retour, sans detail', async () => {
  const { ctx, appels } = contexte({ reponses: [{ status: 200, body: { autorise: true, ratio: RATIO_OK, avis: [] } }] })
  await ctx.initAvis()
  assert.strictEqual(appels.length, 1)
  assert.ok(!appels[0].includes('detail=1'), 'la vue par defaut n\'a pas besoin de la liste')
})

// ─── Le chargement de la liste ─────────────────────────────────────────────

test('503 au chargement : « service indisponible », jamais une liste vide', async () => {
  const { ctx, get, lire } = contexte({ reponses: [{ status: 503, body: { error: 'x' } }] })
  await ctx.chargerAvis()
  assert.ok(/indisponible/i.test(get('avis-etat').innerHTML))
  assert.strictEqual(lire('avisCharge'), false)
})

test('panne reseau au chargement : etat de panne, pas « aucun avis »', async () => {
  const { ctx, get } = contexte({ reponses: [{ jete: true }] })
  await ctx.chargerAvis()
  assert.ok(/indisponible/i.test(get('avis-etat').innerHTML))
  assert.ok(!/Aucun avis/.test(get('avis-etat').innerHTML))
})

test('droit retire ENTRE la sonde et le clic : l\'onglet disparait', async () => {
  const { ctx, get } = contexte({ reponses: [{ status: 200, body: { prenom: 'R', autorise: false, ratio: null, avis: [] } }] })
  await ctx.chargerAvis()
  assert.strictEqual(get('tabs').style.display, 'none')
  assert.strictEqual(get('avis-liste').innerHTML, '', 'et rien n\'est affiche')
})

test('chargement reussi : la liste est demandee AVEC detail=1', async () => {
  const { ctx, appels } = contexte({ reponses: [{ status: 200, body: { autorise: true, ratio: RATIO_OK, avis: [] } }] })
  await ctx.chargerAvis()
  assert.ok(appels[0].includes('detail=1'))
  assert.ok(appels[0].includes('action=avis'))
})

// ─── Le basculement d'onglet ───────────────────────────────────────────────
// Sept mutations du basculement survivaient aux tests : `setTab` n'etait exerce
// par aucun d'eux, faute de boutons dans le DOM factice.

test('passer sur Avis masque le planning et son bouton de filtres', async () => {
  const { ctx, get } = contexte({ reponses: [{ status: 200, body: { autorise: true, ratio: RATIO_OK, avis: [] } }] })
  ctx.setTab('avis')
  assert.strictEqual(get('menage-layout').style.display, 'none', 'le planning ne doit pas rester affiche sous la vue Avis')
  assert.strictEqual(get('avis-vue').style.display, '')
  assert.strictEqual(get('fab-filters').style.display, 'none', 'le bouton Filtres n\'a rien a filtrer ici')
})

test('revenir sur Planning re-rend le planning et rend le bouton de filtres', async () => {
  const { ctx, get } = contexte({ reponses: [{ status: 200, body: { autorise: true, ratio: RATIO_OK, avis: [] } }] })
  let rendus = 0
  ctx.routeRender = () => { rendus++ }
  ctx.setTab('avis')
  ctx.setTab('planning')
  assert.strictEqual(get('menage-layout').style.display, '')
  assert.strictEqual(get('avis-vue').style.display, 'none')
  assert.strictEqual(get('fab-filters').style.display, '')
  assert.ok(rendus >= 1, 'le planning doit etre re-rendu au retour')
})

test('le premier passage sur Avis DECLENCHE le chargement', async () => {
  // Sans cet appel, l'ecran reste sur « Chargement… » indefiniment.
  const { ctx, appels } = contexte({ reponses: [{ status: 200, body: { autorise: true, ratio: RATIO_OK, avis: [] } }] })
  ctx.setTab('avis')
  await new Promise(r => setImmediate(r))
  assert.strictEqual(appels.length, 1)
  assert.ok(appels[0].includes('detail=1'))
})

test('les boutons d\'onglet sont REELLEMENT branches', async () => {
  // `dataset.tab` renomme d'un cote et pas de l'autre rendait les deux onglets
  // inertes sans qu'aucun test ne bronche.
  const { ctx, get, boutons } = contexte({ reponses: [{ status: 200, body: { autorise: true, ratio: RATIO_OK, avis: [] } }] })
  await ctx.initAvis()
  boutons.find(b => b.dataset.tab === 'avis').click()
  assert.strictEqual(get('avis-vue').style.display, '', 'un clic sur « Avis » doit ouvrir la vue')
  boutons.find(b => b.dataset.tab === 'planning').click()
  assert.strictEqual(get('avis-vue').style.display, 'none')
})

// ─── Un avis sans extrait ──────────────────────────────────────────────────

test('une remarque SANS extrait ne produit pas une carte muette', async () => {
  // L'etage 1 de la classification (regle sur les tags Airbnb) ne pose JAMAIS
  // d'extrait, et la requalification par l'hote l'efface. Une carte rouge vide
  // serait un reproche que la prestataire ne peut ni verifier ni situer.
  const { ctx, get } = contexte()
  ctx.renderAvis({
    autorise: true, ratio: RATIO_OK,
    avis: [{ id: '1', verdict: 'remarque', extrait: null, bien: 'C', bienNom: 'Colomiers' }]
  })
  const html = get('avis-liste').innerHTML
  assert.ok(html.includes('avis-card'), 'la carte reste listee : l\'information la concerne')
  assert.ok(/sans détail rapporté/.test(html), 'et elle dit qu\'aucun detail n\'a ete rapporte')
  assert.ok(!/<div class="avis-texte"><\/div>/.test(html), 'jamais un bloc de texte vide')
})

test('un avis positif sans extrait le dit aussi', async () => {
  const { ctx, get } = contexte()
  ctx.renderAvis({
    autorise: true, ratio: RATIO_OK,
    avis: [{ id: '1', verdict: 'positif', extrait: null, bien: 'C', bienNom: 'C' }]
  })
  assert.ok(/sans commentaire détaillé/.test(get('avis-liste').innerHTML))
})

// ─── Le comptage partiel ───────────────────────────────────────────────────

test('un comptage TRONQUE est annonce comme partiel', async () => {
  // Meme famille que la panne affichee en « 0 avis » : un chiffre partiel lu
  // comme un total est une conclusion fausse.
  const { ctx, get } = contexte()
  ctx.renderAvis({ autorise: true, ratio: { ...RATIO_OK, tronque: true }, avis: [] })
  assert.ok(/qu'une partie/.test(get('avis-ratio').innerHTML))
})

test('une LISTE tronquee est annoncee elle aussi', async () => {
  const { ctx, get } = contexte()
  ctx.renderAvis({ autorise: true, ratio: RATIO_OK, listeTronquee: true, avis: [] })
  assert.ok(/qu'une partie/.test(get('avis-ratio').innerHTML))
})

test('sans troncature, aucune mention parasite', async () => {
  const { ctx, get } = contexte()
  ctx.renderAvis({ autorise: true, ratio: RATIO_OK, avis: [] })
  assert.ok(!/qu'une partie/.test(get('avis-ratio').innerHTML))
})

// ─── Un ratio incomplet ────────────────────────────────────────────────────

test('un champ de compteur manquant est traite comme une panne', async () => {
  // `undefined avis pris en compte` vaudrait le « 0 avis » que tout ceci evite.
  const { ctx, get } = contexte()
  ctx.renderAvis({ autorise: true, ratio: { total: 98, positif: 10 }, avis: [] })
  assert.ok(/indisponible/i.test(get('avis-etat').innerHTML))
  assert.ok(!/undefined/.test(get('avis-ratio').innerHTML))
})

// ─── Le ratio permanent de l'en-tête ───────────────────────────────────────
// Il est visible sur tous les onglets, dès l'ouverture. C'est un rappel
// d'objectif quotidien : il doit être JUSTE ou absent, jamais approximatif.

test('la sonde remplit l\'en-tête dès l\'ouverture, sans ouvrir l\'onglet', async () => {
  const { ctx, get } = contexte({ reponses: [{ status: 200, body: { prenom: 'Régina', autorise: true, ratio: RATIO_OK, avis: [] } }] })
  await ctx.initAvis()
  const html = get('entete-ratio').innerHTML
  assert.strictEqual(get('entete-ratio').style.display, '')
  // Les deux chiffres sont lus dans LEUR bloc respectif : `/10/` passerait sur
  // n'importe quel « 10 » de la page, y compris celui d'un autre compteur.
  const pos = html.match(/ratio-item pos[^>]*>(.*?)<\/span>/s)
  const neg = html.match(/ratio-item neg[^>]*>(.*?)<\/span>/s)
  assert.ok(pos && /(^|>)10$/.test(pos[1].trim()), 'propretés saluées : ' + (pos && pos[1]))
  assert.ok(neg && /(^|>)15$/.test(neg[1].trim()), 'remarques : ' + (neg && neg[1]))
  assert.ok(/98 avis/.test(html), 'avec le total')
})

test('la période réglée par l\'hôte est ÉCRITE à côté du ratio', async () => {
  // « 10 / 11 » ne veut rien dire sans sa période : sur 15 jours ou depuis le
  // début, ce n'est pas le même résultat.
  for (const [cle, libelle] of [['15j', 'sur 15 jours'], ['30j', 'sur 30 jours'],
                                ['6mois', 'sur 6 mois'], ['toujours', 'depuis le début']]) {
    const { ctx, get } = contexte({ reponses: [{ status: 200, body: { autorise: true, ratio: { ...RATIO_OK, periode: cle }, avis: [] } }] })
    await ctx.initAvis()
    assert.ok(get('entete-ratio').innerHTML.includes(libelle), `${cle} doit s'afficher « ${libelle} »`)
  }
})

test('PANNE de compteurs : l\'en-tête reste VIDE, jamais un faux chiffre', async () => {
  const { ctx, get } = contexte({ reponses: [{ status: 200, body: { autorise: true, ratio: { total: 0, positif: 0, remarque: 0, erreur: true }, avis: [] } }] })
  await ctx.initAvis()
  assert.strictEqual(get('entete-ratio').style.display, 'none')
  assert.strictEqual(get('entete-ratio').innerHTML, '')
})

test('comptage TRONQUÉ : pas de ratio permanent non plus', async () => {
  // Un chiffre partiel affiché en permanence, sans place pour l'expliquer,
  // se lirait comme le total. L'onglet Avis, lui, le dit.
  const { ctx, get } = contexte({ reponses: [{ status: 200, body: { autorise: true, ratio: { ...RATIO_OK, tronque: true }, avis: [] } }] })
  await ctx.initAvis()
  assert.strictEqual(get('entete-ratio').style.display, 'none')
})

test('self_view_reviews coupé : ni onglet NI ratio permanent', async () => {
  const { ctx, get } = contexte({ reponses: [{ status: 200, body: { prenom: 'R', autorise: false, ratio: null, avis: [] } }] })
  await ctx.initAvis()
  assert.strictEqual(get('tabs').style.display, 'none')
  assert.strictEqual(get('entete-ratio').style.display, 'none')
  assert.strictEqual(get('entete-ratio').innerHTML, '')
})

test('droit retiré entre la sonde et le clic : l\'en-tête se vide aussi', async () => {
  const { ctx, get } = contexte({ reponses: [
    { status: 200, body: { autorise: true, ratio: RATIO_OK, avis: [] } },
    { status: 200, body: { autorise: false, ratio: null, avis: [] } }
  ] })
  await ctx.initAvis()
  assert.strictEqual(get('entete-ratio').style.display, '')
  await ctx.chargerAvis()
  assert.strictEqual(get('entete-ratio').style.display, 'none', 'un ratio survivant au retrait du droit serait une fuite')
})

// ─── Les dates : identifier LE ménage ──────────────────────────────────────

test('un séjour complet s\'affiche comme un séjour', async () => {
  const { ctx, get } = contexte()
  ctx.renderAvis({ autorise: true, ratio: RATIO_OK, avis: [
    { id: '1', verdict: 'remarque', extrait: 'x', bien: 'C', bienNom: 'C',
      sejourDebut: '2026-08-12', sejourFin: '2026-08-15', recuLe: '2026-09-03T10:00:00Z' }
  ] })
  const html = get('avis-liste').innerHTML
  assert.ok(/Séjour du 12 au 15 août 2026/.test(html), html)
  assert.ok(!/reçu/i.test(html), 'la date de réception n\'a rien à faire là quand le séjour est connu')
})

test('séjour à cheval sur deux mois : les deux mois sont écrits', async () => {
  const { ctx, get } = contexte()
  ctx.renderAvis({ autorise: true, ratio: RATIO_OK, avis: [
    { id: '1', verdict: 'remarque', extrait: 'x', bien: 'C', bienNom: 'C',
      sejourDebut: '2026-07-30', sejourFin: '2026-08-02', recuLe: null }
  ] })
  assert.ok(/Séjour du 30 juillet au 2 août 2026/.test(get('avis-liste').innerHTML))
})

test('sans séjour, la date de réception est ÉTIQUETÉE comme telle', async () => {
  // Jamais présentée comme un séjour : la prestataire irait chercher le mauvais
  // ménage. Rien d'inventé, jamais.
  const { ctx, get } = contexte()
  ctx.renderAvis({ autorise: true, ratio: RATIO_OK, avis: [
    { id: '1', verdict: 'remarque', extrait: 'x', bien: 'C', bienNom: 'C',
      sejourDebut: null, sejourFin: null, recuLe: '2026-09-03T10:00:00Z' }
  ] })
  const html = get('avis-liste').innerHTML
  assert.ok(/Avis reçu le 3 septembre 2026/.test(html), html)
  assert.ok(!/Séjour/.test(html), 'aucune mention de séjour quand il n\'est pas connu')
})

test('seule la fin de séjour connue : dit « terminé le »', async () => {
  const { ctx, get } = contexte()
  ctx.renderAvis({ autorise: true, ratio: RATIO_OK, avis: [
    { id: '1', verdict: 'remarque', extrait: 'x', bien: 'C', bienNom: 'C',
      sejourDebut: null, sejourFin: '2026-08-15', recuLe: '2026-09-03T10:00:00Z' }
  ] })
  assert.ok(/Séjour terminé le 15 août 2026/.test(get('avis-liste').innerHTML))
})

test('aucune date du tout : aucune date affichée, et pas de plantage', async () => {
  const { ctx, get } = contexte()
  ctx.renderAvis({ autorise: true, ratio: RATIO_OK, avis: [
    { id: '1', verdict: 'remarque', extrait: 'x', bien: 'C', bienNom: 'C',
      sejourDebut: null, sejourFin: null, recuLe: null }
  ] })
  const html = get('avis-liste').innerHTML
  assert.ok(html.includes('avis-card'))
  assert.ok(!/Séjour|reçu/i.test(html))
})

test('une date illisible ne devient pas « Invalid Date »', async () => {
  const { ctx, get } = contexte()
  ctx.renderAvis({ autorise: true, ratio: RATIO_OK, avis: [
    { id: '1', verdict: 'remarque', extrait: 'x', bien: 'C', bienNom: 'C',
      sejourDebut: 'pas-une-date', sejourFin: null, recuLe: '2026-09-03T10:00:00Z' }
  ] })
  const html = get('avis-liste').innerHTML
  assert.ok(!/Invalid/.test(html))
  assert.ok(/Avis reçu le/.test(html), 'on retombe sur la date de réception, étiquetée')
})

// ─── Le fuseau du téléphone ne doit pas décaler un séjour ──────────────────
// ⚠ `stay_start` / `stay_end` sont des colonnes `date` : PostgREST rend
// « 2026-08-15 », que `new Date` lit à MINUIT UTC. Formaté en heure locale, ce
// jour s'affiche « 14 août » à l'ouest de Greenwich. Une prestataire en
// Guadeloupe, Martinique ou Guyane — marchés francophones visés — lirait un
// séjour décalé d'un jour et chercherait le mauvais ménage.
//
// Ces tests FORCENT le fuseau : verts sur une machine à Paris, ils resteraient
// aveugles au défaut. C'est la règle 8 de REVIEW.md — tester le cas dangereux,
// pas sa version confortable.

function sousFuseau (tz, fn) {
  const avant = process.env.TZ
  process.env.TZ = tz
  try { return fn() } finally {
    if (avant === undefined) delete process.env.TZ; else process.env.TZ = avant
  }
}

for (const tz of ['America/Guadeloupe', 'America/New_York', 'Pacific/Honolulu']) {
  test(`séjour non décalé sous ${tz}`, async () => {
    sousFuseau(tz, () => {
      const { ctx, get } = contexte()
      ctx.renderAvis({ autorise: true, ratio: RATIO_OK, avis: [
        { id: '1', verdict: 'remarque', extrait: 'x', bien: 'C', bienNom: 'C',
          sejourDebut: '2026-08-12', sejourFin: '2026-08-15', recuLe: null }
      ] })
      assert.ok(/Séjour du 12 au 15 août 2026/.test(get('avis-liste').innerHTML),
        `décalage sous ${tz} : ` + get('avis-liste').innerHTML)
    })
  })
}

test('séjour à cheval sur deux mois : la forme ne change pas avec le fuseau', async () => {
  // Un séjour du 31 juillet au 2 août lu à l'ouest deviendrait « du 30 au 1er »,
  // donc une autre forme de phrase — et une autre date.
  for (const tz of ['Europe/Paris', 'America/Guadeloupe', 'Pacific/Auckland']) {
    sousFuseau(tz, () => {
      const { ctx, get } = contexte()
      ctx.renderAvis({ autorise: true, ratio: RATIO_OK, avis: [
        { id: '1', verdict: 'remarque', extrait: 'x', bien: 'C', bienNom: 'C',
          sejourDebut: '2026-07-31', sejourFin: '2026-08-02', recuLe: null }
      ] })
      assert.ok(/Séjour du 31 juillet au 2 août 2026/.test(get('avis-liste').innerHTML),
        `sous ${tz} : ` + get('avis-liste').innerHTML)
    })
  }
})

test('la sonde vide l\'en-tête quand le droit n\'est pas là', async () => {
  // Ne pas compter sur l'état initial du HTML : c'est une coïncidence qui
  // protège, pas le code.
  const { ctx, get } = contexte({ reponses: [{ status: 200, body: { autorise: false, ratio: null, avis: [] } }] })
  get('entete-ratio').innerHTML = '<span>ratio périmé</span>'
  get('entete-ratio').style.display = ''
  await ctx.initAvis()
  assert.strictEqual(get('entete-ratio').innerHTML, '')
  assert.strictEqual(get('entete-ratio').style.display, 'none')
})

// ─── Le re-sondage au retour au premier plan ───────────────────────────────

test('re-sonder n\'empile pas les écouteurs d\'onglets', async () => {
  // ⚠ UN SEUL TAP LANÇAIT AUTANT DE CHARGEMENTS QU'IL Y AVAIT EU DE RÉVEILS.
  // `montrerOnglets` posait une flèche anonyme par appel, et `avisCharge` ne
  // passe à true qu'après le premier `await` : aucun des appels concurrents ne
  // s'arrêtait. Mesuré avant correctif : 3 sondes = 3 fetchs pour un clic.
  const ok = { status: 200, body: { autorise: true, ratio: RATIO_OK, avis: [] } }
  const { ctx, boutons, appels } = contexte({ reponses: [ok, ok, ok, ok, ok, ok] })
  await ctx.initAvis()
  await ctx.initAvis()
  await ctx.initAvis()
  const btnAvis = boutons.find(b => b.dataset.tab === 'avis')
  assert.strictEqual(btnAvis.listeners.length, 1, 'un seul écouteur, quel que soit le nombre de sondes')
  const avant = appels.length
  btnAvis.click()
  await new Promise(r => setImmediate(r))
  assert.strictEqual(appels.length - avant, 1, 'un clic = un chargement')
})

test('hors ligne, le retour au premier plan NE VIDE PAS la liste affichée', async () => {
  // La prestataire qui lit ses extraits en sous-sol, met l'appli en fond et
  // revient, gardait un écran illisible « Service indisponible » à la place de
  // ce qu'elle avait encore sous les yeux. Une PWA hors-ligne garde ce qu'elle a.
  const reveils = []
  const { ctx, get } = contexte({
    enLigne: false, reveils,
    reponses: [{ status: 200, body: { autorise: true, ratio: RATIO_OK, avis: [
      { id: '1', verdict: 'remarque', extrait: 'bouilloire sale', bien: 'C', bienNom: 'C',
        sejourDebut: '2026-08-12', sejourFin: '2026-08-15', recuLe: null }
    ] } }]
  })
  await ctx.chargerAvis()
  ctx.setTab('avis')
  const avant = get('avis-liste').innerHTML
  assert.ok(avant.includes('bouilloire sale'))
  await ctx.resonder()
  assert.strictEqual(get('avis-liste').innerHTML, avant, 'la liste doit survivre au retour au premier plan')
})

test('en ligne, le retour au premier plan RAFRAÎCHIT bien', async () => {
  // Contre-épreuve : ne rien rafraîchir passerait aussi le test précédent.
  const { ctx, get } = contexte({ reponses: [
    { status: 200, body: { autorise: true, ratio: RATIO_OK, avis: [
      { id: '1', verdict: 'remarque', extrait: 'ancien', bien: 'C', bienNom: 'C', recuLe: '2026-08-01T00:00:00Z' }] } },
    { status: 200, body: { autorise: true, ratio: RATIO_OK, avis: [] } },
    { status: 200, body: { autorise: true, ratio: RATIO_OK, avis: [
      { id: '2', verdict: 'remarque', extrait: 'nouveau', bien: 'C', bienNom: 'C', recuLe: '2026-09-01T00:00:00Z' }] } }
  ] })
  await ctx.chargerAvis()
  ctx.setTab('avis')
  assert.ok(get('avis-liste').innerHTML.includes('ancien'))
  await ctx.resonder()
  assert.ok(get('avis-liste').innerHTML.includes('nouveau'), get('avis-liste').innerHTML)
})

test('le réveil est branché sur visibilitychange, et respecte son délai', async () => {
  const reveils = []
  const ok = { status: 200, body: { autorise: true, ratio: RATIO_OK, avis: [] } }
  const { ctx, appels, reveiller } = contexte({ reveils, reponses: [ok, ok] })
  ctx.brancherResonde()
  assert.strictEqual(reveils.length, 1, 'un écouteur visibilitychange doit être posé')
  reveiller()
  await new Promise(r => setImmediate(r))
  assert.strictEqual(appels.length, 0, 'un réveil juste après le chargement ne resonde pas')
})

// ─── Les dates nues du PLANNING ────────────────────────────────────────────
// ⚠ Même famille que le décalage de la vue Avis, sur l'autre écran. `arrival` /
// `departure` sont des dates de calendrier ; `new Date('2026-08-15')` vaut
// minuit UTC, alors que tout le planning raisonne en heure locale. À l'ouest de
// Greenwich, un départ du 15 tombait dans la colonne du 14 — pendant que la vue
// Mois, qui compare la chaîne brute, affichait le bon jour. Deux vues du même
// écran qui se contredisent.

function extraireDateNueLocale () {
  const i = HTML.indexOf('  function dateNueLocale (s) {')
  assert.ok(i > 0, 'le helper doit rester repérable')
  const j = HTML.indexOf('\n  }', i) + 4
  const ctx = { }
  vm.createContext(ctx)
  vm.runInContext(HTML.slice(i, j) + '\n;globalThis.f = dateNueLocale', ctx)
  return ctx.f
}

for (const tz of ['Europe/Paris', 'America/Guadeloupe', 'America/New_York', 'Pacific/Auckland']) {
  test(`une date nue tombe le bon jour sous ${tz}`, async () => {
    sousFuseau(tz, () => {
      const d = extraireDateNueLocale()('2026-08-15')
      assert.strictEqual(d.getFullYear(), 2026)
      assert.strictEqual(d.getMonth(), 7, 'août')
      assert.strictEqual(d.getDate(), 15, `jour décalé sous ${tz}`)
      assert.strictEqual(d.getHours(), 0, 'minuit LOCAL, comme le reste du planning')
    })
  })
}

test('une date illisible ne produit pas une date fantôme', async () => {
  // `getMenages` saute l'entrée plutôt que de placer un ménage n'importe où.
  assert.strictEqual(extraireDateNueLocale()('pas-une-date'), null)
  assert.strictEqual(extraireDateNueLocale()(''), null)
})
