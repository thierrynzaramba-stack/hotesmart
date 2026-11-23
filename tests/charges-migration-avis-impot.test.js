// tests/charges-migration-avis-impot.test.js — l'avis d'impôt n'a pas de TVA.
// Décision de Thierry, recette du lot 7a le 17 novembre 2026 : pour un
// document de type « avis_impot », HT = TTC et TVA = 0. Le writer pose la
// règle (`montantsDuType`), la base la tient (`charges_impot_ck`).
//
// ⚠ CE TEST LIT LE SQL, IL NE L'EXÉCUTE PAS (pas de Postgres dans la suite).
// La migration a été jouée deux fois sur un Postgres 16 local, sur une base
// portant 80 avis d'impôt hors règle : 80 corrigés au premier passage, 0 au
// rejeu, contrôle à true, vérificateur à 0 écart sur 8 920 cellules, et trois
// écritures hors règle refusées (TVA à 5, HT différent du TTC, TVA vide).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { montantsDuType } = require('../lib/charges/regles')

const lire = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8')
const sql = lire('migrations', '2026-11-17-charges-avis-impot.sql')
const controle = lire('migrations', '2026-11-17-controle-charges-avis-impot.sql')
const sansCommentaires = (t) => t.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
const aplati = (t) => sansCommentaires(t).replace(/\s+/g, ' ').toLowerCase()
const code = aplati(sql)

test('LE TEST QUI COMPTE : les avis déjà enregistrés sont corrigés AVANT que la contrainte soit posée', () => {
  const maj = code.indexOf('update public.charges set montant_ttc_cents = coalesce( montant_ttc_cents, montant_ht_cents), montant_ht_cents = coalesce( montant_ttc_cents, montant_ht_cents), montant_tva_cents = 0')
  const pose = code.indexOf('add constraint charges_impot_ck')
  assert.ok(maj >= 0, 'la correction des avis existants')
  assert.ok(pose > maj, 'la contrainte vient APRÈS la correction : sinon elle refuse la base telle qu\'elle est')
  assert.match(code, /where type_document = 'avis_impot' and \(montant_tva_cents is distinct from 0 or montant_ht_cents is distinct from montant_ttc_cents\)/,
    'rejouable : seuls les avis hors règle sont touchés')
  assert.match(code, /drop constraint if exists charges_impot_ck/, 'rejouable : la contrainte est retirée puis reposée')
})

test('l\'en-tête dit de coller la migration APRÈS le déploiement du code (review du correctif, constat B)', () => {
  // L'ancien code écrit des avis sans HT ni TVA : la contrainte posée avant
  // lui mettrait la lecture en panne, relancée à chaque cron.
  assert.match(sql, /APRES LE DEPLOIEMENT DU CODE/)
  assert.match(lire('docs', 'kb', 'compte-de-charges.md'), /APRÈS le déploiement/)
})

test('LE TEST QUI COMPTE : la contrainte de la base dit la MÊME règle que le writer', () => {
  assert.match(code, /check \( type_document <> 'avis_impot' or \(montant_tva_cents is not distinct from 0 and montant_ht_cents is not distinct from montant_ttc_cents\)\)/)
  // La règle de la contrainte, en JS, appliquée à ce que le writer écrit.
  const tient = (m) => m.montant_tva_cents === 0 && m.montant_ht_cents === m.montant_ttc_cents
  for (const lu of [
    { montant_ht_cents: null, montant_tva_cents: null, montant_ttc_cents: 370000 },
    { montant_ht_cents: 1, montant_tva_cents: 99, montant_ttc_cents: 370000 },
    { montant_ht_cents: 5, montant_tva_cents: null, montant_ttc_cents: null },
    { montant_ht_cents: null, montant_tva_cents: null, montant_ttc_cents: null }
  ]) assert.ok(tient(montantsDuType('avis_impot', lu)), JSON.stringify(lu))
})

test('collage manuel : aucune ligne de 60 caractères ou plus, ni dans la migration ni dans son contrôle', () => {
  for (const [nom, t] of [['migration', sql], ['contrôle', controle]]) {
    const longues = t.split('\n').map((l, i) => [i + 1, l.length]).filter(([, n]) => n >= 60)
    assert.deepEqual(longues, [], nom)
  }
})

test('LE TEST QUI COMPTE : le contrôle vérifie les DEUX moitiés de la règle, validée — une règle affaiblie ne passe plus (review du correctif, constat C)', () => {
  const c = aplati(controle)
  assert.match(c, /conname = 'charges_impot_ck'/)
  assert.match(c, /bool_and\(v\)/, 'la contrainte est validée (convalidated)')
  // Les motifs du contrôle, recollés comme Postgres les concatène.
  const motifs = [...c.matchAll(/d like '([^']*)'(?: \|\| '([^']*)')?(?: \|\| '([^']*)')?/g)].map(m => m.slice(1).filter(Boolean).join(''))
  const passe = (def) => {
    const d = def.toLowerCase()
    const like = (m) => new RegExp('^' + m.split('%').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 's').test(d)
    return like('%avis_impot%') &&
      (like(motifs.find(m => m.startsWith('%not (montant_tva'))) || like(motifs.find(m => m.startsWith('%montant_tva')))) &&
      (like(motifs.find(m => m.startsWith('%not (montant_ht'))) || like(motifs.find(m => m.startsWith('%montant_ht'))))
  }
  // La définition que Postgres 16 rend pour la vraie contrainte (mesurée).
  const vraie = "CHECK (((type_document <> 'avis_impot'::text) OR ((NOT (montant_tva_cents IS DISTINCT FROM 0)) AND (NOT (montant_ht_cents IS DISTINCT FROM montant_ttc_cents)))))"
  assert.equal(passe(vraie), true)
  // La règle affaiblie de la review : TVA = 0 seulement, HT libre.
  const affaiblie = "CHECK (((type_document <> 'avis_impot'::text) OR ((montant_tva_cents = 0) AND (montant_ttc_cents >= 0))))"
  assert.equal(passe(affaiblie), false)
  assert.match(c, /hors = 0/)
  assert.doesNotMatch(c, /\b(insert|update|delete|alter|drop|create)\b/, 'le contrôle ne fait que lire')
})
