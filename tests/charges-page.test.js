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
const { monter, reponseEcran, facture, ENT, BIEN, BIEN_VIEUX, id } = require('./outils/banc-charges')

const racine = path.join(__dirname, '..')
const lire = p => fs.readFileSync(path.join(racine, p), 'utf8')
const sansCommentaires = src => src
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\s\/\/ .*$/gm, '')
const texte = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '')

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
    ...['exercice', 'exercice_precedent', '12_mois'].map(p => 'charges.periode_' + p),
    ...require('../lib/charges/regles').CATEGORIES.map(c => 'charges.cat_' + c.cle),
    ...['montant_invalide', 'categorie_invalide', 'entite_requise', 'type_refuse', 'trop_gros'].map(c => 'charges.refus_' + c)
  ])
  assert.ok(vue.includes("t('charges.etat_' + e)"), 'la famille des états a changé : mettre ce test à jour')
  assert.ok(vue.includes("t('charges.periode_' + p)"), 'la famille des périodes a changé : mettre ce test à jour')
  assert.ok(cles.size > 60, `extraction vide (${cles.size})`)
  for (const l of ['fr', 'en', 'es']) {
    const d = JSON.parse(lire(`shared/i18n/${l}.json`))
    for (const k of cles) assert.ok(typeof d[k] === 'string' && d[k].trim(), `${l} : clé « ${k} » absente ou vide`)
  }
})

test('les périodes de la vue sont celles du serveur (`PERIODES` fait foi)', () => {
  const { PERIODES } = require('../lib/charges/ecran')
  assert.deepEqual(PERIODES, ['exercice', 'exercice_precedent', '12_mois'])
})

// ─── Le budget ──────────────────────────────────────────────────────────────
test('LE TEST QUI COMPTE (budget) : UN appel au chargement, vers l\'appel d\'écran, et la garde de compte propre AVANT', async () => {
  const b = await monter({ ecran: () => reponseEcran({ aTraiter: [facture(1, { statut: 'a_verifier' })], liste: Array.from({ length: 50 }, (_, i) => facture(100 + i)) }) })
  try {
    assert.deepEqual(b.journal.fetch.map(f => `${f.methode} ${f.url}`), ['GET /api/ecran/charges?entite=toutes'])
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
    total: { ht: 10000, tva: null, ttc: 12000, nb_factures: 3, nb_non_verifiees: 2, nb_signaux: 0, nb_sans_ht: 1, nb_sans_tva: 3, nb_sans_ttc: 0 },
    par_mois: [{ cle: '2026-10', ttc: 5000, nb_factures: 1 }, { cle: '2026-11', ttc: 7000, nb_factures: 2 }],
    // ⚠ Une ligne SANS facture comptée (un doublon écarté, une lecture en
    // cours) ne s'affiche pas : son montant n'est pas « non lu ».
    par_categorie: [{ cle: 'energie', ttc: 7000, nb_factures: 2 }, { cle: null, ttc: null, nb_factures: 1 }, { cle: 'menage', ttc: null, nb_factures: 0 }],
    par_bien: [{ cle: BIEN, ttc: 6000, nb_factures: 1 }, { cle: BIEN_VIEUX, ttc: 4000, nb_factures: 1 }, { cle: null, ttc: 2000, nb_factures: 1 }],
    calcule_le: '2026-11-10T19:05:00Z', entite: null, periode: '12_mois', proposees: ['12_mois'], debut: '2025-12-01', fin: '2026-11-30'
  }
  const b = await monter({ ecran: () => reponseEcran({ totaux }) })
  try {
    const z = b.$('[data-bind="totaux"]')
    const chiffres = [...z.querySelectorAll('.chg-chiffre')].map(el => [...el.children].map(texte).join(' '))
    assert.match(chiffres[0], /^TTC 120,00\s?€$/)
    assert.match(chiffres[1], /^HT 100,00\s?€ 1 sans montant lu$/)
    assert.match(chiffres[2], /^TVA non lu 3 sans montant lu$/)
    assert.match(texte(z.querySelector('.chg-mentions--estimation')), /Estimation · 2 à vérifier · Calculé le/)
    assert.match(texte(z), /Du 1 déc\.? 2025 au 30 nov\.? 2026/)
    const reps = [...z.querySelectorAll('.chg-rep')].map(el => [...el.querySelectorAll('h3, li > *')].map(texte).join(' '))
    assert.match(reps[0], /Par mois octobre 2026 50,00\s?€ novembre 2026 70,00\s?€/)
    assert.match(reps[1], /^Par catégorie Eau, électricité, gaz 70,00\s?€ Sans catégorie non lu$/, 'la ligne Ménage, sans facture comptée, est absente')
    assert.match(reps[2], /Studio 60,00\s?€ Ancien · archivé 40,00\s?€ Sans logement 20,00\s?€/)
  } finally { b.fermer() }
})

test('des factures seulement EN ATTENTE : « aucune comptée », mais l\'estimation reste dite', async () => {
  const totaux = { total: { ht: null, tva: null, ttc: null, nb_factures: 0, nb_non_verifiees: 2, nb_signaux: 0, nb_sans_ht: 0, nb_sans_tva: 0, nb_sans_ttc: 0 }, par_mois: [], par_categorie: [], par_bien: [], calcule_le: '2026-11-10T19:05:00Z', entite: null, periode: '12_mois', proposees: ['12_mois'], debut: '2025-12-01', fin: '2026-11-30' }
  const b = await monter({ ecran: () => reponseEcran({ totaux }) })
  try {
    const z = b.$('[data-bind="totaux"]')
    assert.match(texte(z), /Aucune facture comptée/)
    assert.match(texte(z), /Estimation · 2 à vérifier/)
    assert.equal(z.querySelectorAll('.chg-chiffre').length, 0)
  } finally { b.fermer() }
})

