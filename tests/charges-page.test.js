// tests/charges-page.test.js — la page `/charges` (compte de charges, lot 3).
// Spec : docs/specs/spec-compte-de-charges.md §13.2, §13.3, §13.7, §13.9.
//
// ⚠ LES GESTES SE MESURENT EN CLIQUANT (tests/outils/banc-charges.js) : le
// vrai module de la page tourne dans un vrai DOM, avec la vraie vue, et chaque
// `fetch` est compté. Les règles de forme (hexa, emoji, clés de texte) restent
// lues dans la source.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { monter, reponseEcran, facture, ENT, BIEN, BIEN_VIEUX, id, EXERCICE_2026 } = require('./outils/banc-charges')

const racine = path.join(__dirname, '..')
const lire = p => fs.readFileSync(path.join(racine, p), 'utf8')
const sansCommentaires = src => src
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\s\/\/ .*$/gm, '')
const texte = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '')
// Le texte VISIBLE, une espace entre deux éléments voisins : pour lire une
// ligne à colonnes (« Eau 40,00 € 40,00 € ») sans dépendre des blancs de la
// source. Les libellés réservés aux lecteurs d'écran (`.sr-only`) n'y sont pas.
const mots = (el) => {
  const out = []
  const voir = (n) => { if (n.nodeType === 3) out.push(n.nodeValue); else if (!(n.classList && n.classList.contains('sr-only'))) n.childNodes.forEach(voir) }
  if (el) voir(el)
  return out.join(' ').replace(/\s+/g, ' ').trim()
}

