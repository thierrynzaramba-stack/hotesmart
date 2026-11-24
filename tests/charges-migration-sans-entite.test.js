// tests/charges-migration-sans-entite.test.js — la migration du lot 5 bis
// (2026-11-24-charges-sans-entite ; spec §14.25.2 à §14.25.4).
//
// ⚠ CE TEST LIT LE TEXTE DU SQL. Ce que la base FAIT de ce texte se prouve sur
// un vrai Postgres : scripts/eprouver-charges-sans-entite.sh (44 gestes, dont
// les deux courses validation / rattachement).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const lire = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8')
const SQL = lire('migrations', '2026-11-24-charges-sans-entite.sql')
const CONTROLE = lire('migrations', '2026-11-24-controle-charges-sans-entite.sql')
const sansCommentaires = (s) => s.split('\n').map(l => l.replace(/--.*$/, '')).join('\n')
const CODE = sansCommentaires(SQL)
// Le corps d'une fonction : de son nom au `$$;` qui la ferme.
const corps = (nom) => {
  const i = CODE.indexOf(`public.${nom}(`)
  assert.ok(i >= 0, nom)
  return CODE.slice(i, CODE.indexOf('$$;', CODE.indexOf('$$', i) + 2))
}

test('LE TEST QUI COMPTE : la contrainte « validée ⇒ entité » est retirée, et AUCUN check ne la remplace (la suppression d\'un logement doit passer)', () => {
  assert.match(CODE, /alter table public\.charges\s+drop constraint if exists\s+charges_validee_entite_ck;/)
  assert.doesNotMatch(CODE, /add constraint/i)
  assert.doesNotMatch(CODE, /\bcheck\s*\(/i)
})

test('LE TEST QUI COMPTE : la garde prend le VERROU DU COMPTE avant de lire le lien du logement — sinon la course validation / rattachement passe', () => {
  const g = corps('charges_sans_entite_garde')
  const verrou = g.indexOf('charges_verrou_compte(')
  const lien = g.indexOf('from public.biens_entites')
  assert.ok(verrou > 0 && lien > verrou, 'verrou, PUIS lecture du lien')
  assert.match(g, /errcode = '23514'/)
  // Elle ne porte que sur une facture VALIDÉE sans entité.
  assert.match(g, /new\.statut <> 'validee'\s+or new\.entite_juridique_id is not null\s+then\s+return new;/)
  // Sans logement : seul ce qu'un writer pose est refusé (la suppression du
  // logement, `on delete set null`, reste permise).
  assert.match(g, /tg_op = 'INSERT'\s+or old\.statut <> 'validee'\s+or old\.entite_juridique_id is not null/)
  // Review 1, M3 : un writer ne peut pas lui RETIRER son logement — seule la
  // suppression du logement (sa ligne n'est alors plus visible) y mène.
  assert.match(g, /or exists \(\s+select 1 from public\.properties p\s+where p\.id = old\.bien_id\)/)
  assert.match(CODE, /create trigger charges_sans_entite_trg\s+before insert or update on public\.charges/)
})

test('LE TEST QUI COMPTE : un rattachement déplace les factures SANS entité du logement — LIGNES, PUIS verrou, puis déplacement ; celles qui ont une entité ne bougent pas', () => {
  const f = corps('biens_entites_factures_suivent')
  // Review 1, M1 : l'ordre de toute écriture sur `charges` (sa ligne, puis le
  // verrou du compte). L'inverse interbloque.
  const lignes = f.search(/order by c\.id\s+for update;/)
  const verrou = f.indexOf('charges_verrou_compte(')
  const maj = f.indexOf('update public.charges')
  assert.ok(lignes > 0 && verrou > lignes && maj > verrou, 'for update, PUIS verrou, PUIS update')
  assert.match(f, /set entite_juridique_id = new\.entite_id/)
  assert.match(f, /c\.user_id = new\.user_id/)
  assert.match(f, /c\.bien_id = new\.property_uuid/)
  assert.match(f, /c\.entite_juridique_id is null/)
  assert.doesNotMatch(f, /statut/, 'tous les statuts suivent')
  assert.match(CODE, /create trigger biens_entites_factures_trg\s+after insert or update\s+on public\.biens_entites/)
  // Le détachement (delete) ne touche rien.
  assert.doesNotMatch(CODE, /after insert or update or delete\s+on public\.biens_entites/)
})

test('le rattrapage ne touche que les logements d\'une entité ACTIVE (une entité archivée garde le rappel du lot 5)', () => {
  const i = CODE.indexOf('update public.charges c\n  set entite_juridique_id = be.entite_id')
  assert.ok(i > 0)
  const r = CODE.slice(i, CODE.indexOf(';', i))
  assert.match(r, /e\.archivee_le is null/)
  assert.match(r, /be\.user_id = c\.user_id/)
  assert.match(r, /c\.entite_juridique_id is null/)
})

test('LE TEST QUI COMPTE : les trois lectures du résumé lisent p_entite NULL comme « sans entité » — un LOGEMENT qui n\'en a pas (Thierry, 25 nov. 2026)', () => {
  for (const nom of ['charges_totaux', 'charges_exercices_bornes', 'charges_detail_mois']) {
    const f = corps(nom)
    assert.match(f, /p_entite is not null\s+and [rc]\.entite_juridique_id = p_entite/, nom)
    assert.match(f, /p_entite is null\s+and [rc]\.entite_juridique_id is null\s+and [rc]\.bien_id is not null\s+and not exists \(\s+select 1\s+from public\.biens_entites be\s+where be\.property_uuid\s+= [rc]\.bien_id\)/, `${nom} : pas une charge générale, pas un logement rattaché`)
    assert.doesNotMatch(f, /\(p_entite is null\s+or/, `${nom} : l'ancien « toutes les entités » est abandonné`)
    assert.doesNotMatch(f, /is not distinct from p_entite/, `${nom} : NULL n'est pas « toute facture sans entité »`)
    assert.match(f, /user_id = p_user/, `${nom} : toujours le compte`)
  }
  // Mêmes signatures : un `create or replace`, aucun `drop function`.
  assert.doesNotMatch(CODE, /drop function/i)
})

test('les fonctions de déclencheur ne s\'appellent pas à la main : droits retirés', () => {
  for (const nom of ['charges_sans_entite_garde', 'biens_entites_factures_suivent']) {
    assert.match(CODE, new RegExp(`revoke execute on function\\s+public\\.${nom}\\(\\)\\s+from public, anon, authenticated;`))
    assert.match(corps(nom), /security definer\s+set search_path = public/)
  }
})

test('collage manuel : toutes les lignes sous 60 caractères ; le contrôle a ses cinq lignes', () => {
  for (const [i, l] of SQL.split('\n').entries()) assert.ok(l.length < 60, `ligne ${i + 1} : ${l.length}`)
  for (const [i, l] of CONTROLE.split('\n').entries()) assert.ok(l.length < 60, `contrôle, ligne ${i + 1} : ${l.length}`)
  assert.equal((CONTROLE.match(/^select '\d /gm) || []).length, 5)
  assert.match(CONTROLE, /charges_validee_entite_ck/)
  assert.match(CONTROLE, /charges_sans_entite_trg/)
  assert.match(CONTROLE, /biens_entites_factures_trg/)
})

test('l\'épreuve sur un vrai Postgres joue la VRAIE chaîne, cette migration deux fois, et les deux courses', () => {
  const e = lire('scripts', 'eprouver-charges-sans-entite.sh')
  assert.match(e, /2026-11-24-charges-sans-entite\.sql/)
  assert.match(e, /2026-11-24-controle-charges-sans-entite\.sql/)
  for (const m of ['2026-11-09-compte-de-charges', '2026-11-13-charges-periode', '2026-11-19-charges-exercice-mois', '2026-11-23-charges-adresses-email']) assert.ok(e.includes(m), m)
  assert.match(e, /course 1/)
  assert.match(e, /course 2/)
  assert.match(e, /n'est pas rejouable/)
})