test('LE TEST QUI COMPTE : un doublon non tranché rend le total « estimation » (spec §6), même tout vérifié', async () => {
  const totaux = { total: { ht: 10000, tva: 2000, ttc: 12000, nb_factures: 1, nb_non_verifiees: 0, nb_signaux: 2, nb_sans_ht: 0, nb_sans_tva: 0, nb_sans_ttc: 0 }, par_mois: [], par_categorie: [], par_bien: [], calcule_le: '2026-11-10T19:05:00Z', entite: null, periode: '12_mois', proposees: ['12_mois'], debut: '2025-12-01', fin: '2026-11-30' }
  const b = await monter({ ecran: () => reponseEcran({ totaux }) })
  try {
    assert.match(texte(b.$('.chg-mentions--estimation')), /^Estimation · 2 à trancher · Calculé le/)
  } finally { b.fermer() }
  // Et un montant absent dans une colonne suffit aussi.
  const t2 = { ...totaux, total: { ...totaux.total, nb_signaux: 0, nb_sans_tva: 1 } }
  const c = await monter({ ecran: () => reponseEcran({ totaux: t2 }) })
  try {
    assert.match(texte(c.$('.chg-mentions--estimation')), /^Estimation · Calculé le/)
  } finally { c.fermer() }
  // Rien à redire : pas d'« estimation ».
  const t3 = { ...totaux, total: { ...totaux.total, nb_signaux: 0 } }
  const d = await monter({ ecran: () => reponseEcran({ totaux: t3 }) })
  try {
    assert.equal(d.$('.chg-mentions--estimation'), null)
    assert.match(texte(d.$('[data-bind="totaux"] .chg-mentions:last-of-type')), /^Calculé le/)
  } finally { d.fermer() }
})

test('des totaux en panne se disent « indisponibles », la liste reste là', async () => {
  const b = await monter({ ecran: () => reponseEcran({ totaux: null, liste: [facture(1)] }) })
  try {
    assert.match(texte(b.$('[data-bind="totaux"]')), /indisponibles/)
    assert.equal(b.$$('[data-bind="liste"] .chg-ligne').length, 1)
  } finally { b.fermer() }
})

test('choisir une entité relit l\'écran avec cette entité, SANS période (le serveur choisit celle qui lui va)', async () => {
  const urls = []
  const ENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const b = await monter({
    ecran: (u) => {
      urls.push(u)
      const r = reponseEcran({ entites: [{ id: ENT, nom: 'Moi', archivee: false, debut_exercice: null }, { id: ENT_B, nom: 'SCI', archivee: true, debut_exercice: '04-01' }] })
      if (u.includes(ENT_B)) Object.assign(r.totaux, { entite: ENT_B, periode: 'exercice', proposees: ['exercice', 'exercice_precedent'] })
      return r
    }
  })
  try {
    const sel = b.$('[data-choix="entite"]')
    assert.match(texte(sel), /SCI · archivée/)
    await b.choisir(sel, ENT_B)
    assert.equal(urls[1], `/api/ecran/charges?entite=${ENT_B}`)
    await b.choisir(b.$('[data-choix="periode"]'), 'exercice_precedent')
    assert.equal(urls[2], `/api/ecran/charges?entite=${ENT_B}&periode=exercice_precedent`)
  } finally { b.fermer() }
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
    assert.equal(urls[1], `/api/ecran/charges?curseur=${encodeURIComponent(`2026-11-02|2026-11-02T10:00:00Z|${id(2)}`)}`)
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
    assert.match(texte(b.$('[data-bind="envoi"]')), /Seuls les PDF, JPEG et PNG/)
    await b.deposerFichier('facture.pdf', 'application/pdf')
    assert.deepEqual(b.gestes().map(g => g.action), ['envoi'], 'pas de « confirmer » sans fichier déposé')
    assert.match(texte(b.$('[data-bind="envoi"]')), /serveur ne répond pas/)
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
  assert.match(bloc, /@media \(max-width: 899px\)[\s\S]*\.chg-haut \{ grid-template-columns: minmax\(0, 1fr\); \}/)
  assert.match(bloc, /@media \(max-width: 899px\)[\s\S]*\.chg-fiche \{ width: 100%; \}/)
  // ⚠ RECETTE DU 11 NOVEMBRE : `100vw` compte la barre de défilement (la fiche
  // débordait à gauche), et un montant coupé au milieu se lisait « 1761,9 / 0 € ».
  assert.doesNotMatch(bloc.replace(/\/\*[\s\S]*?\*\//g, ''), /100vw/)
  assert.match(bloc, /\.chg-chiffre b \{[^}]*white-space: nowrap;/)
  assert.doesNotMatch(bloc, /\.chg-chiffre b \{[^}]*overflow-wrap: anywhere/)
  assert.match(bloc, /\.chg-chiffre--fort \{ grid-column: 1 \/ -1; \}/)
  assert.ok(!/#[0-9A-Fa-f]{3,6}\b/.test(bloc), 'aucun hexa hors de theme.css')
})