// ─── Règles V5, lues dans la source ─────────────────────────────────────────
test('charges : aucun hexa, aucun emoji, aucune icône dessinée — ni dans la page, ni dans la vue', () => {
  for (const f of ['pages/charges.html', 'shared/charges-vue.js']) {
    const src = sansCommentaires(lire(f))
    assert.ok(!/#[0-9A-Fa-f]{6}\b|#[0-9A-Fa-f]{3}\b(?![\w-])/.test(src.replace(/&#\d+;/g, '')), `${f} : couleur en dur`)
    assert.ok(!/\p{Extended_Pictographic}/u.test(src), `${f} : emoji`)
    assert.ok(!/<(path|circle|rect|polyline|line|polygon)\b/.test(src), `${f} : forme SVG dessinée`)
  }
})

test('charges : la vue n\'appelle AUCUN endpoint elle-même (l\'inventaire vit dans la page)', () => {
  const src = sansCommentaires(lire('shared/charges-vue.js'))
  assert.doesNotMatch(src, /\/api\//)
  assert.doesNotMatch(src, /\bfetch\s*\(/)
})

test('charges : chaque clé de texte de la page et de la vue existe dans les trois langues', () => {
  const page = lire('pages/charges.html')
  const vue = lire('shared/charges-vue.js')
  const cles = new Set([
    ...[...page.matchAll(/data-i18n="([\w.]+)"/g)].map(m => m[1]),
    ...[...page.matchAll(/data-i18n-attr="([^"]+)"/g)].flatMap(m => m[1].split(';').map(p => p.split(':')[1]).filter(Boolean)),
    ...[...(page + vue).matchAll(/\bt\('([\w.]*[a-z0-9])'\s*[,)]/g)].map(m => m[1]),
    // Les familles construites, sur leurs listes fermées.
    ...['validee', 'a_verifier', 'a_lire', 'panne', 'plafond', 'illisible', 'doublon', 'sans_facture'].map(e => 'charges.etat_' + e),
    ...require('../lib/charges/regles').CATEGORIES.map(c => 'charges.cat_' + c.cle),
    ...['montant_invalide', 'categorie_invalide', 'entite_requise', 'type_refuse', 'trop_gros'].map(c => 'charges.refus_' + c)
  ])
  assert.ok(vue.includes("t('charges.etat_' + e)"), 'la famille des états a changé : mettre ce test à jour')
  // Les exercices se nomment par leur année (§14.21) : plus de famille construite.
  assert.ok(!/charges\.periode_' \+/.test(vue), 'une famille de périodes est revenue : mettre ce test à jour')
  assert.ok(cles.size > 60, `extraction vide (${cles.size})`)
  for (const l of ['fr', 'en', 'es']) {
    const d = JSON.parse(lire(`shared/i18n/${l}.json`))
    for (const k of cles) assert.ok(typeof d[k] === 'string' && d[k].trim(), `${l} : clé « ${k} » absente ou vide`)
  }
})

test('les mots de période d\'avant le lot 8a restent COMPRIS par le serveur (liens déjà ouverts)', () => {
  const { PERIODES_D_AVANT, bornesPeriode } = require('../lib/charges/ecran')
  assert.deepEqual(PERIODES_D_AVANT, ['exercice', 'exercice_precedent', '12_mois'])
  const lu = PERIODES_D_AVANT.map(periode => bornesPeriode({ periode, aujourdhui: '2026-11-10' }).periode)
  assert.deepEqual(lu, ['2026', '2025', '2026'])
})

// ─── Le budget ──────────────────────────────────────────────────────────────
test('LE TEST QUI COMPTE (budget) : UN appel au chargement, vers l\'appel d\'écran, et la garde de compte propre AVANT', async () => {
  const b = await monter({ ecran: () => reponseEcran({ aTraiter: [facture(1, { statut: 'a_verifier' })], liste: Array.from({ length: 50 }, (_, i) => facture(100 + i)) }) })
  try {
    // ⚠ Sans entité : le serveur choisit la première active (§14.21).
    assert.deepEqual(b.journal.fetch.map(f => `${f.methode} ${f.url}`), ['GET /api/ecran/charges'])
    assert.equal(b.journal.gardes, 1)
    assert.equal(b.$$('[data-bind="liste"] .chg-ligne').length, 50)
    assert.equal(b.journal.fetch[0].entetes.Authorization, 'Bearer jeton-relu', 'le jeton RELU, pas celui de l\'amorce')
  } finally { b.fermer() }
})

test('un refus 403 de l\'écran se DIT (titulaire seul), au lieu d\'une page vide', async () => {
  const b = await monter({ ecran: () => { throw Object.assign(new Error('refus'), { status: 403, error: 'Réservé au titulaire du compte' }) } })
  try {
    assert.match(texte(b.$('[data-bind="a-traiter"]')), /réservée au titulaire/)
  } finally { b.fermer() }
})

// ─── À traiter ──────────────────────────────────────────────────────────────
test('« À traiter » : son nombre exact, et le geste qui convient à chaque état', async () => {
  const lignes = [
    facture(1, { statut: 'a_verifier' }),
    facture(2, { statut: 'a_lire', motif: 'panne_ia', fournisseur_nom: null, montant_ttc_cents: null }),
    facture(3, { statut: 'illisible' }),
    facture(4, { signal: 'doublon', signal_tranche: false, groupe_doublon: id(9) })
  ]
  const b = await monter({ ecran: () => reponseEcran({ aTraiter: lignes, nombre: 53 }) })
  try {
    const z = b.$('[data-bind="a-traiter"]')
    assert.equal(texte(z.querySelector('.chg-compte')), '53')
    const actions = [...z.querySelectorAll('.chg-ligne__action')].map(texte)
    assert.deepEqual(actions, ['Ouvrir', 'Saisir à la main', 'Saisir à la main', 'Vérifier'])
    const panne = z.querySelectorAll('.chg-ligne')[1]
    assert.match(texte(panne), /IA indisponible/)
    assert.match(texte(panne), /Fournisseur inconnu/)
    assert.match(texte(panne), /non lu/, 'un montant absent n\'est pas 0 €')
    assert.doesNotMatch(texte(panne), /0,00/)
    assert.match(texte(z), /Et 49 de plus/)
  } finally { b.fermer() }
})

// ─── Les totaux ─────────────────────────────────────────────────────────────
test('LE TEST QUI COMPTE : les totaux disent « non lu », l\'estimation et l\'heure du calcul — jamais un 0 inventé', async () => {
  const totaux = {
    total: { ht: 10000, tva: null, ttc: 12000, ht_etale: 10000, tva_etale: null, ttc_etale: 12000, nb_etale: 3, nb_factures: 3, nb_non_verifiees: 2, nb_signaux: 0, nb_sans_ht: 1, nb_sans_tva: 3, nb_sans_ttc: 0 },
    par_mois: [{ cle: '2026-10', ttc: 5000, ttc_etale: 5000, nb_factures: 1, nb_etale: 1 }, { cle: '2026-11', ttc: 7000, ttc_etale: 7000, nb_factures: 2, nb_etale: 2 }],
    // ⚠ Une ligne SANS facture comptée (un doublon écarté, une lecture en
    // cours) ne s'affiche pas : son montant n'est pas « non lu ».
    par_categorie: [{ cle: 'energie', ttc: 7000, ttc_etale: 7000, nb_factures: 2, nb_etale: 2 }, { cle: null, ttc: null, ttc_etale: null, nb_factures: 1, nb_etale: 1 }, { cle: 'menage', ttc: null, ttc_etale: null, nb_factures: 0, nb_etale: 0 }],
    par_bien: [{ cle: BIEN, ttc: 6000, ttc_etale: 6000, nb_factures: 1, nb_etale: 1 }, { cle: BIEN_VIEUX, ttc: 4000, ttc_etale: 4000, nb_factures: 1, nb_etale: 1 }, { cle: null, ttc: 2000, ttc_etale: 2000, nb_factures: 1, nb_etale: 1 }],
    calcule_le: '2026-11-10T19:05:00Z', ...EXERCICE_2026
  }
  const b = await monter({ ecran: () => reponseEcran({ totaux }) })
  try {
    const z = b.$('[data-bind="totaux"]')
    // ⚠ LE TOTAL DE L'EXERCICE EN TTC SEUL (retour de recette du lot 8a) :
    // ni case HT ni case TVA, et les termes comptables.
    assert.match(mots(z.querySelector('.chg-total')), /^Charges de l'exercice TTC, prorata temporis 120,00\s?€ Factures datées de l'exercice : 120,00\s?€$/)
    assert.doesNotMatch(texte(z), /\bHT\b|\bTVA\b|Étalé|À la date/)
    assert.equal(z.querySelectorAll('.chg-chiffre').length, 0)
    // Une seule ligne de titres pour les deux colonnes des mois.
    assert.match(mots(z.querySelector('.chg-rep--mois .chg-cols--titres')), /^Mois Prorata temporis Date de facture$/)
    assert.match(texte(z.querySelector('.chg-mentions--estimation')), /Estimation · 2 à vérifier · Calculé le/)
    assert.match(texte(z), /Du 1 janv\.? 2026 au 31 déc\.? 2026/)
    assert.match(texte(z), /Réglage standard : exercice du 1er janvier au 31 décembre/)
    const reps = [...z.querySelectorAll('.chg-rep')].map(el => [...el.querySelectorAll('h3, .chg-rep__nom, .chg-col--prorata, .chg-col--date')].map(mots).join(' '))
    assert.match(reps[0], /octobre 2026 50,00\s?€ 50,00\s?€ novembre 2026 70,00\s?€ 70,00\s?€ décembre 2026$/)
    // ⚠ LES DOUZE MOIS de l'exercice, même vides (§14.21.2) : l'hôte lit son
    // année mois par mois, un mois sans facture se dit « — », jamais 0.
    const mois = [...z.querySelectorAll('[data-mois]')]
    assert.deepEqual(mois.map(m => m.dataset.mois), Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`))
    assert.match(mots(mois[0]), /^janvier 2026 — —$/, 'un tiret dans chaque colonne')
    // Chaque mois est un BLOC, fermé au départ.
    assert.equal(z.querySelectorAll('.chg-ms > li.chg-m').length, 12)
    assert.equal(z.querySelectorAll('.chg-m--ouvert').length, 0)
    assert.doesNotMatch(texte(mois[0]), /0,00/)
    assert.match(reps[1], /^Par catégorie Eau, électricité, gaz 70,00\s?€ 70,00\s?€ Sans catégorie non lu non lu$/, 'la ligne Ménage, sans facture comptée, est absente')
    assert.match(reps[2], /Studio 60,00\s?€ 60,00\s?€ Ancien · archivé 40,00\s?€ 40,00\s?€ Sans logement 20,00\s?€ 20,00\s?€/)
  } finally { b.fermer() }
})

test('LE TEST QUI COMPTE (Q34) : une facture annuelle se lit ÉTALÉE et À LA DATE côte à côte ; un mois sans facture à sa date vaut 0, pas « non lu »', async () => {
  // Une taxe foncière de 1 200 € sur 2026, datée de septembre : octobre en
  // porte 101,91 € étalés et rien à la date ; septembre, 98,63 € étalés et
  // les 1 200 € à la date.
  const totaux = {
    total: { ht: 120000, tva: null, ttc: 120000, ht_etale: 20054, tva_etale: null, ttc_etale: 20054, nb_etale: 61, nb_factures: 1, nb_non_verifiees: 0, nb_signaux: 0, nb_sans_ht: 0, nb_sans_tva: 1, nb_sans_ttc: 0 },
    par_mois: [{ cle: '2026-09', ttc: 120000, ttc_etale: 9863, nb_factures: 1, nb_etale: 30 }, { cle: '2026-10', ttc: null, ttc_etale: 10191, nb_factures: 0, nb_etale: 31 }],
    par_categorie: [{ cle: 'impots_taxes', ttc: 120000, ttc_etale: 20054, nb_factures: 1, nb_etale: 61 }],
    par_bien: [],
    calcule_le: '2026-11-10T19:05:00Z', ...EXERCICE_2026
  }
  const b = await monter({ ecran: () => reponseEcran({ totaux }) })
  try {
    const z = b.$('[data-bind="totaux"]')
    const lu = (cle) => mots(z.querySelector(`[data-mois="${cle}"]`))
    assert.match(lu('2026-09'), /^septembre 2026 98,63\s?€ 1\s?200,00\s?€$/)
    assert.match(lu('2026-10'), /^octobre 2026 101,91\s?€ 0,00\s?€$/, 'un mois porté par l\'étalement seul s\'affiche, et sa lecture à la date vaut 0')
    assert.match(mots(z.querySelector('.chg-total')), /prorata temporis 200,54\s?€ Factures datées de l'exercice : 1\s?200,00\s?€$/)
  } finally { b.fermer() }
})

test('« aucune facture comptée » ne se dit que si AUCUNE des deux lectures n\'a de montant', async () => {
  const totaux = { total: { ht: null, tva: null, ttc: null, ht_etale: 5000, tva_etale: null, ttc_etale: 5000, nb_etale: 30, nb_factures: 0, nb_non_verifiees: 0, nb_signaux: 0, nb_sans_ht: 0, nb_sans_tva: 0, nb_sans_ttc: 0 }, par_mois: [{ cle: '2026-11', ttc: null, ttc_etale: 5000, nb_factures: 0, nb_etale: 30 }], par_categorie: [], par_bien: [], calcule_le: '2026-11-10T19:05:00Z', ...EXERCICE_2026 }
  const b = await monter({ ecran: () => reponseEcran({ totaux }) })
  try {
    const z = b.$('[data-bind="totaux"]')
    assert.doesNotMatch(texte(z), /Aucune facture comptée/)
    assert.match(mots(z.querySelector('.chg-total')), /prorata temporis 50,00\s?€ Factures datées de l'exercice : 0,00\s?€$/)
  } finally { b.fermer() }
})

test('des factures seulement EN ATTENTE : « aucune comptée », mais l\'estimation reste dite', async () => {
  const totaux = { total: { ht: null, tva: null, ttc: null, nb_factures: 0, nb_non_verifiees: 2, nb_signaux: 0, nb_sans_ht: 0, nb_sans_tva: 0, nb_sans_ttc: 0 }, par_mois: [], par_categorie: [], par_bien: [], calcule_le: '2026-11-10T19:05:00Z', ...EXERCICE_2026 }
  const b = await monter({ ecran: () => reponseEcran({ totaux }) })
  try {
    const z = b.$('[data-bind="totaux"]')
    assert.match(texte(z), /Aucune facture comptée/)
    assert.match(texte(z), /Estimation · 2 à vérifier/)
    assert.equal(z.querySelectorAll('.chg-chiffre').length, 0)
  } finally { b.fermer() }
})

test('LE TEST QUI COMPTE : un doublon non tranché rend le total « estimation » (spec §6), même tout vérifié', async () => {
  const totaux = { total: { ht: 10000, tva: 2000, ttc: 12000, nb_factures: 1, nb_non_verifiees: 0, nb_signaux: 2, nb_sans_ht: 0, nb_sans_tva: 0, nb_sans_ttc: 0 }, par_mois: [], par_categorie: [], par_bien: [], calcule_le: '2026-11-10T19:05:00Z', ...EXERCICE_2026 }
  const b = await monter({ ecran: () => reponseEcran({ totaux }) })
  try {
    assert.match(texte(b.$('.chg-mentions--estimation')), /^Estimation · 2 à trancher · Calculé le/)
  } finally { b.fermer() }
  // Et un montant TTC absent suffit aussi.
  const t2 = { ...totaux, total: { ...totaux.total, nb_signaux: 0, nb_sans_ttc: 1 } }
  const c = await monter({ ecran: () => reponseEcran({ totaux: t2 }) })
  try {
    assert.match(texte(c.$('.chg-mentions--estimation')), /^Estimation · Calculé le/)
    assert.match(texte(c.$('.chg-total')), /1 sans montant lu/)
  } finally { c.fermer() }
  // ⚠ Mais PAS une TVA ou un HT absents : l'écran ne montre plus que le TTC
  // (retour de recette du lot 8a), il ne doute pas d'un chiffre qu'il n'affiche pas.
  const t4 = { ...totaux, total: { ...totaux.total, nb_signaux: 0, nb_sans_tva: 1, nb_sans_ht: 1 } }
  const e = await monter({ ecran: () => reponseEcran({ totaux: t4 }) })
  try {
    assert.equal(e.$('.chg-mentions--estimation'), null)
  } finally { e.fermer() }
  // Rien à redire : pas d'« estimation ».
  const t3 = { ...totaux, total: { ...totaux.total, nb_signaux: 0 } }
  const d = await monter({ ecran: () => reponseEcran({ totaux: t3 }) })
  try {
    assert.equal(d.$('.chg-mentions--estimation'), null)
    assert.match(texte(d.$('[data-bind="totaux"] > .chg-mentions:last-of-type')), /^Calculé le/)
  } finally { d.fermer() }
})

test('des totaux en panne se disent « indisponibles », la liste reste là', async () => {
  const b = await monter({ ecran: () => reponseEcran({ totaux: null, liste: [facture(1)] }) })
  try {
    assert.match(texte(b.$('[data-bind="totaux"]')), /indisponibles/)
    assert.equal(b.$$('[data-bind="liste"] .chg-ligne').length, 1)
  } finally { b.fermer() }
})

test('LE TEST QUI COMPTE (§14.21) : une entité à la fois — pas de « Toutes » ; la choisir relit l\'écran SANS période, puis l\'exercice se choisit par son année', async () => {
  const urls = []
  const ENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const b = await monter({
    ecran: (u) => {
      urls.push(u)
      const r = reponseEcran({ entites: [{ id: ENT, nom: 'Moi', archivee: false, debut_exercice: null }, { id: ENT_B, nom: 'SCI', archivee: true, debut_exercice: '04-01' }] })
      if (u.includes(ENT_B)) {
        r.entite = ENT_B
        const annee = /periode=(\d{4})/.exec(u)
        const p = annee ? annee[1] : '2026'
        Object.assign(r.totaux, { entite: ENT_B, periode: p, proposees: ['2026', '2025'], debut: `${p}-04-01`, fin: `${Number(p) + 1}-03-31`, debut_exercice: '04-01', standard: false })
      }
      return r
    }
  })
  try {
    const sel = b.$('[data-choix="entite"]')
    assert.deepEqual([...sel.options].map(o => o.value), [ENT, ENT_B], 'aucune option « Toutes »')
    assert.equal(sel.value, ENT, 'l\'entité que le serveur a lue')
    assert.match(texte(sel), /SCI · archivée/)
    assert.deepEqual([...b.$('[data-choix="periode"]').options].map(texte), ['Exercice 2026'])
    await b.choisir(sel, ENT_B)
    assert.equal(urls[1], `/api/ecran/charges?entite=${ENT_B}`)
    const per = b.$('[data-choix="periode"]')
    assert.deepEqual([...per.options].map(texte), ['Exercice 2026-2027', 'Exercice 2025-2026'])
    assert.doesNotMatch(texte(b.$('[data-bind="totaux"]')), /Réglage standard/, 'une SCI réglée n\'est pas au standard')
    await b.choisir(per, '2025')
    assert.equal(urls[2], `/api/ecran/charges?entite=${ENT_B}&periode=2025`)
    assert.match(texte(b.$('[data-bind="totaux"]')), /Du 1 avr\.? 2025 au 31 mars 2026/)
    assert.equal(b.$('[data-choix="periode"]').value, '2025')
  } finally { b.fermer() }
})

test('un compte sans entité : le chemin pour en créer une, ni choix ni totaux', async () => {
  const b = await monter({ ecran: () => Object.assign(reponseEcran({ entites: [], totaux: { sans_entite: true }, credits: {} }), { entite: null }) })
  try {
    assert.equal(b.$('[data-choix="entite"]'), null)
    assert.match(texte(b.$('[data-bind="totaux"]')), /il faut une entité juridique/)
    assert.equal(b.$('[data-bind="totaux"] a').getAttribute('href'), '/logements')
  } finally { b.fermer() }
})

// ─── Le détail d'un mois (§14.21.2) ─────────────────────────────────────────
test('LE TEST QUI COMPTE : un clic sur un mois lit SES factures et leur part, sous la ligne ; un second clic le referme, sans relire', async () => {
  const urls = []
  const taxe = facture(7, { fournisseur_nom: 'Trésor public', montant_ttc_cents: 120000, jour: '2026-09-15', periode_debut: '2026-01-01', periode_fin: '2026-12-31', type_document: 'facture', part_ttc_cents: 10192, compte: true })
  const eau = facture(8, { fournisseur_nom: 'Eau', montant_ttc_cents: 4000, jour: '2026-11-03', part_ttc_cents: 4000, compte: true })
  const b = await monter({
    ecran: (u) => {
      urls.push(u)
      if (u.includes('mois=')) return { detail_mois: { mois: '2026-11', debut: '2026-11-01', fin: '2026-11-30', entite: ENT, lignes: [eau, taxe] } }
      return reponseEcran()
    }
  })
  try {
    await b.cliquer(b.$('[data-mois="2026-11"]'))
    assert.equal(urls[1], `/api/ecran/charges?mois=2026-11&entite=${ENT}&periode=2026`, 'le mois se lit DANS l\'exercice affiché')
    assert.equal(b.$('[data-mois="2026-11"]').getAttribute('aria-expanded'), 'true')
    assert.ok(b.$('[data-mois="2026-11"]').closest('.chg-m').classList.contains('chg-m--ouvert'), 'le mois ouvert se détache')
    const detail = b.$('.chg-detail')
    // ⚠ DEUX PARTIES (retours de recette du lot 8a) : la facture DATÉE du mois,
    // avec son type, sa date et son montant facturé ; puis la part du mois
    // d'une facture datée d'un AUTRE mois — son nom et sa charge, sans date,
    // sans période, sans montant de facture.
    const titres = [...detail.querySelectorAll('.chg-dl--titres')].map(mots)
    assert.deepEqual(titres, ['Factures du mois Charge du mois Montant facturé', 'Charges mensuelles Charge du mois'])
    const lignes = [...detail.querySelectorAll('button.chg-dl')].map(mots)
    assert.equal(lignes.length, 2)
    assert.match(lignes[0], /^Eau Facture du 3 nov\.? 2026 40,00\s?€ 40,00\s?€$/)
    assert.match(lignes[1], /^Trésor public 101,92\s?€$/)
    assert.doesNotMatch(lignes[1], /1\s?200|2026|couvre/)
    // La ligne du détail ouvre la même fiche.
    await b.cliquer(detail.querySelectorAll('button.chg-dl')[1])
    assert.equal(b.$('[data-champ="fournisseur_nom"]').value, 'Trésor public')
    // Refermer, rouvrir : la lecture est gardée.
    await b.cliquer(b.$('[data-mois="2026-11"]'))
    assert.equal(b.$('.chg-detail'), null)
    await b.cliquer(b.$('[data-mois="2026-11"]'))
    assert.ok(b.$('.chg-detail'))
    assert.equal(urls.length, 2, 'aucune relecture')
  } finally { b.fermer() }
})

test('le détail d\'un mois en panne se DIT, et un mois vide aussi', async () => {
  const b = await monter({
    ecran: (u) => {
      if (u.includes('mois=2026-10')) throw Object.assign(new Error('panne'), { status: 503 })
      if (u.includes('mois=')) return { detail_mois: { mois: '2026-03', lignes: [] } }
      return reponseEcran()
    }
  })
  try {
    await b.cliquer(b.$('[data-mois="2026-10"]'))
    assert.match(texte(b.$('.chg-detail')), /ne se lisent pas pour le moment/)
    await b.cliquer(b.$('[data-mois="2026-03"]'))
    assert.match(texte(b.$('.chg-detail')), /Aucune facture ce mois-ci/)
    assert.equal(b.$$('.chg-detail').length, 1, 'un seul mois ouvert à la fois')
  } finally { b.fermer() }
})

test('changer d\'entité referme le mois ouvert ; une réponse arrivée APRÈS le changement est jetée', async () => {
  const ENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  let libererMois
  const urls = []
  const b = await monter({
    ecran: (u) => {
      urls.push(u)
      if (u.includes('mois=') && u.includes(ENT_B)) return { detail_mois: { lignes: [facture(10, { fournisseur_nom: 'La SCI' })] } }
      if (u.includes('mois=')) return new Promise(r => { libererMois = () => r({ detail_mois: { lignes: [facture(9, { fournisseur_nom: 'Fantôme' })] } }) })
      const r = reponseEcran({ entites: [{ id: ENT, nom: 'Moi', archivee: false, debut_exercice: null }, { id: ENT_B, nom: 'SCI', archivee: false, debut_exercice: null }] })
      if (u.includes(ENT_B)) r.entite = ENT_B
      return r
    }
  })
  try {
    await b.cliquer(b.$('[data-mois="2026-11"]'))
    await b.choisir(b.$('[data-choix="entite"]'), ENT_B)
    libererMois()
    for (let i = 0; i < 6; i++) await b.attendre()
    assert.equal(b.$('.chg-detail'), null)
    assert.doesNotMatch(texte(b.$('[data-bind="totaux"]')), /Fantôme/)
    // ⚠ Et la réponse en retard n'est pas GARDÉE pour l'entité suivante : le
    // même mois, rouvert sur la SCI, se relit pour elle.
    await b.cliquer(b.$('[data-mois="2026-11"]'))
    assert.equal(urls[urls.length - 1], `/api/ecran/charges?mois=2026-11&entite=${ENT_B}&periode=2026`)
    assert.match(texte(b.$('.chg-detail')), /La SCI/)
    assert.doesNotMatch(texte(b.$('.chg-detail')), /Fantôme/)
  } finally { b.fermer() }
})

// ─── Review 1 du lot 8a ─────────────────────────────────────────────────────
test('LE TEST QUI COMPTE (review 1, constat 2) : une facture hors du total se dit « Non comptée », À CÔTÉ de son état', async () => {
  const echeancier = facture(11, { fournisseur_nom: 'Échéancier EDF', statut: 'validee', type_document: 'echeancier', montant_ttc_cents: 60000, compte: false, part_ttc_cents: null })
  const eau = facture(12, { fournisseur_nom: 'Eau', statut: 'validee', montant_ttc_cents: 4000, compte: true, part_ttc_cents: 4000 })
  const b = await monter({ ecran: (u) => (u.includes('mois=') ? { detail_mois: { lignes: [echeancier, eau] } } : reponseEcran()) })
  try {
    await b.cliquer(b.$('[data-mois="2026-11"]'))
    const [l1, l2] = [...b.$$('.chg-detail button.chg-dl')].map(mots)
    // Hors du total : « Non comptée », aucune charge du mois, le montant facturé.
    // ⚠ Entre parenthèses : ce montant n'est pas dans le « Date de facture » du
    // mois (review 2, constat 2).
    assert.match(l1, /^Échéancier EDF Non comptée Échéancier du .* — \(600,00\s?€\)$/)
    assert.doesNotMatch(l2, /Non comptée/)
  } finally { b.fermer() }
})

test('review 1, constat 3 : une facture COMPTÉE dont la période ne touche pas le mois y porte une charge du mois de 0,00 €, et son montant facturé', async () => {
  const regul = facture(13, { fournisseur_nom: 'Régul 2025', montant_ttc_cents: 7777, jour: '2026-11-10', periode_debut: '2025-01-01', periode_fin: '2025-12-31', compte: true, part_ttc_cents: null })
  const b = await monter({ ecran: (u) => (u.includes('mois=') ? { detail_mois: { lignes: [regul] } } : reponseEcran()) })
  try {
    await b.cliquer(b.$('[data-mois="2026-11"]'))
    assert.match(mots(b.$('.chg-detail button.chg-dl')), /^Régul 2025 Facture du 10 nov\.? 2026 · couvre du 1 janv\.? 2025 au 31 déc\.? 2025 0,00\s?€ 77,77\s?€$/)
  } finally { b.fermer() }
})

test('review 1, constat 1 : un mois de bord d\'un exercice décalé se DIT partiel, avec ses bornes', async () => {
  const b = await monter({ ecran: (u) => (u.includes('mois=') ? { detail_mois: { mois: '2026-11', partiel: true, debut: '2026-11-15', fin: '2026-11-30', lignes: [] } } : reponseEcran()) })
  try {
    await b.cliquer(b.$('[data-mois="2026-11"]'))
    assert.match(texte(b.$('.chg-detail')), /Mois partiel : seule sa part dans l'exercice est lue, du 15 nov\.? 2026 au 30 nov\.? 2026/)
  } finally { b.fermer() }
})

test('LE TEST QUI COMPTE (review 1, constat 4) : « Afficher plus » pendant un changement d\'entité — la page de l\'ancienne liste est jetée', async () => {
  const ENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  let libererSuite
  const b = await monter({
    ecran: (u) => {
      if (u.includes('curseur=')) return new Promise(r => { libererSuite = () => r({ liste: { lignes: [facture(300, { fournisseur_nom: 'Ligne de Moi' })], suite: `2026-10-01|2026-10-01T10:00:00Z|${id(300)}` } }) })
      const r = reponseEcran({ entites: [{ id: ENT, nom: 'Moi', archivee: false, debut_exercice: null }, { id: ENT_B, nom: 'SCI', archivee: false, debut_exercice: null }], liste: [facture(1)], suite: `2026-11-02|2026-11-02T10:00:00Z|${id(1)}` })
      if (u.includes(ENT_B)) Object.assign(r, { entite: ENT_B, liste: { lignes: [facture(2, { fournisseur_nom: 'Ligne de la SCI' })], suite: null } })
      return r
    }
  })
  try {
    await b.cliquer(b.$('[data-geste="plus"]'))
    await b.choisir(b.$('[data-choix="entite"]'), ENT_B)
    libererSuite()
    for (let i = 0; i < 6; i++) await b.attendre()
    const liste = texte(b.$('[data-bind="liste"]'))
    assert.match(liste, /Ligne de la SCI/)
    assert.doesNotMatch(liste, /Ligne de Moi/)
    assert.equal(b.$('[data-bind="liste"] [data-geste="plus"]'), null, 'pas de curseur de l\'ancienne entité')
  } finally { b.fermer() }
})

test('review 1, constat 4 : une RELECTURE de l\'écran (un geste) pendant la lecture d\'un mois — le détail périmé n\'est pas gardé', async () => {
  let libererMois
  let n = 0
  const urls = []
  const c = facture(1)
  const b = await monter({
    ecran: (u) => {
      urls.push(u)
      if (u.includes('mois=') && n++ === 0) return new Promise(r => { libererMois = () => r({ detail_mois: { lignes: [facture(20, { fournisseur_nom: 'Périmée' })] } }) })
      if (u.includes('mois=')) return { detail_mois: { lignes: [facture(21, { fournisseur_nom: 'Fraîche' })] } }
      return reponseEcran({ liste: [c] })
    },
    geste: () => ({ ok: true, supprime: true })
  })
  try {
    await b.cliquer(b.$('[data-mois="2026-11"]'))
    // Le geste relit l'écran pendant que le mois se lit encore.
    await b.cliquer(b.$(`[data-bind="liste"] [data-ouvrir="${c.id}"]`))
    await b.cliquer(b.$('[data-geste="supprimer"]'))
    libererMois()
    for (let i = 0; i < 6; i++) await b.attendre()
    await b.cliquer(b.$('[data-mois="2026-11"]'))
    assert.match(texte(b.$('.chg-detail')), /Fraîche/)
    assert.equal(urls.filter(u => u.includes('mois=')).length, 2, 'relu, pas servi depuis la réponse périmée')
  } finally { b.fermer() }
})

test('review 1, constat 7 : la liste des exercices incomplète se DIT', async () => {
  const b = await monter({ ecran: () => { const r = reponseEcran(); r.totaux.exercices_indisponibles = true; return r } })
  try {
    assert.match(texte(b.$('[data-bind="totaux"]')), /La liste des exercices est incomplète pour le moment/)
  } finally { b.fermer() }
})

// ─── Retours de recette du lot 8a (19 novembre 2026) ───────────────────────
test('LE TEST QUI COMPTE (recette 8a) : le bouton d\'ajout seul en haut, puis le titre et l\'ENTITÉ ; « À traiter », l\'exercice, les crédits et la liste se suivent sur toute la largeur', async () => {
  const b = await monter({ ecran: () => reponseEcran({ aTraiter: [facture(1, { statut: 'a_verifier' })], liste: [facture(2)] }) })
  try {
    const main = b.$('main.chg')
    const ordre = [...main.children].map(el => el.className.split(' ')[0] + (el.dataset.bind ? ':' + el.dataset.bind : ''))
    assert.deepEqual(ordre, ['chg-barre', 'chg-tete', 'chg-envoi:envoi', 'chg-bloc:a-traiter', 'chg-bloc:totaux', 'chg-bloc:credits', 'chg-bloc:liste'])
    assert.ok(b.$('.chg-barre [data-action="ajouter"]'), 'le bouton est dans la barre du haut')
    assert.equal(b.$('.chg-tete [data-action="ajouter"]'), null)
    // L'entité se choisit en tête, plus dans les totaux ; l'exercice y reste.
    assert.ok(b.$('.chg-tete [data-bind="entite"] [data-choix="entite"]'))
    assert.equal(b.$('[data-bind="totaux"] [data-choix="entite"]'), null)
    assert.ok(b.$('[data-bind="totaux"] [data-choix="periode"]'))
    assert.equal(b.$$('[data-choix="entite"]').length, 1)
    // Lignes fines, et la liste porte le nom de l'entité.
    assert.ok(b.$('[data-bind="a-traiter"] .chg-lignes--fines'))
    assert.ok(b.$('[data-bind="liste"] .chg-lignes--fines'))
    assert.equal(texte(b.$('[data-bind="liste"] .chg-h2')), 'Factures de Moi')
  } finally { b.fermer() }
})

test('recette 8a : par catégorie et par logement, deux colonnes sous une ligne de titres — le mot n\'est plus répété sur chaque ligne', async () => {
  const totaux = {
    total: { ttc: 12000, ttc_etale: 9000, nb_etale: 3, nb_factures: 1, nb_non_verifiees: 0, nb_signaux: 0, nb_sans_ttc: 0 },
    par_mois: [], par_categorie: [{ cle: 'energie', ttc: 12000, ttc_etale: 9000, nb_factures: 1, nb_etale: 3 }], par_bien: [{ cle: BIEN, ttc: 12000, ttc_etale: 9000, nb_factures: 1, nb_etale: 3 }],
    calcule_le: '2026-11-10T19:05:00Z', ...EXERCICE_2026
  }
  const b = await monter({ ecran: () => reponseEcran({ totaux }) })
  try {
    const [, cat, bien] = b.$$('[data-bind="totaux"] .chg-rep')
    assert.match(mots(cat), /^Par catégorie Prorata temporis Date de facture Eau, électricité, gaz 90,00\s?€ 120,00\s?€$/)
    assert.match(mots(bien), /^Par logement Prorata temporis Date de facture Studio 90,00\s?€ 120,00\s?€$/)
  } finally { b.fermer() }
})

test('LE TEST QUI COMPTE (recette 8a) : la régularisation EDF — son solde se dit dans le mois où elle est DATÉE, pas dans ses charges mensuelles ; un solde négatif est « remboursé »', async () => {
  const regul = (jour, solde, part) => facture(30, { fournisseur_nom: 'EDF-SA', type_document: 'regularisation', montant_ttc_cents: 176190, jour, periode_debut: '2025-11-01', periode_fin: '2026-10-31', solde_lu: solde, part_ttc_cents: part, compte: true })
  const pour = async (mois, ligne) => {
    const b = await monter({ ecran: (u) => (u.includes('mois=') ? { detail_mois: { lignes: [ligne] } } : reponseEcran()) })
    try {
      await b.cliquer(b.$(`[data-mois="${mois}"]`))
      return { titres: b.$$('.chg-dl--titres').map(mots), ligne: mots(b.$('button.chg-dl')) }
    } finally { b.fermer() }
  }
  // Novembre, le mois de la facture : type, date, période, solde, 0 de charge, le montant facturé.
  const nov = await pour('2026-11', regul('2026-11-08', 21240, null))
  assert.deepEqual(nov.titres, ['Factures du mois Charge du mois Montant facturé'])
  assert.match(nov.ligne, /^EDF-SA Régularisation du 8 nov\.? 2026 · couvre du 1 nov\.? 2025 au 31 oct\.? 2026 · solde à payer : 212,40\s?€ 0,00\s?€ 1\s?761,90\s?€$/)
  // Octobre, un autre mois : une charge mensuelle, rien d'autre.
  const oct = await pour('2026-10', regul('2026-11-08', 21240, 14964))
  assert.deepEqual(oct.titres, ['Charges mensuelles Charge du mois'])
  assert.match(oct.ligne, /^EDF-SA 149,64\s?€$/)
  // Un trop-perçu : le solde est négatif, il se dit « remboursé », sans signe.
  const rembourse = await pour('2026-11', regul('2026-11-08', -5000, null))
  assert.match(rembourse.ligne, /solde remboursé : 50,00\s?€/)
  assert.doesNotMatch(rembourse.ligne, /-\s?50/)
})

test('recette 8a : une facture sans période, datée du mois, y porte sa charge ENTIÈRE et son montant ; une facture à vérifier garde son état', async () => {
  const b = await monter({ ecran: (u) => (u.includes('mois=') ? { detail_mois: { lignes: [facture(31, { fournisseur_nom: 'Plombier', statut: 'a_verifier', jour: '2026-11-18', montant_ttc_cents: 8500, part_ttc_cents: 8500, compte: true })] } } : reponseEcran()) })
  try {
    await b.cliquer(b.$('[data-mois="2026-11"]'))
    assert.match(mots(b.$('button.chg-dl')), /^Plombier À vérifier Facture du 18 nov\.? 2026 85,00\s?€ 85,00\s?€$/)
  } finally { b.fermer() }
})

// ─── Review 2 du lot 8a (la présentation) ───────────────────────────────────
test('LE TEST QUI COMPTE (review 2, constat 1) : dans un mois PARTIEL, « du mois » veut dire de la plage LUE — une facture datée avant le début de l\'exercice est une charge mensuelle', async () => {
  // Exercice au 15 novembre : novembre est lu du 15 au 30. La taxe du 3
  // novembre touche la plage par sa période, mais ses 1 200 € appartiennent
  // à l'exercice d'avant.
  const taxe = facture(40, { fournisseur_nom: 'Trésor public', montant_ttc_cents: 120000, jour: '2026-11-03', periode_debut: '2026-01-01', periode_fin: '2026-12-31', part_ttc_cents: 5260, compte: true })
  const eau = facture(41, { fournisseur_nom: 'Eau', montant_ttc_cents: 4000, jour: '2026-11-20', part_ttc_cents: 4000, compte: true })
  const marquees = [{ ...eau, a_la_date: true }, { ...taxe, a_la_date: false }]
  const bornes = { partiel: true, debut: '2026-11-15', fin: '2026-11-30' }
  // Trois chemins : le drapeau de la fonction (`a_la_date`) et les bornes ; le
  // drapeau SEUL (il fait foi) ; les bornes seules.
  for (const [nom, detail] of [['drapeau et bornes', { ...bornes, lignes: marquees }], ['drapeau seul', { lignes: marquees }], ['bornes seules', { ...bornes, lignes: [eau, taxe] }]]) {
    const b = await monter({ ecran: (u) => (u.includes('mois=') ? { detail_mois: { mois: '2026-11', ...detail } } : reponseEcran()) })
    try {
      await b.cliquer(b.$('[data-mois="2026-11"]'))
      const parties = b.$$('.chg-detail .chg-dls').map(ul => [...ul.querySelectorAll('button.chg-dl')].map(mots))
      assert.deepEqual(parties.map(x => x.length), [1, 1], nom + ' : chaque facture dans UNE partie')
      assert.match(parties[0][0], /^Eau Facture du 20 nov\.? 2026 40,00\s?€ 40,00\s?€$/)
      assert.match(parties[1][0], /^Trésor public 52,60\s?€$/, 'ses 1 200 € ne sont pas « facturés ce mois »')
    } finally { b.fermer() }
  }
})

test('LE TEST QUI COMPTE (review 2) : les deux colonnes du détail refont l\'en-tête du mois — les lignes « Non comptée » hors somme', async () => {
  const centimes = (txt) => Math.round(Number(String(txt).replace(/[^0-9,]/g, '').replace(',', '.')) * 100)
  const lignes = [
    facture(50, { fournisseur_nom: 'Eau', jour: '2026-11-03', montant_ttc_cents: 4000, part_ttc_cents: 4000, compte: true }),
    facture(51, { fournisseur_nom: 'Taxe', jour: '2026-11-09', montant_ttc_cents: 120000, periode_debut: '2026-01-01', periode_fin: '2026-12-31', part_ttc_cents: 9863, compte: true }),
    facture(52, { fournisseur_nom: 'Échéancier', type_document: 'echeancier', jour: '2026-11-12', montant_ttc_cents: 60000, part_ttc_cents: null, compte: false }),
    facture(53, { fournisseur_nom: 'Assurance', jour: '2026-01-12', montant_ttc_cents: 12000, periode_debut: '2026-01-01', periode_fin: '2026-12-31', part_ttc_cents: 986, compte: true }),
    facture(54, { fournisseur_nom: 'Doublon', jour: '2026-02-01', montant_ttc_cents: 9000, periode_debut: '2026-01-01', periode_fin: '2026-12-31', part_ttc_cents: 740, compte: false })
  ]
  const b = await monter({ ecran: (u) => (u.includes('mois=') ? { detail_mois: { lignes } } : reponseEcran()) })
  try {
    await b.cliquer(b.$('[data-mois="2026-11"]'))
    const col = (classe) => b.$$(`.chg-detail button.chg-dl .${classe}`).map(mots).filter(x => !/[—(]/.test(x)).reduce((somme, x) => somme + centimes(x), 0)
    assert.equal(col('chg-col--prorata'), 4000 + 9863 + 986, 'charge du mois : ni l\'échéancier ni le doublon')
    assert.equal(col('chg-col--date'), 4000 + 120000, 'montant facturé : l\'échéancier est entre parenthèses')
    // Hors total dans « Charges mensuelles » aussi : la mention, et un tiret.
    assert.match(mots(b.$$('.chg-detail button.chg-dl')[4]), /^Doublon Non comptée —$/)
  } finally { b.fermer() }
})

test('review 2, constats 3, 4 et 8 : un solde lu à 0 ne se dit pas ; une facture à vérifier se repère dans ses charges mensuelles ; chaque valeur redit sa colonne aux lecteurs d\'écran', async () => {
  const regul = facture(60, { fournisseur_nom: 'EDF-SA', type_document: 'regularisation', jour: '2026-11-08', montant_ttc_cents: 50000, periode_debut: '2025-11-01', periode_fin: '2026-10-31', solde_lu: 0, part_ttc_cents: null, compte: true })
  const annuelle = facture(61, { fournisseur_nom: 'Assurance', statut: 'a_verifier', jour: '2026-06-01', montant_ttc_cents: 64000, periode_debut: '2026-01-01', periode_fin: '2026-12-31', part_ttc_cents: 5260, compte: true })
  const b = await monter({ ecran: (u) => (u.includes('mois=') ? { detail_mois: { lignes: [regul, annuelle] } } : reponseEcran()) })
  try {
    const mois = b.$('[data-mois="2026-11"]')
    assert.match(mois.getAttribute('aria-label'), /^novembre 2026, Prorata temporis .+, Date de facture .+€$/)
    assert.match(b.$('[data-mois="2026-01"]').getAttribute('aria-label'), /^janvier 2026, Aucune facture ce mois-ci\.$/)
    await b.cliquer(mois)
    const [l1, l2] = b.$$('.chg-detail button.chg-dl')
    assert.doesNotMatch(mots(l1), /solde/)
    assert.match(mots(l2), /^Assurance À vérifier 52,60\s?€$/)
    assert.match(texte(l1.querySelector('.chg-col--prorata')), /^Charge du mois 0,00/)
    assert.match(texte(l1.querySelector('.chg-col--date')), /^Montant facturé 500,00/)
    assert.match(texte(l2.querySelector('.chg-col--prorata')), /^Charge du mois 52,60/)
  } finally { b.fermer() }
})

test('review 2, constats 5 et 6 : la feuille — l\'écart entre les mois s\'applique, et le détail a la grille de l\'en-tête du mois', () => {
  const css = lire('shared/ui.css')
  assert.match(css, /\.chg-rep \.chg-ms \{ gap: 6px; \}/, 'plus spécifique que « .chg-rep ul »')
  const grille = (sel, bloc) => (new RegExp(sel.replace('.', '\\.') + ' \\{[^}]*grid-template-columns: ([^;]+);').exec(bloc) || [])[1]
  const tel = css.slice(css.lastIndexOf('@media (max-width: 899px)'))
  assert.equal(grille('.chg-dl', css), grille('.chg-cols', css))
  assert.equal(grille('.chg-dl', tel), grille('.chg-cols', tel))
  assert.ok(grille('.chg-cols', tel))
})

// ─── Recette du 19 novembre 2026 sur staging (d04b5006) ─────────────────────
test('recette : les intérêts d\'une échéance de crédit ne se disent pas « Facture » ; et le détail garde le retrait droit de l\'en-tête du mois', async () => {
  const echeance = facture(70, { fournisseur_nom: 'banque populaire', categorie: 'credit', jour: '2026-11-22', montant_ttc_cents: 40357, part_ttc_cents: 40357, compte: true })
  const b = await monter({ ecran: (u) => (u.includes('mois=') ? { detail_mois: { lignes: [echeance] } } : reponseEcran()) })
  try {
    await b.cliquer(b.$('[data-mois="2026-11"]'))
    assert.match(mots(b.$('button.chg-dl')), /^banque populaire Échéance de crédit du 22 nov\.? 2026 403,57\s?€ 403,57\s?€$/)
  } finally { b.fermer() }
  // Mesuré à l'écran : les colonnes du détail étaient 12 px à droite de celles
  // de l'en-tête — le `padding` court de `.chg-dl` écrasait son retrait droit.
  const css = lire('shared/ui.css')
  assert.match(css, /\.chg-mois \{[^}]*padding: 9px 12px;/)
  assert.match(css, /\.chg-dl \{[^}]*padding: 7px 12px 7px 0;/)
})

// ─── La liste ───────────────────────────────────────────────────────────────
test('« Afficher plus » : la page suivante par le curseur, AJOUTÉE à la liste', async () => {
  const urls = []
  const b = await monter({
    ecran: (u) => {
      urls.push(u)
      if (u.includes('curseur=')) return { liste: { lignes: [facture(200)], suite: null } }
      return reponseEcran({ liste: [facture(1), facture(2)], suite: `2026-11-02|2026-11-02T10:00:00Z|${id(2)}` })
    }
  })
  try {
    await b.cliquer(b.$('[data-geste="plus"]'))
    assert.equal(urls[1], `/api/ecran/charges?curseur=${encodeURIComponent(`2026-11-02|2026-11-02T10:00:00Z|${id(2)}`)}&entite=${ENT}`, 'la page suivante suit l\'entité')
    assert.equal(b.$$('[data-bind="liste"] .chg-ligne').length, 3)
    assert.equal(b.$('[data-geste="plus"]'), null, 'plus de suite, plus de bouton')
  } finally { b.fermer() }
})

// ─── La fiche ───────────────────────────────────────────────────────────────
test('LE TEST QUI COMPTE : « Valider » envoie les montants en CENTIMES, un champ vide en `null`, et relit l\'écran', async () => {
  const c = facture(1, { statut: 'a_verifier', bien_id: null, montant_tva_cents: null })
  const b = await monter({ ecran: () => reponseEcran({ aTraiter: [c] }), geste: () => ({ ok: true, charge: { ...c, statut: 'validee' } }) })
  try {
    await b.cliquer(b.$(`[data-ouvrir="${c.id}"]`))
    const f = b.$('[data-bind="fiche"]')
    assert.ok(f.hasAttribute('open') || f.open, 'la fiche est ouverte')
    assert.equal(f.querySelector('[data-champ="montant_ht_cents"]').value, '100,00')
    assert.equal(f.querySelector('[data-champ="montant_tva_cents"]').value, '', 'un montant non lu reste vide, pas « 0,00 »')
    b.saisir(f.querySelector('[data-champ="montant_ttc_cents"]'), '1 234,5')
    b.saisir(f.querySelector('[data-champ="montant_tva_cents"]'), '')
    await b.choisir(f.querySelector('[data-champ="bien_id"]'), BIEN)
    await b.cliquer(f.querySelector('[data-geste="valider"]'))
    const [g] = b.gestes()
    assert.equal(g.action, 'valider')
    assert.equal(g.id, c.id)
    assert.equal(g.champs.montant_ttc_cents, 123450)
    assert.equal(g.champs.montant_ht_cents, 10000)
    assert.equal(g.champs.montant_tva_cents, null)
    assert.equal(g.champs.categorie, 'energie')
    assert.equal(g.champs.entite_juridique_id, ENT)
    assert.equal(g.champs.bien_id, BIEN)
    assert.equal(b.lecturesEcran().length, 2, 'l\'écran est relu après le geste')
    assert.ok(!f.hasAttribute('open'), 'la fiche se ferme')
  } finally { b.fermer() }
})

test('un montant illisible ou une catégorie absente : refusé dans la fiche, RIEN ne part', async () => {
  const c = facture(1, { statut: 'a_verifier', categorie: null })
  const b = await monter({ ecran: () => reponseEcran({ aTraiter: [c] }) })
  try {
    await b.cliquer(b.$(`[data-ouvrir="${c.id}"]`))
    const f = b.$('[data-bind="fiche"]')
    await b.cliquer(f.querySelector('[data-geste="valider"]'))
    assert.match(texte(f.querySelector('[data-bind="fiche-retour"]')), /Choisissez une catégorie/)
    await b.choisir(f.querySelector('[data-champ="categorie"]'), 'menage')
    b.saisir(f.querySelector('[data-champ="montant_ht_cents"]'), '12,345')
    await b.cliquer(f.querySelector('[data-geste="valider"]'))
    assert.match(texte(f.querySelector('[data-bind="fiche-retour"]')), /montant n'est pas valide/)
    assert.deepEqual(b.gestes(), [])
  } finally { b.fermer() }
})

test('un refus du serveur reste DANS la fiche, traduit', async () => {
  const c = facture(1, { statut: 'a_verifier' })
  const b = await monter({ ecran: () => reponseEcran({ aTraiter: [c] }), geste: () => { throw Object.assign(new Error('x'), { status: 409, error: 'bien_hors_entite' }) } })
  try {
    await b.cliquer(b.$(`[data-ouvrir="${c.id}"]`))
    await b.cliquer(b.$('[data-geste="valider"]'))
    assert.match(texte(b.$('[data-bind="fiche-retour"]')), /ne relève pas de l'entité choisie/)
    assert.equal(b.lecturesEcran().length, 1, 'pas de relecture sur un refus')
  } finally { b.fermer() }
})

test('la fiche ne propose que les logements de l\'entité choisie ; un logement déjà porté reste proposé', async () => {
  const c = facture(1, { bien_id: BIEN_VIEUX })
  const b = await monter({ ecran: () => reponseEcran({ liste: [c] }) })
  try {
    await b.cliquer(b.$(`[data-ouvrir="${c.id}"]`))
    const opts = [...b.$('[data-champ="bien_id"]').options].map(o => [o.value, o.textContent])
    assert.deepEqual(opts.map(o => o[0]), ['', BIEN, BIEN_VIEUX])
    assert.equal(b.$('[data-champ="bien_id"]').value, BIEN_VIEUX)
    assert.match(texte(b.$('[data-bind="fiche"]')), /Vérifiée le 3 nov/)
  } finally { b.fermer() }
})

test('LE TEST QUI COMPTE : sans entité active, « Valider » est remplacé par l\'explication et le chemin vers les logements (Q20)', async () => {
  const c = facture(1, { statut: 'a_verifier', entite_juridique_id: null })
  const b = await monter({ ecran: () => reponseEcran({ aTraiter: [c], entites: [] }) })
  try {
    await b.cliquer(b.$(`[data-ouvrir="${c.id}"]`))
    const f = b.$('[data-bind="fiche"]')
    assert.equal(f.querySelector('[data-geste="valider"]'), null)
    assert.match(texte(f), /il faut une entité juridique/)
    assert.equal(f.querySelector('a[href="/logements"]') !== null, true)
  } finally { b.fermer() }
})

test('« Supprimer » demande confirmation, et refusée, rien ne part', async () => {
  const c = facture(1)
  const non = await monter({ ecran: () => reponseEcran({ liste: [c] }), confirmer: false })
  try {
    await non.cliquer(non.$(`[data-ouvrir="${c.id}"]`))
    await non.cliquer(non.$('[data-geste="supprimer"]'))
    assert.match(non.journal.confirmations[0], /effacé définitivement/)
    assert.deepEqual(non.gestes(), [])
  } finally { non.fermer() }
  const oui = await monter({ ecran: () => reponseEcran({ liste: [c] }), geste: () => ({ ok: true, supprime: true }) })
  try {
    await oui.cliquer(oui.$(`[data-ouvrir="${c.id}"]`))
    await oui.cliquer(oui.$('[data-geste="supprimer"]'))
    assert.deepEqual(oui.gestes(), [{ action: 'supprimer', id: c.id }])
  } finally { oui.fermer() }
})

test('LE TEST QUI COMPTE : « Voir la facture » ouvre l\'onglet AU CLIC, puis lui donne l\'adresse de 60 s', async () => {
  const c = facture(1)
  const b = await monter({ ecran: () => reponseEcran({ liste: [c] }), geste: (corps) => (corps.action === 'consulter' ? { ok: true, url: 'https://stockage.test/lire/x', expire_dans_s: 60 } : { ok: true }) })
  try {
    await b.cliquer(b.$(`[data-ouvrir="${c.id}"]`))
    await b.cliquer(b.$('[data-geste="voir"]'))
    assert.equal(b.journal.onglets.length, 1)
    assert.equal(b.journal.onglets[0].location.href, 'https://stockage.test/lire/x')
    assert.equal(b.journal.onglets[0].opener, null)
  } finally { b.fermer() }
  const ko = await monter({ ecran: () => reponseEcran({ liste: [c] }), geste: () => { throw Object.assign(new Error('x'), { status: 404, error: 'sans_justificatif' }) } })
  try {
    await ko.cliquer(ko.$(`[data-ouvrir="${c.id}"]`))
    await ko.cliquer(ko.$('[data-geste="voir"]'))
    assert.equal(ko.journal.onglets[0].closed, true, 'l\'onglet vide se referme')
    assert.match(texte(ko.$('[data-bind="fiche-retour"]')), /pas de justificatif/)
  } finally { ko.fermer() }
})

test('un doublon : « Garder les deux » tranche, « Voir l\'autre » ouvre la facture du même groupe', async () => {
  const racine = facture(1, { signal: 'doublon', signal_tranche: false })
  const membre = facture(2, { signal: 'doublon', signal_tranche: false, groupe_doublon: racine.id, fournisseur_nom: 'Le double' })
  const b = await monter({ ecran: () => reponseEcran({ aTraiter: [racine, membre] }), geste: () => ({ ok: true }) })
  try {
    await b.cliquer(b.$(`[data-ouvrir="${racine.id}"]`))
    await b.cliquer(b.$('[data-bind="fiche"] [data-ouvrir]'))
    assert.equal(b.$('[data-champ="fournisseur_nom"]').value, 'Le double')
    await b.cliquer(b.$('[data-geste="trancher"]'))
    assert.deepEqual(b.gestes(), [{ action: 'trancher', id: membre.id }])
  } finally { b.fermer() }
})

test('une commission de plateforme ne se modifie pas : champs figés, ni « Valider » ni « Voir »', async () => {
  const c = facture(1, { origine: 'ota', categorie: 'commissions_plateformes' })
  const b = await monter({ ecran: () => reponseEcran({ liste: [c] }) })
  try {
    await b.cliquer(b.$(`[data-ouvrir="${c.id}"]`))
    const f = b.$('[data-bind="fiche"]')
    assert.equal(f.querySelector('[data-geste="valider"]'), null)
    assert.equal(f.querySelector('[data-geste="voir"]'), null)
    assert.ok(f.querySelector('[data-champ="montant_ttc_cents"]').disabled)
    assert.ok(f.querySelector('[data-geste="supprimer"]'))
  } finally { b.fermer() }
})

test('LE TEST QUI COMPTE (review du lot 7a, constat 1) : une facture à vérifier qui ne fait que S\'ÉTALER sur la période rend le total « estimation »', async () => {
  // Datée de janvier 2027, elle couvre 2026 : aucun compteur « à la date »
  // dans la période, mais ses indicateurs étalés y sont.
  const totaux = { total: { ht: null, tva: null, ttc: null, ht_etale: 100000, tva_etale: null, ttc_etale: 120000, nb_etale: 365, nb_etale_nv: 365, nb_etale_signal: 0, nb_etale_sans_ht: 0, nb_etale_sans_tva: 365, nb_etale_sans_ttc: 365, nb_factures: 0, nb_non_verifiees: 0, nb_signaux: 0, nb_sans_ht: 0, nb_sans_tva: 0, nb_sans_ttc: 0 }, par_mois: [], par_categorie: [], par_bien: [], calcule_le: '2026-11-10T19:05:00Z', ...EXERCICE_2026 }
  const b = await monter({ ecran: () => reponseEcran({ totaux }) })
  try {
    const z = b.$('[data-bind="totaux"]')
    assert.match(texte(z.querySelector('.chg-mentions--estimation')), /^Estimation · Calculé le/)
    assert.match(texte(z.querySelector('.chg-total__fort')), /Un montant réparti sur la période n'a pas été lu/, 'le manque est dit, sans nombre de documents')
  } finally { b.fermer() }
})

test('des totaux d\'AVANT le lot 7a (sans indicateur étalé) ne montrent pas « 0 € » étalé : on ne sait pas', async () => {
  const totaux = { total: { ht: 10000, tva: 2000, ttc: 12000, nb_factures: 1, nb_non_verifiees: 0, nb_signaux: 0, nb_sans_ht: 0, nb_sans_tva: 0, nb_sans_ttc: 0 }, par_mois: [{ cle: '2026-11', ttc: 12000, nb_factures: 1 }], par_categorie: [], par_bien: [], calcule_le: '2026-11-10T19:05:00Z', ...EXERCICE_2026 }
  const b = await monter({ ecran: () => reponseEcran({ totaux }) })
  try {
    const z = b.$('[data-bind="totaux"]')
    assert.match(mots(z.querySelector('.chg-total')), /prorata temporis non lu Factures datées de l'exercice : 120,00/)
    assert.doesNotMatch(texte(z.querySelector('.chg-total__fort')), /0,00/)
  } finally { b.fermer() }
})

// ─── Lot 7a : type de document et période ───────────────────────────────────
test('les types de document de la vue sont ceux du serveur (lib/charges/regles.js fait foi)', async () => {
  const vue = await import(path.join(racine, 'shared/charges-vue.js'))
  assert.deepEqual(vue.TYPES_DOCUMENT, require('../lib/charges/regles').TYPES_DOCUMENT)
  // Et le contrôle de la période dit la même chose que le serveur.
  const { periodeSaisie } = require('../lib/charges/regles')
  for (const [d, f] of [['', ''], ['2026-01-01', '2026-12-31'], ['2026-01-01', '2027-01-01'], ['2026-01-01', '2027-01-02'], ['2026-02-01', ''], ['2026-03-01', '2026-02-01'], ['2028-01-01', '2028-12-31']]) {
    const serveur = periodeSaisie(d, f)
    assert.equal(vue.controlePeriode(d, f), serveur.ok ? null : serveur.code, `${d} → ${f}`)
  }
})

test('LE TEST QUI COMPTE : la fiche envoie le type et la période ; un avoir se saisit SANS signe et se montre négatif dans la liste', async () => {
  const avoir = facture(1, { statut: 'a_verifier', type_document: 'avoir', montant_ht_cents: -5000, montant_tva_cents: -1000, montant_ttc_cents: -6000 })
  const b = await monter({ ecran: () => reponseEcran({ aTraiter: [avoir], liste: [avoir] }), geste: () => ({ ok: true }) })
  try {
    assert.match(texte(b.$('[data-bind="liste"] .chg-ligne')), /Avoir/)
    assert.match(texte(b.$('[data-bind="liste"] .chg-ligne__ttc')), /^-60,00\s?€$/)
    await b.cliquer(b.$(`[data-bind="liste"] [data-ouvrir="${avoir.id}"]`))
    const f = b.$('[data-bind="fiche"]')
    assert.equal(f.querySelector('[data-champ="type_document"]').value, 'avoir')
    assert.equal(f.querySelector('[data-champ="montant_ttc_cents"]').value, '60,00', 'le montant tel qu\'imprimé')
    assert.match(texte(f.querySelector('[data-bind="aide-type"]')), /Un avoir diminue le total/)
    b.saisir(f.querySelector('[data-champ="periode_debut"]'), '2026-01-01')
    b.saisir(f.querySelector('[data-champ="periode_fin"]'), '2026-12-31')
    await b.cliquer(f.querySelector('[data-geste="valider"]'))
    const [g] = b.gestes()
    assert.equal(g.champs.type_document, 'avoir')
    assert.equal(g.champs.montant_ttc_cents, 6000, 'positif : c\'est le serveur qui pose le signe')
    assert.equal(g.champs.periode_debut, '2026-01-01')
    assert.equal(g.champs.periode_fin, '2026-12-31')
  } finally { b.fermer() }
})

test('une période incomplète ou de plus de trois ans est refusée dans la fiche, et RIEN ne part', async () => {
  const c = facture(1, { statut: 'a_verifier' })
  const b = await monter({ ecran: () => reponseEcran({ aTraiter: [c] }) })
  try {
    await b.cliquer(b.$(`[data-ouvrir="${c.id}"]`))
    const f = b.$('[data-bind="fiche"]')
    b.saisir(f.querySelector('[data-champ="periode_debut"]'), '2026-01-01')
    await b.cliquer(f.querySelector('[data-geste="valider"]'))
    assert.match(texte(f.querySelector('[data-bind="fiche-retour"]')), /un début et une fin/)
    b.saisir(f.querySelector('[data-champ="periode_fin"]'), '2029-01-02')
    await b.cliquer(f.querySelector('[data-geste="valider"]'))
    assert.match(texte(f.querySelector('[data-bind="fiche-retour"]')), /au plus trois ans/)
    assert.deepEqual(b.gestes(), [])
  } finally { b.fermer() }
})

test('une régularisation montre son SOLDE lu à côté de la consommation, et le type change l\'aide sans rien envoyer', async () => {
  const c = facture(1, { statut: 'a_verifier', type_document: 'regularisation', periode_debut: '2025-10-01', periode_fin: '2026-09-30', solde_lu: -4520 })
  const b = await monter({ ecran: () => reponseEcran({ aTraiter: [c] }) })
  try {
    assert.match(texte(b.$('[data-bind="a-traiter"] .chg-ligne')), /Régularisation · 1 oct\.? 2025 → 30 sept\.? 2026/)
    await b.cliquer(b.$(`[data-ouvrir="${c.id}"]`))
    const aide = b.$('[data-bind="aide-type"]')
    assert.match(texte(aide), /consommation de la période .* Solde lu : -45,20\s?€/)
    await b.choisir(b.$('[data-champ="type_document"]'), 'echeancier')
    assert.match(texte(aide), /ne compte pas dans les totaux/)
    assert.deepEqual(b.gestes(), [])
  } finally { b.fermer() }
})

test('LE TEST QUI COMPTE (recette du 17 novembre 2026) : un avis d\'impôt retire les cases HT et TVA, dit « sans objet », et envoie HT = TTC, TVA = 0', async () => {
  const c = facture(1, { statut: 'a_verifier', type_document: 'avis_impot', montant_ht_cents: null, montant_tva_cents: null, montant_ttc_cents: 370000 })
  const b = await monter({ ecran: () => reponseEcran({ aTraiter: [c] }), geste: () => ({ ok: true }) })
  try {
    await b.cliquer(b.$(`[data-ouvrir="${c.id}"]`))
    const f = b.$('[data-bind="fiche"]')
    const case_ = (k) => f.querySelector(`[data-champ="${k}"]`).closest('label')
    assert.equal(case_('montant_ht_cents').hidden, true)
    assert.equal(case_('montant_tva_cents').hidden, true)
    assert.equal(case_('montant_ttc_cents').hidden, false)
    assert.match(texte(f.querySelector('[data-bind="aide-type"]')), /sans objet, un impôt n'a pas de TVA/)
    // Une case retirée ne bloque rien, même illisible.
    b.saisir(f.querySelector('[data-champ="montant_ht_cents"]'), 'abc')
    await b.cliquer(f.querySelector('[data-geste="valider"]'))
    const [g] = b.gestes()
    assert.deepEqual([g.champs.montant_ttc_cents, g.champs.montant_ht_cents, g.champs.montant_tva_cents], [370000, 370000, 0])
  } finally { b.fermer() }
})

test('choisir « Avis d\'impôt » retire HT et TVA ; revenir à « Facture » les rend, sans rien envoyer', async () => {
  const c = facture(1, { statut: 'a_verifier' })
  const b = await monter({ ecran: () => reponseEcran({ aTraiter: [c] }) })
  try {
    await b.cliquer(b.$(`[data-ouvrir="${c.id}"]`))
    const ht = () => b.$('[data-champ="montant_ht_cents"]').closest('label')
    const tva = () => b.$('[data-champ="montant_tva_cents"]').closest('label')
    assert.deepEqual([ht().hidden, tva().hidden], [false, false])
    await b.choisir(b.$('[data-champ="type_document"]'), 'avis_impot')
    assert.deepEqual([ht().hidden, tva().hidden], [true, true])
    await b.choisir(b.$('[data-champ="type_document"]'), 'facture')
    assert.deepEqual([ht().hidden, tva().hidden], [false, false])
    assert.deepEqual(b.gestes(), [])
  } finally { b.fermer() }
})

test('LE TEST QUI COMPTE (review du correctif, constat A) : quitter « Avis d\'impôt » VIDE le HT = TTC et la TVA à 0 posés par la règle — jamais une TVA à 0 que personne n\'a lue', async () => {
  const c = facture(1, { statut: 'a_verifier', type_document: 'avis_impot', montant_ht_cents: 12000, montant_tva_cents: 0, montant_ttc_cents: 12000 })
  const b = await monter({ ecran: () => reponseEcran({ aTraiter: [c] }), geste: () => ({ ok: true }) })
  try {
    await b.cliquer(b.$(`[data-ouvrir="${c.id}"]`))
    await b.choisir(b.$('[data-champ="type_document"]'), 'facture')
    assert.deepEqual([b.$('[data-champ="montant_ht_cents"]').value, b.$('[data-champ="montant_tva_cents"]').value], ['', ''])
    assert.equal(b.$('[data-champ="montant_ttc_cents"]').value, '120,00', 'le TTC, lui, était lu : il reste')
    await b.cliquer(b.$('[data-geste="valider"]'))
    const [g] = b.gestes()
    assert.deepEqual([g.champs.type_document, g.champs.montant_ttc_cents, g.champs.montant_ht_cents, g.champs.montant_tva_cents], ['facture', 12000, null, null])
  } finally { b.fermer() }
})

test('des montants TAPÉS sur une facture survivent à un aller-retour par « Avis d\'impôt »', async () => {
  const c = facture(1, { statut: 'a_verifier', montant_ht_cents: 10000, montant_tva_cents: 2000, montant_ttc_cents: 12000 })
  const b = await monter({ ecran: () => reponseEcran({ aTraiter: [c] }) })
  try {
    await b.cliquer(b.$(`[data-ouvrir="${c.id}"]`))
    await b.choisir(b.$('[data-champ="type_document"]'), 'avis_impot')
    await b.choisir(b.$('[data-champ="type_document"]'), 'facture')
    assert.deepEqual([b.$('[data-champ="montant_ht_cents"]').value, b.$('[data-champ="montant_tva_cents"]').value], ['100,00', '20,00'])
  } finally { b.fermer() }
})

// ─── L'ajout d'une facture ──────────────────────────────────────────────────
test('LE TEST QUI COMPTE : un PDF part en trois temps — envoi, dépôt au stockage, confirmer — puis sa fiche s\'ouvre', async () => {
  const lue = facture(7, { statut: 'a_verifier', fournisseur_nom: 'EDF' })
  let apres = false
  const b = await monter({
    ecran: () => reponseEcran({ aTraiter: apres ? [lue] : [] }),
    geste: (corps) => {
      if (corps.action === 'envoi') return { ok: true, id: lue.id, url: 'https://stockage.test/envoi/x?token=t', jeton: 't' }
      if (corps.action === 'confirmer') { apres = true; return { ok: true, issue: 'lue', charge: lue } }
      return { ok: true }
    }
  })
  try {
    await b.deposerFichier('facture.pdf', 'application/pdf')
    const suite = b.journal.fetch.map(f => `${f.methode} ${f.url.replace(/\?.*$/, '')}`)
    assert.deepEqual(suite, ['GET /api/ecran/charges', 'POST /api/charges', 'PUT https://stockage.test/envoi/x', 'POST /api/charges', 'GET /api/ecran/charges'])
    const [envoi, confirmer] = b.gestes()
    assert.deepEqual(envoi, { action: 'envoi', type: 'application/pdf', octets: 8, origine: 'fichier' })
    assert.deepEqual(confirmer, { action: 'confirmer', id: lue.id })
    assert.equal(b.journal.fetch[2].entetes['x-upsert'], 'false', 'un dépôt n\'écrase jamais un fichier')
    assert.equal(b.$('[data-champ="fournisseur_nom"]').value, 'EDF', 'la fiche s\'ouvre pré-remplie')
  } finally { b.fermer() }
})

test('un PDF SANS TYPE (certains sélecteurs Android, Windows) part avec le type annoncé à `envoi`', async () => {
  const b = await monter({ geste: (corps) => (corps.action === 'envoi' ? { ok: true, id: id(10), url: 'https://stockage.test/envoi/w', jeton: 't' } : { ok: true, issue: 'lue', charge: facture(10, { statut: 'a_verifier' }) }) })
  try {
    await b.deposerFichier('facture.pdf', '')
    const [envoi] = b.gestes()
    assert.equal(envoi.type, 'application/pdf')
    const depot = b.journal.fetch.find(f => f.methode === 'PUT')
    const partie = depot.corps.get('')
    assert.equal(partie.type, 'application/pdf', 'le bucket refuse application/octet-stream')
    assert.equal(partie.size, 8)
  } finally { b.fermer() }
})

test('une photo est RÉDUITE avant l\'envoi, et part en JPEG', async () => {
  const b = await monter({ geste: (corps) => (corps.action === 'envoi' ? { ok: true, id: id(8), url: 'https://stockage.test/envoi/y', jeton: 't' } : { ok: true, issue: 'panne', charge: facture(8, { statut: 'a_lire', motif: 'panne_ia' }) }) })
  try {
    await b.deposerFichier('photo.png', 'image/png', 'png-lourd-et-original')
    const [envoi] = b.gestes()
    assert.deepEqual(envoi, { action: 'envoi', type: 'image/jpeg', octets: 'jpeg-reduit'.length, origine: 'photo' })
    assert.match(b.$('[data-bind="fiche"]').textContent, /La lecture reprendra seule/)
  } finally { b.fermer() }
})

test('un type refusé ne part pas ; un dépôt en échec le dit et ne confirme rien', async () => {
  const b = await monter({ geste: () => ({ ok: true, id: id(9), url: 'https://stockage.test/envoi/z', jeton: 't' }), depot: () => 500 })
  try {
    await b.deposerFichier('notes.txt', 'text/plain')
    assert.deepEqual(b.gestes(), [])
    assert.match(texte(b.$('[data-bind="envoi"]')), /Seuls les PDF et les images sont acceptés/)
    await b.deposerFichier('facture.pdf', 'application/pdf')
    assert.deepEqual(b.gestes().map(g => g.action), ['envoi'], 'pas de « confirmer » sans fichier déposé')
    assert.match(texte(b.$('[data-bind="envoi"]')), /serveur ne répond pas/)
  } finally { b.fermer() }
})

// ─── Toute image que l'appareil sait lire (Thierry, 19 novembre 2026) ───────
// Des factures reçues par SMS ne passaient pas : seuls JPEG et PNG étaient
// pris. Toute image lisible par l'appareil part désormais en JPEG ; une image
// illisible est refusée en NOMMANT son format.

const geste8 = (corps) => (corps.action === 'envoi' ? { ok: true, id: id(8), url: 'https://stockage.test/envoi/y', jeton: 't' } : { ok: true, issue: 'panne', charge: facture(8, { statut: 'a_lire', motif: 'panne_ia' }) })

test('LE TEST QUI COMPTE : une image WebP (messageries) est acceptée et part en JPEG', async () => {
  const b = await monter({ geste: geste8 })
  try {
    await b.deposerFichier('facture.webp', 'image/webp', 'webp-original')
    assert.deepEqual(b.journal.reduits, [{ type: 'image/webp', taille: 'webp-original'.length }])
    const [envoi] = b.gestes()
    assert.deepEqual(envoi, { action: 'envoi', type: 'image/jpeg', octets: 'jpeg-reduit'.length, origine: 'photo' })
  } finally { b.fermer() }
})

test('LE TEST QUI COMPTE : une photo HEIC SANS type (sélecteur Android) se reconnaît à son extension ; lisible par l\'appareil (iPhone, Mac), elle part en JPEG', async () => {
  const b = await monter({ geste: geste8 })
  try {
    await b.deposerFichier('IMG_20261118_235016.heic', '', 'heic-original')
    assert.deepEqual(b.journal.reduits, [{ type: 'image/heic', taille: 'heic-original'.length }], 'le type reconnu est donné au fichier')
    const [envoi] = b.gestes()
    assert.equal(envoi.type, 'image/jpeg')
  } finally { b.fermer() }
})

test('LE TEST QUI COMPTE (§14.19) : une photo HEIC que l\'appareil ne sait pas lire (Chrome) part TELLE QUELLE, annoncée et déposée en HEIC — le serveur la convertit', async () => {
  const illisible = () => { throw Object.assign(new Error('type'), { code: 'type' }) }
  const b = await monter({ geste: geste8, preparerJpeg: illisible })
  try {
    await b.deposerFichier('photo.heif', 'image/heif', 'heif-original')
    const [envoi, confirmer] = b.gestes()
    assert.deepEqual(envoi, { action: 'envoi', type: 'image/heif', octets: 'heif-original'.length, origine: 'photo' })
    assert.equal(confirmer.action, 'confirmer')
    const depot = b.journal.fetch.find(f => f.url.startsWith('https://stockage.test/'))
    const fichier = depot.corps.get('')
    assert.equal(fichier.type, 'image/heif', 'le fichier déposé porte le type annoncé — celui que le bucket accepte')
    assert.equal(fichier.size, 'heif-original'.length, 'les octets d\'origine, pas une réduction (« jpeg-reduit »)')
    b.journal.fetch.length = 0
    // Une autre image illisible : refusée en le disant, sans parler de HEIC.
    const avant = b.gestes().length
    await b.deposerFichier('scan.bmp', 'image/bmp')
    assert.equal(b.gestes().length, avant, 'rien ne part')
    assert.match(texte(b.$('[data-bind="envoi"]')), /ne sait pas lire cette image/)
    assert.doesNotMatch(texte(b.$('[data-bind="envoi"]')), /HEIC/)
  } finally { b.fermer() }
})

test('le sélecteur propose toutes les images, HEIC compris ; un fichier ni PDF ni image est toujours refusé', async () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'pages', 'charges.html'), 'utf8')
  // ⚠ LA LISTE EST EXPLICITE, PAS `image/*` : « /* » dans une page se lit
  // comme un début de commentaire par les tests qui nettoient le code
  // (tests/pages-non-delegables.test.js), et masquait la garde de la page.
  assert.match(html, /<input type="file" data-bind="fichier" accept="application\/pdf,image\/jpeg,image\/png,image\/webp,image\/gif,image\/avif,image\/bmp,image\/tiff,image\/heic,image\/heif,\.heic,\.heif"/)
  const { typeDuFichier } = await import('../shared/charges-vue.js')
  assert.equal(typeDuFichier({ type: '', name: 'a.HEIC' }), 'image/heic')
  assert.equal(typeDuFichier({ type: 'application/octet-stream', name: 'b.jpg' }), 'image/jpeg', 'un type générique cède à l\'extension')
  assert.equal(typeDuFichier({ type: '', name: 'c.pdf' }), 'application/pdf')
  assert.equal(typeDuFichier({ type: 'text/plain', name: 'd.txt' }), 'text/plain')
  assert.equal(typeDuFichier({ type: '', name: 'x.heic.jpg' }), 'image/jpeg', 'la dernière extension compte')
  assert.equal(typeDuFichier({ type: '', name: 'sans-extension' }), '')
  assert.equal(typeDuFichier({ type: '', name: 'X.PDF' }), 'application/pdf')
  assert.equal(typeDuFichier({ type: '', name: 'scan.tiff' }), 'image/tiff')
})

test('formatDuContenu : le format se lit dans les premiers octets', async () => {
  const { formatDuContenu } = await import('../shared/charges-vue.js')
  const o = (s) => Uint8Array.from(s, c => c.charCodeAt(0))
  assert.equal(formatDuContenu(o('%PDF-1.7')), 'application/pdf')
  assert.equal(formatDuContenu(Uint8Array.from([0xFF, 0xD8, 0xFF, 0xE0])), 'image/jpeg')
  assert.equal(formatDuContenu(Uint8Array.from([0x89, 0x50, 0x4E, 0x47])), 'image/png')
  assert.equal(formatDuContenu(o('RIFF\0\0\0\0WEBP')), 'image/webp')
  assert.equal(formatDuContenu(o('\0\0\0\x18ftypheic')), 'image/heic')
  assert.equal(formatDuContenu(o('\0\0\0\x18ftypmif1')), 'image/heic')
  assert.equal(formatDuContenu(o('\0\0\0\x18ftypavif')), 'image/avif')
  assert.equal(formatDuContenu(o('bonjour')), '')
})

test('LE TEST QUI COMPTE (review, constat 1) : un HEIC enregistré en « .jpg » est reconnu à son CONTENU, et part en HEIC pour le serveur', async () => {
  const illisible = () => { throw Object.assign(new Error('type'), { code: 'type' }) }
  const b = await monter({ geste: geste8, preparerJpeg: illisible })
  try {
    await b.deposerFichier('facture-sms.jpg', 'image/jpeg', '\0\0\0\x18ftypheic-et-la-suite')
    const [envoi] = b.gestes()
    assert.equal(envoi.type, 'image/heic')
    const depot = b.journal.fetch.find(f => f.url.startsWith('https://stockage.test/'))
    assert.equal(depot.corps.get('').type, 'image/heic')
  } finally { b.fermer() }
})

test('un HEIC de plus de 10 Mo est refusé AVANT tout envoi, en le disant', async () => {
  const illisible = () => { throw Object.assign(new Error('type'), { code: 'type' }) }
  const b = await monter({ geste: geste8, preparerJpeg: illisible })
  try {
    await b.deposerFichier('grosse.heic', 'image/heic', 'x'.repeat(10 * 1024 * 1024 + 1))
    assert.deepEqual(b.gestes(), [])
    assert.match(texte(b.$('[data-bind="envoi"]')), /trop lourd|trop volumineux|trop gros/i)
  } finally { b.fermer() }
})

test('le serveur qui ne sait pas convertir la photo (422) le dit, avec quoi faire', async () => {
  const illisible = () => { throw Object.assign(new Error('type'), { code: 'type' }) }
  const geste = (corps) => {
    if (corps.action === 'envoi') return { ok: true, id: id(13), url: 'https://stockage.test/envoi/h', jeton: 't' }
    throw Object.assign(new Error('x'), { status: 422, error: 'conversion_impossible' })
  }
  const b = await monter({ geste, preparerJpeg: illisible })
  try {
    await b.deposerFichier('photo.heic', 'image/heic', 'heic')
    assert.match(texte(b.$('[data-bind="envoi"]')), /n'a pas pu être convertie.*capture d'écran/)
  } finally { b.fermer() }
})

test('le convertisseur PRIS se dit autrement qu\'une panne : « réessayez dans un instant » (troisième review HEIC, mineur 5)', async () => {
  const geste = (corps) => {
    if (corps.action === 'envoi') return { ok: true, id: id(13), url: 'https://stockage.test/envoi/o', jeton: 't' }
    throw Object.assign(new Error('x'), { status: 503, error: 'conversion_occupee' })
  }
  const b = await monter({ geste, preparerJpeg: async () => { throw Object.assign(new Error('x'), { code: 'type' }) } })
  try {
    await b.deposerFichier('photo.heic', 'image/heic', 'heic')
    assert.match(texte(b.$('[data-bind="envoi"]')), /convertit déjà une photo : réessayez dans un instant/)
  } finally { b.fermer() }
})

test('un fichier SANS nom parlant ni type (sélecteur Android) est reconnu à son contenu : un PDF part en PDF', async () => {
  const b = await monter({ geste: (corps) => (corps.action === 'envoi' ? { ok: true, id: id(11), url: 'https://stockage.test/envoi/v', jeton: 't' } : { ok: true, issue: 'lue', charge: facture(11, { statut: 'a_verifier' }) }) })
  try {
    await b.deposerFichier('document', '', '%PDF-1.4 contenu')
    const [envoi] = b.gestes()
    assert.equal(envoi.type, 'application/pdf')
  } finally { b.fermer() }
})

test('LE TEST QUI COMPTE (review, constat 5) : un PDF typé `application/octet-stream` part en PDF, annoncé ET déposé', async () => {
  const b = await monter({ geste: (corps) => (corps.action === 'envoi' ? { ok: true, id: id(12), url: 'https://stockage.test/envoi/u', jeton: 't' } : { ok: true, issue: 'lue', charge: facture(12, { statut: 'a_verifier' }) }) })
  try {
    await b.deposerFichier('facture.pdf', 'application/octet-stream')
    const [envoi] = b.gestes()
    assert.equal(envoi.type, 'application/pdf')
    const depot = b.journal.fetch.find(f => f.url.startsWith('https://stockage.test/'))
    assert.equal(depot.corps.get('').type, 'application/pdf', 'le fichier déposé porte le type annoncé')
  } finally { b.fermer() }
})

test('une panne de conversion qui n\'est PAS un refus de format (mémoire, canvas) n\'accuse pas le format (review, constat 3)', async () => {
  const panne = () => { throw new TypeError('getContext a rendu null') }
  const b = await monter({ geste: geste8, preparerJpeg: panne })
  try {
    await b.deposerFichier('photo.heic', 'image/heic')
    assert.deepEqual(b.gestes(), [])
    assert.match(texte(b.$('[data-bind="envoi"]')), /n'a pas pu être enregistrée/)
    assert.doesNotMatch(texte(b.$('[data-bind="envoi"]')), /HEIC/)
  } finally { b.fermer() }
})

test('« trop d\'envois » (429) est dit tel quel', async () => {
  const b = await monter({ geste: () => { throw Object.assign(new Error('x'), { status: 429, error: 'trop_d_envois' }) } })
  try {
    await b.deposerFichier('facture.pdf', 'application/pdf')
    assert.match(texte(b.$('[data-bind="envoi"]')), /Trop d'envois en cours/)
  } finally { b.fermer() }
})

// ─── L'échappement ──────────────────────────────────────────────────────────
test('LE TEST QUI COMPTE : un texte venu d\'une facture n\'est JAMAIS interprété comme du HTML', async () => {
  // Un fournisseur lu par l'IA sur une facture reçue par e-mail (lot 5) est un
  // texte d'un inconnu. Contre-épreuve faite : `esc` remplacée par l'identité,
  // ce test rougit.
  const piege = '<img src=x data-piege="1">'
  const c = facture(1, { statut: 'a_verifier', fournisseur_nom: piege, numero_facture: piege, fournisseur_siret: piege, categorie: piege })
  const b = await monter({
    ecran: () => {
      const r = reponseEcran({ aTraiter: [c], liste: [c], entites: [{ id: ENT, nom: piege, archivee: false, debut_exercice: null }], biens: [{ id: BIEN, nom: piege, entite_id: ENT }] })
      r.totaux.par_bien = [{ cle: BIEN, ttc: 100, nb_factures: 1 }]
      r.totaux.par_categorie = [{ cle: piege, ttc: 100, nb_factures: 1 }]
      return r
    }
  })
  try {
    await b.cliquer(b.$(`[data-ouvrir="${c.id}"]`))
    assert.equal(b.$$('[data-piege]').length, 0, 'aucune balise injectée, ni dans les listes, ni dans les totaux, ni dans la fiche')
    assert.ok(texte(b.$('[data-bind="a-traiter"]')).includes(piege), 'le texte apparaît tel quel')
    assert.ok(texte(b.$('[data-bind="totaux"]')).includes(piege))
    assert.equal(b.$('[data-champ="fournisseur_nom"]').value, piege)
    assert.ok([...b.$('[data-champ="entite_juridique_id"]').options].some(o => o.textContent === piege))
  } finally { b.fermer() }
})

test('un 403 sur un geste dit le VRAI motif (logement sorti du compte), pas « page réservée »', async () => {
  const c = facture(1, { statut: 'a_verifier' })
  const b = await monter({ ecran: () => reponseEcran({ aTraiter: [c] }), geste: () => { throw Object.assign(new Error('x'), { status: 403, error: 'bien_hors_compte' }) } })
  try {
    await b.cliquer(b.$(`[data-ouvrir="${c.id}"]`))
    await b.cliquer(b.$('[data-geste="valider"]'))
    assert.match(texte(b.$('[data-bind="fiche-retour"]')), /n'est plus dans votre compte/)
  } finally { b.fermer() }
})

// ─── Le mobile suit l'ordinateur ────────────────────────────────────────────
test('une seule vue : la fiche plein écran et les totaux sous « À traiter » au téléphone, par la feuille seule', () => {
  const css = lire('shared/ui.css')
  const bloc = css.slice(css.indexOf('/* ═══ PAGE CHARGES'))
  // Depuis le lot 8a, les blocs se suivent sur toute la largeur aux deux
  // tailles : plus de grille à deux colonnes à défaire au téléphone.
  assert.doesNotMatch(bloc, /\.chg-haut\b/)
  assert.match(bloc, /@media \(max-width: 899px\)[\s\S]*\.chg-cols \{ grid-template-columns: minmax\(0, 1fr\) 88px 88px 16px;/)
  assert.match(bloc, /@media \(max-width: 899px\)[\s\S]*\.chg-fiche \{ width: 100%; \}/)
  // ⚠ RECETTE DU 11 NOVEMBRE : `100vw` compte la barre de défilement (la fiche
  // débordait à gauche), et un montant coupé au milieu se lisait « 1761,9 / 0 € ».
  assert.doesNotMatch(bloc.replace(/\/\*[\s\S]*?\*\//g, ''), /100vw/)
  assert.match(bloc, /\.chg-total__fort b \{[^}]*white-space: nowrap;/)
  assert.match(bloc, /\.chg-col \{[^}]*white-space: nowrap;/)
  assert.ok(!/#[0-9A-Fa-f]{3,6}\b/.test(bloc), 'aucun hexa hors de theme.css')
})

// ─── Les crédits (§14.20) ───────────────────────────────────────────────────
const CREDIT_ID = '99999999-9999-4999-8999-999999999999'
const UN_CREDIT = {
  liste: [{ id: CREDIT_ID, entite_juridique_id: ENT, bien_id: null, preteur: 'Banque Exemple', nb_echeances: 301, premiere_echeance: '2022-02-22', derniere_echeance: '2047-02-22', cree_le: '2026-11-19T01:00:00Z' }],
  echeances: [{ credit_id: CREDIT_ID, date_echeance: '2026-11-22', interets_cents: 30160, assurance_cents: 10125, accessoires_cents: 0, capital_cents: 83258, echeance_cents: 123543, capital_restant_cents: 25000000 }],
  aujourdhui: '2026-11-25'
}

test('LE TEST QUI COMPTE (§14.20) : sous le mois, la mensualité ENTIÈRE payée, capital compris — et le crédit dans son bloc', async () => {
  const b = await monter({ ecran: () => reponseEcran({ credits: UN_CREDIT }) })
  try {
    const mois = texte(b.$('[data-bind="totaux"] .chg-rep__credit'))
    assert.match(mois, /Crédit, mensualité payée/)
    assert.match(mois, /1\s?235,43\s?€/)
    assert.match(mois, /dont 832,58\s?€ de capital/)
    const bloc = texte(b.$('[data-bind="credits"]'))
    assert.match(bloc, /Banque Exemple/)
    assert.match(bloc, /Tous les logements de l'entité/)
    assert.match(bloc, /301 échéances, du 22 févr\. 2022 au 22 févr\. 2047/)
    assert.equal(b.lecturesEcran().length, 1, 'toujours un seul appel au chargement')
  } finally { b.fermer() }
})

test('sans crédit, le bloc invite à en ajouter un ; sans lecture, il dit « indisponible », jamais « aucun »', async () => {
  const vide = await monter()
  try { assert.match(texte(vide.$('[data-bind="credits"]')), /Aucun crédit/) } finally { vide.fermer() }
  const panne = await monter({ ecran: () => reponseEcran({ credits: null }) })
  try { assert.match(texte(panne.$('[data-bind="credits"]')), /indisponibles/) } finally { panne.fermer() }
})

test('LE TEST QUI COMPTE : importer un crédit envoie le PDF en base64 avec la banque et l\'entité, puis relit l\'écran', async () => {
  const gestes = []
  const geste = (corps) => {
    gestes.push(corps)
    return { ok: true, credit: { id: CREDIT_ID, nb_echeances: 301, premiere_echeance: '2022-02-22', derniere_echeance: '2047-02-22' }, charges: 57 }
  }
  const b = await monter({ geste })
  try {
    await b.cliquer(b.$('[data-geste="credit-ajouter"]'))
    const fichier = b.$('[data-credit-champ="fichier"]')
    Object.defineProperty(fichier, 'files', { value: [new b.w.File(['%PDF-1.4 tableau'], 'tableau.pdf', { type: 'application/pdf' })], configurable: true })
    b.saisir(b.$('[data-credit-champ="preteur"]'), 'Banque Exemple')
    assert.equal(b.$('[data-credit-champ="entite"]').value, ENT, 'la seule entité active est choisie')
    assert.match(texte(b.$('[data-credit-champ="bien"]')), /Tous les logements de l'entité/)
    await b.cliquer(b.$('[data-geste="credit-importer"]'))
    for (let i = 0; i < 10; i++) await b.attendre()
    assert.deepEqual(gestes, [{ action: 'credit_importer', fichier: Buffer.from('%PDF-1.4 tableau').toString('base64'), preteur: 'Banque Exemple', entite_id: ENT, bien_id: null }])
    assert.equal(b.lecturesEcran().length, 2, 'l\'écran est relu : les charges et la ligne du mois apparaissent')
    assert.match(texte(b.$('[data-bind="credits"]')), /301 échéances lues.*Les 57 mensualités déjà passées sont dans vos charges/)
    assert.equal(b.$('[data-bind="credit-form"]'), null, 'le formulaire se referme')
  } finally { b.fermer() }
})

test('une ligne du tableau qui ne se prouve pas est NOMMÉE par sa date ; rien ne part sans fichier ni banque', async () => {
  const geste = () => { throw Object.assign(new Error('x'), { status: 422, error: 'ligne_incoherente', detail: '2023-06-22' }) }
  const b = await monter({ geste })
  try {
    await b.cliquer(b.$('[data-geste="credit-ajouter"]'))
    await b.cliquer(b.$('[data-geste="credit-importer"]'))
    assert.match(texte(b.$('[data-bind="credit-retour"]')), /Choisissez le tableau/)
    const fichier = b.$('[data-credit-champ="fichier"]')
    Object.defineProperty(fichier, 'files', { value: [new b.w.File(['%PDF'], 't.pdf', { type: 'application/pdf' })], configurable: true })
    await b.cliquer(b.$('[data-geste="credit-importer"]'))
    assert.match(texte(b.$('[data-bind="credit-retour"]')), /Indiquez la banque/)
    assert.deepEqual(b.gestes(), [])
    b.saisir(b.$('[data-credit-champ="preteur"]'), 'Banque')
    await b.cliquer(b.$('[data-geste="credit-importer"]'))
    for (let i = 0; i < 10; i++) await b.attendre()
    assert.match(texte(b.$('[data-bind="credit-retour"]')), /La ligne du 22 juin 2023 ne se vérifie pas/)
  } finally { b.fermer() }
})

test('supprimer un crédit demande confirmation, puis relit l\'écran', async () => {
  const b = await monter({ ecran: () => reponseEcran({ credits: UN_CREDIT }) })
  try {
    await b.cliquer(b.$('[data-geste="credit-supprimer"]'))
    assert.match(b.journal.confirmations[0], /Supprimer ce crédit/)
    assert.deepEqual(b.gestes(), [{ action: 'credit_supprimer', id: CREDIT_ID }])
    assert.equal(b.lecturesEcran().length, 2)
  } finally { b.fermer() }
})

test('LE TEST QUI COMPTE : la fiche d\'une échéance de crédit se LIT — champs figés, ni Valider, ni Supprimer, ni Voir', async () => {
  const echeance = facture(21, { origine: 'credit', categorie: 'credit', fournisseur_nom: 'Banque Exemple', numero_facture: null, montant_ht_cents: 40285, montant_tva_cents: 0, montant_ttc_cents: 40285 })
  const b = await monter({ ecran: () => reponseEcran({ liste: [echeance] }) })
  try {
    await b.cliquer(b.$(`[data-ouvrir="${echeance.id}"]`))
    const f = b.$('[data-bind="fiche"]')
    assert.ok([...f.querySelectorAll('[data-champ]')].every(c => c.disabled))
    for (const g of ['valider', 'supprimer', 'voir']) assert.equal(f.querySelector(`[data-geste="${g}"]`), null, g)
    assert.match(texte(f), /Mensualité d'un crédit/)
    assert.equal(f.querySelector('[data-champ="categorie"]').value, 'credit', 'sa catégorie s\'affiche, même hors de la liste fermée')
  } finally { b.fermer() }
})

test('LE TEST QUI COMPTE (review du crédit, B1) : une échéance PAS ENCORE ÉCHUE se dit « à venir », jamais « payée »', async () => {
  const b = await monter({ ecran: () => reponseEcran({ credits: { ...UN_CREDIT, aujourdhui: '2026-11-19' } }) })
  try {
    const mois = texte(b.$('[data-bind="totaux"] .chg-rep__credit'))
    assert.match(mois, /Crédit, mensualité à venir/)
    assert.doesNotMatch(texte(b.$('[data-bind="totaux"]')), /mensualité payée/)
  } finally { b.fermer() }
})

test('l\'échéance DU JOUR est payée — la même règle que l\'import et le cron, `<=` (seconde review, mineur 5)', async () => {
  const b = await monter({ ecran: () => reponseEcran({ credits: { ...UN_CREDIT, aujourdhui: '2026-11-22' } }) })
  try {
    assert.match(texte(b.$('[data-bind="totaux"] .chg-rep__credit')), /Crédit, mensualité payée/)
    assert.doesNotMatch(texte(b.$('[data-bind="totaux"]')), /mensualité à venir/)
  } finally { b.fermer() }
})

test('un logement choisi part avec le crédit ; les refus du crédit ont leurs mots (review, mineur 5)', async () => {
  const gestes = []
  const geste = (corps) => { gestes.push(corps); throw Object.assign(new Error('x'), { status: 413, error: 'trop_gros' }) }
  const b = await monter({ geste })
  try {
    await b.cliquer(b.$('[data-geste="credit-ajouter"]'))
    Object.defineProperty(b.$('[data-credit-champ="fichier"]'), 'files', { value: [new b.w.File(['%PDF'], 't.pdf', { type: 'application/pdf' })], configurable: true })
    b.saisir(b.$('[data-credit-champ="preteur"]'), 'Banque')
    await b.choisir(b.$('[data-credit-champ="bien"]'), BIEN)
    await b.cliquer(b.$('[data-geste="credit-importer"]'))
    for (let i = 0; i < 10; i++) await b.attendre()
    assert.equal(gestes[0].bien_id, BIEN)
    assert.match(texte(b.$('[data-bind="credit-retour"]')), /dépasse 2 Mo/)
  } finally { b.fermer() }
})
