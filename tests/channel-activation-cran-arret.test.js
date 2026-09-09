// tests/channel-activation-cran-arret.test.js
// LE CRAN D'ARRET AVANT ACTIVATION (regle gravee par Thierry, 8 septembre 2026).
//
// ⚠ LA PREMIERE VERSION DE CETTE GARDE ETAIT INERTE, et c'est la lecon a garder.
// Elle comptait les dates que Channex detient. Or Channex rend une grille DENSE,
// remplie par le prix par defaut du rate plan, meme sans qu'on ait jamais rien
// pousse — mesure directe du staging (protocole, question 3 : une date poussee
// sans `rate` relit 333.00, le defaut du plan). Le juge prenait donc le danger
// pour la preuve qu'il n'y en avait pas.
//
// Le seul juge honnete est le COEUR : detenons-NOUS un prix pour ce bien ?

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test'

const { jugerPrixDuCoeur } = require('../lib/garde-activation')

// Faux client aussi pauvre que postgrest : rend { data, error }, ne throw jamais.
function faux ({ lignes = [], erreur = null } = {}) {
  const api = {
    from () { return api }, select () { return api }, eq () { return api },
    gte () { return api }, lte () { return api }, not () { return api },
    limit: async () => ({ data: lignes, error: erreur })
  }
  return api
}

const BIEN = { id: 'uuid-bien', name: 'Test', base_price: null }

test('un prix de base suffit : toutes les dates sont couvertes', async () => {
  const r = await jugerPrixDuCoeur(faux(), { ...BIEN, base_price: 86 })
  assert.equal(r.pret, true)
  assert.equal(r.prix_detenus, 'base_price')
})

test('AUCUN prix dans le coeur : activation refusee', async () => {
  // Le cas des deux biens de Bagneres au 8 septembre 2026 : base_price NULL et
  // zero ligne dans calendar_inventory. Activer publierait le defaut du plan.
  const r = await jugerPrixDuCoeur(faux({ lignes: [] }), BIEN)
  assert.equal(r.pret, false)
  assert.equal(r.raison, 'aucun_prix_dans_le_coeur')
  assert.match(r.message, /prix par defaut du plan tarifaire/)
})

test('des prix par date suffisent, meme sans prix de base', async () => {
  const r = await jugerPrixDuCoeur(faux({ lignes: [{ date: '2026-10-01', rate: 120 }] }), BIEN)
  assert.equal(r.pret, true)
  assert.equal(r.prix_detenus, 1)
})

test('un rate a 0 n est PAS un prix', async () => {
  // Regle du depot : 0 est l'absence d'exception, pas un tarif. Le compter
  // laisserait activer un bien dont aucune date n'a de vrai prix.
  const r = await jugerPrixDuCoeur(faux({ lignes: [{ date: '2026-10-01', rate: 0 }] }), BIEN)
  assert.equal(r.pret, false)
  assert.equal(r.raison, 'aucun_prix_dans_le_coeur')
})

test('une panne de lecture REFUSE, et le dit', async () => {
  // postgrest ne throw pas. Sans lire `error`, on prendrait la panne pour
  // « aucun prix » — ici le sens est sur, mais il faut le nommer.
  const r = await jugerPrixDuCoeur(faux({ erreur: { message: 'timeout' } }), BIEN)
  assert.equal(r.pret, false)
  assert.equal(r.raison, 'lecture_impossible')
  assert.match(r.message, /timeout/)
})

test('un bien inconnu ne passe pas', async () => {
  assert.equal((await jugerPrixDuCoeur(faux(), null)).pret, false)
  assert.equal((await jugerPrixDuCoeur(faux(), {})).raison, 'bien_inconnu')
})

// ─── Les garanties structurelles, sur les DEUX endpoints ────────────────────

const MAPPING = fs.readFileSync(path.join(__dirname, '..', 'api/channel-mapping.js'), 'utf8')
const BCOM = fs.readFileSync(path.join(__dirname, '..', 'api/channel-bcom-activate.js'), 'utf8')

test('CONSTAT DE REVIEW : la garde est sur le chemin que l UI emprunte', () => {
  // Elle n'existait que dans channel-bcom-activate, qu'AUCUNE page n'appelle.
  // `HS.api.channel.activate` vise channel-mapping, avec dryRun=false par defaut.
  // Une garde posee sur le chemin que personne n'emprunte ne garde rien.
  assert.ok(MAPPING.includes('jugerPrixDuCoeur'), 'channel-mapping consulte la garde')
  assert.ok(/if \(!juge\.pret\)[\s\S]{0,200}activation_refusee/.test(MAPPING),
    'et refuse l activation reelle')
})

test('les deux endpoints partagent LA MEME garde', () => {
  // Deux gardes qui divergeraient laisseraient un interstice.
  for (const [nom, src] of [['channel-mapping', MAPPING], ['channel-bcom-activate', BCOM]]) {
    assert.ok(src.includes("require('../lib/garde-activation')"), `${nom} importe la garde partagee`)
  }
})

test('les deux endpoints SELECTIONNENT base_price', () => {
  // Le piege deja rencontre trois fois : une garde qui juge sur une colonne non
  // selectionnee lit `undefined`.
  for (const [nom, src] of [['channel-mapping', MAPPING], ['channel-bcom-activate', BCOM]]) {
    // ⚠ Tolerant aux SELECT ecrits sur plusieurs lignes, ET a la lecture passant
    // par `trouverBienParIdProvider({ colonnes })` — le point unique qui cherche
    // sur les deux identifiants du bien. Un test qui ne matche plus rien
    // passerait pour un test qui ne verifie rien.
    const select = src.match(/(\.select\(\s*'id,|colonnes:\s*'id,)[\s\S]{0,500}?\)/g) || []
    assert.ok(select.length, `${nom} : aucune lecture de bien reconnue`)
    assert.ok(select.some(x => x.includes('base_price')), `${nom} selectionne base_price`)
  }
})

test('l apercu dit s il passerait, il ne se contente pas de decrire l appel', () => {
  const apercu = MAPPING.slice(MAPPING.indexOf("if (action === 'activate')"))
  assert.ok(apercu.includes('pret_a_activer'), 'le dry run annonce le verdict')
  assert.ok(apercu.includes('blocage'), 'et le motif de blocage')
})
