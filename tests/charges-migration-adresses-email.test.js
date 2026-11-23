// tests/charges-migration-adresses-email.test.js — lot 5 (§14.24) : les
// adresses de factures par entité et par logement.
//
// ⚠ CE TEST LIT LE SQL, IL NE L'EXÉCUTE PAS. La migration a été jouée sur un
// Postgres 16 local par scripts/eprouver-adresses-factures.sh : 31 gestes,
// 0 écart, et le contrôle rend cinq false AVANT la migration, cinq true après.
// Ce fichier garde ce que la review ne relira pas à chaque lot.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const lire = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8')
const sql = lire('migrations', '2026-11-23-charges-adresses-email.sql')
const controle = lire('migrations', '2026-11-23-controle-charges-adresses-email.sql')
const code = (t) => t.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')

test('la table des adresses : RLS activée, AUCUNE policy, rien pour anon ni authenticated', () => {
  assert.match(code(sql), /alter table public\.charges_adresses_email\s+enable row level security/)
  assert.match(code(sql), /revoke all on public\.charges_adresses_email\s+from anon, authenticated;/)
  assert.doesNotMatch(code(sql), /create policy|grant /i)
  assert.doesNotMatch(code(sql), /security definer/i, 'aucune fonction ne passe par-dessus la RLS')
})

test('⚠ exactement UNE cible, et du MÊME compte : entité par clé composée, logement par déclencheur', () => {
  const c = code(sql).replace(/\s+/g, ' ')
  assert.match(c, /constraint cae_cible_ck check \( \(entite_id is null\) <> \(property_uuid is null\)\)/)
  assert.match(c, /foreign key \(entite_id, user_id\) references public\.entites_juridiques \(id, user_id\)/)
  assert.match(c, /create trigger cae_bien_meme_compte_trg before insert or update on public\.charges_adresses_email/)
  assert.match(c, /where p\.id = new\.property_uuid and p\.user_id = new\.user_id/)
  // Au plus une adresse vivante par entité et par logement.
  assert.match(c, /create unique index if not exists cae_entite_uidx on public\.charges_adresses_email \(entite_id\) where entite_id is not null/)
  assert.match(c, /create unique index if not exists cae_bien_uidx on public\.charges_adresses_email \(property_uuid\) where property_uuid is not null/)
})

test('⚠ la forme de l\'adresse : un point, que n\'a jamais une adresse de réponse d\'un voyageur', () => {
  const m = /locale ~\s+'([^']+)'/.exec(sql)
  assert.ok(m, 'le motif est dans la migration')
  const motif = new RegExp(m[1])
  for (const bonne of ['la-bulle.k2j9x7q4', 'coeur-de-vie-23.w4n8c1rd', 'x.00000000']) assert.match(bonne, motif, bonne)
  for (const mauvaise of ['La-bulle.k2j9x7q4', 'la-bulle-k2j9x7q4', 'la-bulle.k2j9x7q', '-bulle.k2j9x7q4', 'la--bulle.k2j9x7q4', 'la-bulle.k2j9x7q4x']) {
    assert.doesNotMatch(mauvaise, motif, mauvaise)
  }
  // Une adresse de réponse : identifiant compact, tiret, signature. Jamais de point.
  const { adresseDeReponse } = require('../lib/jeton-reponse')
  const ancien = process.env.REPLY_TOKEN_SECRET
  process.env.REPLY_TOKEN_SECRET = 'secret-de-test-pour-la-forme-seulement'
  try {
    const r = adresseDeReponse('2c6b6c1e-7f5e-4f7e-9d7a-0b9f4b2a9e11')
    assert.ok(r, 'une adresse de réponse est fabriquée')
    assert.doesNotMatch(r.split('@')[0], motif)
    assert.ok(!r.split('@')[0].includes('.'))
  } finally {
    if (ancien === undefined) delete process.env.REPLY_TOKEN_SECRET; else process.env.REPLY_TOKEN_SECRET = ancien
  }
})

test('⚠ l\'ancienne table n\'est supprimée que VIDE', () => {
  const c = code(sql).replace(/\s+/g, ' ')
  assert.match(c, /if exists \( select 1 from public\.charges_adresses\) then raise exception/)
  const iRefus = c.indexOf('raise exception \'charges_adresses contient une ligne\'')
  const iDrop = c.indexOf('drop table public.charges_adresses;')
  assert.ok(iRefus > 0 && iDrop > iRefus, 'le refus vient avant la suppression')
})

test('le sujet et le texte sont bornés en base', () => {
  const c = code(sql).replace(/\s+/g, ' ')
  assert.match(c, /check \(char_length\(email_sujet\) <= 300\)/)
  assert.match(c, /check \(char_length\(email_texte\) <= 2000\)/)
})

test('à coller à la main : aucune ligne de 60 caractères ou plus, et le contrôle a ses cinq lignes', () => {
  for (const [nom, t] of [['migration', sql], ['contrôle', controle]]) {
    const longues = t.split('\n').map((l, i) => [i + 1, l.length]).filter(([, n]) => n >= 60)
    assert.deepEqual(longues, [], nom)
  }
  assert.equal((controle.match(/^select '\d /gm) || []).length, 5)
})
