// tests/migration-rekeying.test.js
// LE RE-KEYING — phase 2.8 du plan de bascule.
//
// Ce que ce geste ne doit jamais faire :
//   - laisser le bien A MOITIE migre (provider d'un cote, tables enfants de
//     l'autre) : c'est l'etat le plus dangereux du chantier ;
//   - tourner pendant que l'automatisation est active : un cron agirait sur un
//     etat transitoire, enverrait un message ou poserait un code d'acces ;
//   - annoncer un succes sans dire combien de lignes ont VRAIMENT bouge.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { deplacerLeBien, auditRekeying, etatRekeying, raisonDeNePasDeplacer,
  PROVIDER_CIBLE } = require('../lib/migration-rekeying')

const EN_MIGRATION = {
  id: 'uuid-bulle', user_id: 'uuid-hote', name: 'La bulle', provider: 'beds24',
  provider_property_id: '209413', migration_target_property_id: 'chx-cible',
  automation_paused: true
}

// Faux client : `rpc` note les appels et rend ce qu'on lui donne.
function faux ({ compter = [], compterApres = null, rekey = [], erreur = null } = {}) {
  const appels = []
  let comptages = 0
  return {
    appels,
    api: {
      rpc: async (nom, params) => {
        appels.push({ nom, params })
        // L'erreur ne concerne QUE le deplacement : l'apercu, lui, doit avoir
        // reussi — sinon on ne teste pas ce qu'on croit.
        if (erreur && nom === 'rekey_property') return { data: null, error: { message: erreur } }
        if (nom === 'rekeying_compter') {
          comptages++
          // Le second comptage est celui d'APRES le deplacement.
          const jeu = (comptages > 1 && compterApres) ? compterApres : compter
          return { data: jeu, error: null }
        }
        return { data: rekey, error: null }
      }
    }
  }
}

const COMPTER = [
  { nom_table: 'bookings_snapshot', colonne: 'property_id', sous_source: 786, sous_cible: 0 },
  { nom_table: 'menages', colonne: 'property_id', sous_source: 98, sous_cible: 0 },
  { nom_table: 'messages', colonne: 'property_id', sous_source: 518, sous_cible: 0 }
]
// Apres un deplacement reussi, la source est VIDE. C'est ce recomptage qui
// attrape un cron de synchro ayant ecrit sous l'ancienne cle pendant le geste.
const COMPTER_APRES = COMPTER.map(t => ({ ...t, sous_source: 0, sous_cible: t.sous_source }))
const DEPLACEES = [
  { nom_table: 'bookings_snapshot', colonne: 'property_id', deplacees: 786 },
  { nom_table: 'menages', colonne: 'property_id', deplacees: 98 },
  { nom_table: 'messages', colonne: 'property_id', deplacees: 518 },
  { nom_table: 'properties', colonne: 'provider_property_id', deplacees: 1 }
]

// ─── Les refus ──────────────────────────────────────────────────────────────

test('LE TEST QUI COMPTE : l automatisation doit etre en PAUSE pour deplacer', async () => {
  // Une ligne peut etre lue sous son ancienne cle et ecrite sous la nouvelle :
  // un cron au milieu enverrait un message au voyageur ou poserait un code
  // d'acces sur un etat transitoire.
  const f = faux({ compter: COMPTER, compterApres: COMPTER_APRES, rekey: DEPLACEES })
  const r = await deplacerLeBien(f.api, { ...EN_MIGRATION, automation_paused: false }, { dryRun: false })
  assert.equal(r.ok, false)
  assert.equal(r.raison, 'automatisation_active')
  assert.ok(!f.appels.some(a => a.nom === 'rekey_property'), 'aucun deplacement lance')
})

test('une pause NON RENSEIGNEE est traitee comme active', async () => {
  // `automation_paused` absente du SELECT lirait `undefined` : une garde qui
  // juge sur une colonne non selectionnee est une garde ouverte.
  const { automation_paused, ...sansPause } = EN_MIGRATION
  const f = faux({ compter: COMPTER, compterApres: COMPTER_APRES, rekey: DEPLACEES })
  const r = await deplacerLeBien(f.api, sansPause, { dryRun: false })
  assert.equal(r.ok, false)
  assert.equal(r.raison, 'automatisation_active')
})

test('un bien qui n est pas en migration n a rien a deplacer', () => {
  const migre = { ...EN_MIGRATION, provider: 'channex', provider_property_id: 'chx-cible' }
  assert.equal(raisonDeNePasDeplacer(migre).raison, 'pas_en_migration')
})

// ─── L'apercu ───────────────────────────────────────────────────────────────

test('dry run par defaut : il compte, il ne deplace pas', async () => {
  const f = faux({ compter: COMPTER, compterApres: COMPTER_APRES, rekey: DEPLACEES })
  const r = await deplacerLeBien(f.api, EN_MIGRATION)
  assert.equal(r.dry_run, true)
  assert.equal(r.audit.lignes_a_deplacer, 1402)
  assert.deepEqual(f.appels.map(a => a.nom), ['rekeying_compter'], 'un seul comptage, aucun deplacement')
  assert.ok(!f.appels.some(a => a.nom === 'rekey_property'))
})

test('l apercu dit ce qui est deja sous la cible — ce qui rend le geste reprenable', async () => {
  const f = faux({ compter: [
    { nom_table: 'bookings_snapshot', colonne: 'property_id', sous_source: 0, sous_cible: 786 }
  ] })
  const r = await auditRekeying(f.api, EN_MIGRATION)
  assert.equal(r.lignes_a_deplacer, 0)
  assert.equal(r.lignes_deja_sous_la_cible, 786)
})

// ─── Le geste ───────────────────────────────────────────────────────────────

test('LE TEST QUI COMPTE : le deplacement passe par UNE fonction SQL, pas 18 UPDATE', async () => {
  const f = faux({ compter: COMPTER, compterApres: COMPTER_APRES, rekey: DEPLACEES })
  const r = await deplacerLeBien(f.api, EN_MIGRATION, { dryRun: false })
  assert.equal(r.ok, true)
  const appel = f.appels.find(a => a.nom === 'rekey_property')
  assert.ok(appel, 'un seul appel, transactionnel')
  assert.equal(appel.params.p_source, '209413')
  assert.equal(appel.params.p_cible, 'chx-cible')
  assert.equal(appel.params.p_provider, PROVIDER_CIBLE)
})

test('LE TEST QUI COMPTE : un ECART entre annonce et deplace est DIT', async () => {
  // La transaction est passee, mais le compte ne colle pas : des lignes ont pu
  // naitre entre l'apercu et le geste. On ne reprend pas l'automatisation sur un
  // « c'est bon » approximatif.
  const f = faux({ compter: COMPTER, rekey: [
    { nom_table: 'bookings_snapshot', deplacees: 780 },
    { nom_table: 'menages', deplacees: 98 },
    { nom_table: 'messages', deplacees: 518 },
    { nom_table: 'properties', deplacees: 1 }
  ] })
  const r = await deplacerLeBien(f.api, EN_MIGRATION, { dryRun: false })
  assert.equal(r.ok, true)
  assert.equal(r.conforme, false)
  assert.match(r.note, /ECART/)
})

test('un compte conforme le dit aussi, avec le total', async () => {
  const f = faux({ compter: COMPTER, compterApres: COMPTER_APRES, rekey: DEPLACEES })
  const r = await deplacerLeBien(f.api, EN_MIGRATION, { dryRun: false })
  assert.equal(r.conforme, true)
  assert.equal(r.deplacees, 1402)
  assert.ok(!/properties/.test(String(r.deplacees)), 'la ligne `properties` ne gonfle pas le total')
})

test('un echec de transaction affirme que RIEN n a bouge', async () => {
  // C'est le doute le plus couteux du jour J : il faut y repondre, pas le laisser.
  const f = faux({ compter: COMPTER, erreur: 'le bien porte chx-cible et non 209413' })
  const r = await deplacerLeBien(f.api, EN_MIGRATION, { dryRun: false })
  assert.equal(r.ok, false)
  assert.match(r.note, /AUCUNE ligne n'a bouge/)
})

// ─── L'etat ─────────────────────────────────────────────────────────────────

test('LE TEST QUI COMPTE : apres la bascule l etape dit FAIT, pas « sans objet »', () => {
  // « Sans objet » la sortait du decompte : le succes du geste le plus
  // irreversible du chantier n'etait alors confirme nulle part.
  const r = etatRekeying({ ...EN_MIGRATION, provider: 'channex', provider_property_id: 'chx-cible' })
  assert.equal(r.etat, 'fait')
  assert.match(r.message, /bascule est faite/)
})

test('sans propriete cible, l etape est sans objet', () => {
  const r = etatRekeying({ ...EN_MIGRATION, migration_target_property_id: null })
  assert.equal(r.etat, 'sans_objet')
})

test('LE TEST QUI COMPTE : l etat ne COMPTE pas — 42 count(*) par bien', () => {
  // `GET /api/migration` boucle sur tous les biens du compte, et c'est
  // l'endpoint qu'on rafraichit le plus le jour J.
  let appels = 0
  const espion = { rpc: async () => { appels++; return { data: [], error: null } } }
  const r = etatRekeying(EN_MIGRATION, espion)
  assert.equal(appels, 0, 'aucun comptage a l affichage')
  assert.equal(r.etat, 'a_faire')
})

// ─── Ce que la migration SQL garantit ───────────────────────────────────────

test('LE TEST QUI COMPTE : la fonction SQL est transactionnelle et reversible', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations/2026-09-10-rekeying.sql'), 'utf8')
  // Une fonction plpgsql EST une transaction : c'est ce qui interdit l'etat
  // « a moitie migre ».
  assert.ok(/language plpgsql/.test(sql))
  // Le bien passe dans la MEME fonction que ses tables enfants.
  assert.ok(/update public\.properties/.test(sql))
  // Le provider est un PARAMETRE : le rollback est le meme appel, inverse.
  assert.ok(/p_provider text/.test(sql))
  // La sauvegarde est prise dans la meme transaction.
  assert.ok(/insert into public\.rekeying_backup/.test(sql))
  // Et la fonction refuse si le bien ne porte pas la cle source annoncee.
  assert.ok(/deja migre \?/.test(sql))
})

test('les 17 tables a `property_id` sont toutes nommees dans la fonction SQL', () => {
  // La spec en annoncait 14 ; l'inventaire du schema en trouve 18, dont une
  // — `property_snapshots` — volontairement exclue (voir plus bas). Une table
  // oubliee, c'est un bien coupe d'une partie de son historique.
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations/2026-09-10-rekeying.sql'), 'utf8')
  const attendues = ['access_codes', 'agent_tasks', 'automation_incidents', 'booking_change_events',
    'bookings_snapshot', 'conversations', 'knowledge', 'menage_comments', 'menage_done',
    'menage_events', 'menages', 'message_templates', 'messages', 'property_cleaning_providers',
    'property_locks', 'property_status', 'sms_logs']
  const liste = sql.slice(sql.indexOf('create or replace function public.rekeying_tables()'), sql.indexOf('rekeying_tables_ref'))
  for (const t of attendues) {
    assert.ok(liste.includes(`'${t}'`), `${t} est dans la liste des tables a deplacer`)
  }
  assert.equal(attendues.length, 17)
  // ⚠ `property_snapshots` est VOLONTAIREMENT absente : son identite est
  // `unique (user_id, provider, property_id)`, et la deplacer sans toucher
  // `provider` aurait produit « beds24 + cle Channex », un couple qui ne decrit
  // rien. C'est un releve HISTORIQUE par provider.
  assert.ok(!liste.includes("'property_snapshots'"), 'la fiche brute ne se promeut pas')
  assert.ok(/RELEVE[\s\S]{0,40}HISTORIQUE par provider/.test(sql), 'et le pourquoi est ecrit')
})

test('les fonctions et la sauvegarde ne sont PAS exposees aux clients', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations/2026-09-10-rekeying.sql'), 'utf8')
  for (const cible of ['rekey_property', 'rekeying_compter', 'rekeying_backup']) {
    assert.ok(new RegExp(`revoke all on (function|table) public\\.${cible}`).test(sql),
      `${cible} est revoque pour anon/authenticated`)
  }
  assert.ok(/enable row level security/.test(sql), 'RLS actif sur la sauvegarde')
})

// ─── Les references qui ne s appellent pas `property_id` ────────────────────

test('LE TEST QUI COMPTE : les trois references nommees autrement sont deplacees', () => {
  // La premiere version disait « tout ce qui est cle en UUID ne bouge pas » et
  // citait `ota_reviews`. Faux : la table porte AUSSI `property_id_ref` (TEXT).
  // Mesure : 99 avis auraient perdu leur rattachement, /avis en aurait rendu
  // zero, et l'extrait de proprete aurait disparu des fiches prestataires.
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations/2026-09-10-rekeying.sql'), 'utf8')
  for (const [t, c] of [['ota_reviews', 'property_id_ref'],
    ['prestataire_periodes', 'property_id_ref'],
    ['airbnb_connect_sessions', 'provider_property_id']]) {
    assert.ok(sql.includes(`array['${t}', '${c}']`), `${t}.${c} est deplacee`)
  }
})

test('LE TEST QUI COMPTE : le tableau des tokens est deplace par REMPLACEMENT', () => {
  // `public_tokens.property_ids` est ce par quoi le planning menage reconnait
  // les biens d'une prestataire. L'oublier vide son planning et fait refuser
  // `markDone` — l'ecart E1/E2 de l'audit d'unification, reintroduit.
  // Et il faut REMPLACER l'element : reecrire la liste couperait la prestataire
  // de ses AUTRES logements.
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations/2026-09-10-rekeying.sql'), 'utf8')
  assert.ok(sql.includes("array['public_tokens', 'property_ids']"))
  assert.ok(/array_replace/.test(sql), 'remplacement de l element, pas reecriture de la liste')
})

test('les droits par bien selectionne ne sont PAS deplaces : un trigger les recalcule', () => {
  // `properties_sync_refs` recalcule `property_refs` depuis les UUID a chaque
  // changement de `provider_property_id` — donc dans cette transaction meme.
  // Les deplacer ferait double emploi, et ecraserait un calcul par une copie.
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations/2026-09-10-rekeying.sql'), 'utf8')
  assert.ok(!/array\['profile_permissions'/.test(sql), 'property_refs n est pas dans les listes')
  assert.ok(/properties_sync_refs/.test(sql), 'et le pourquoi est ecrit')
})

// ─── Le cloisonnement, sur une fonction qui contourne RLS ───────────────────

test('LE TEST QUI COMPTE : la tolerance « sans compte » est BORNEE a deux tables', () => {
  // Mon correctif pour recuperer les 50 codes d'acces de La bulle avait etendu
  // `or user_id is null` a TOUTES les tables — rouvrant la fuite que le filtre
  // ferme : `provider_property_id` n'a aucune unicite globale, et les lignes
  // sans compte d'un AUTRE hote portant le meme identifiant auraient ete
  // absorbees. Mesure : seules `access_codes` (96/119) et
  // `automation_incidents` (11/28) ont des lignes sans compte.
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations/2026-09-10-rekeying.sql'), 'utf8')
  const liste = sql.slice(sql.indexOf('rekeying_tables_sans_compte()'), sql.indexOf('rekeying_clause_compte'))
  assert.ok(/'access_codes', 'automation_incidents'/.test(liste), 'la liste est explicite')
  assert.ok(!/'bookings_snapshot'/.test(liste), 'et ne contient pas les tables a compte plein')
  // Le predicat est CALCULE par table, jamais ecrit en dur.
  assert.ok(!/or user_id is null\)', t\)/.test(sql), 'plus de tolerance en dur dans les UPDATE')
  const clauses = sql.match(/rekeying_clause_compte\(/g) || []
  assert.ok(clauses.length >= 9, `le predicat est appele partout (vu ${clauses.length})`)
})

test('LE TEST QUI COMPTE : sans compte proprietaire, le deplacement REFUSE', () => {
  // Si `v_user` etait nul, `user_id = $3` n'aurait jamais ete vrai : sur les
  // tables tolerantes, le deplacement n'aurait retenu QUE les lignes sans
  // compte — tous comptes confondus — en laissant derriere celles possedees.
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations/2026-09-10-rekeying.sql'), 'utf8')
  assert.ok(/n''a pas de compte proprietaire/.test(sql))
  assert.ok(/rekeying_compter : compte requis/.test(sql), 'le comptage aussi')
})

test('les lignes sans compte sont COMPTEES A PART, pas fondues dans le total', async () => {
  // Le commentaire promettait « le comptage la rend a part » — il ne le faisait
  // pas, et l'operateur ne pouvait pas savoir combien de lignes du total
  // etaient dans ce cas.
  const f = faux({ compter: [
    { nom_table: 'access_codes', colonne: 'property_id', sous_source: 65, sous_cible: 0, sans_compte: 50 }
  ] })
  const r = await auditRekeying(f.api, EN_MIGRATION)
  assert.equal(r.lignes_a_deplacer, 65)
  assert.equal(r.lignes_sans_compte, 50)
  assert.equal(r.par_table[0].sans_compte, 50)
})

test('le deplacement porte un filtre de compte sur chaque ecriture', () => {
  // La fonction est `security definer` : elle contourne RLS. Sans filtre de
  // compte, deux biens partageant un meme `provider_property_id` — qui n a
  // aucune unicite globale, et cette base porte deja des doublons de
  // `properties` — verraient les lignes de l un absorbees par la cible de l autre.
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations/2026-09-10-rekeying.sql'), 'utf8')
  const updates = sql.match(/update public\.%I[\s\S]{0,260}?using/g) || []
  assert.ok(updates.length >= 3, 'les trois formes de deplacement sont presentes')
  for (const u of updates) {
    assert.ok(/rekeying_clause_compte\(/.test(u),
      'chaque UPDATE passe par le predicat de compte : ' + u.slice(0, 90))
  }
})

test('l audit passe le compte a la fonction SQL', async () => {
  const f = faux({ compter: COMPTER })
  await auditRekeying(f.api, EN_MIGRATION)
  assert.equal(f.appels[0].params.p_user, 'uuid-hote')
})

// ─── Le recomptage d apres, qui attrape ce que la pause ne couvre pas ──────

test('LE TEST QUI COMPTE : des lignes RESTEES sous l ancienne cle rendent le geste NON conforme', async () => {
  // `automation_paused` n arrete pas les writers de synchro : le cron de
  // 5 minutes qui ecrit `bookings_snapshot` et `menages` peut avoir lu la cle
  // source avant la transaction et insere apres. Comparer au seul audit d AVANT
  // ne l aurait jamais vu.
  const resteQuelqueChose = COMPTER.map(t => ({ ...t, sous_source: t.nom_table === 'menages' ? 2 : 0 }))
  const f = faux({ compter: COMPTER, compterApres: resteQuelqueChose, rekey: DEPLACEES })
  const r = await deplacerLeBien(f.api, EN_MIGRATION, { dryRun: false })
  assert.equal(r.ok, true, 'la transaction est passee')
  assert.equal(r.conforme, false)
  assert.equal(r.restant_sous_la_source, 2)
  assert.match(r.note, /automation_paused` ne l'arrete pas/)
})

test('LE TEST QUI COMPTE : un propId porte par DEUX biens fait refuser le deplacement', () => {
  // C'est la fuite residuelle des deux tables tolerantes : la moitie
  // « user_id is null » du predicat n a aucun filtre de compte. Borner la
  // tolerance reduisait la surface ; ce refus ferme le cas.
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations/2026-09-10-rekeying.sql'), 'utf8')
  assert.ok(/porte par plusieurs biens — deplacement refuse/.test(sql))
  assert.ok(/select count\(\*\) from public\.properties[\s\S]{0,80}provider_property_id = p_source\) > 1/.test(sql))
})

test('les lignes sans compte NON deplacables sont annoncees a part', async () => {
  // Compter partout laissait annoncer « dont N deplacees » pour des lignes qui
  // ne bougeraient pas — abandonnees sous une cle morte, avec `conforme: true`.
  const f = faux({ compter: [
    { nom_table: 'access_codes', colonne: 'property_id', sous_source: 65, sous_cible: 0, sans_compte: 50 },
    { nom_table: 'menages', colonne: 'property_id', sous_source: 98, sous_cible: 0, sans_compte: 3 }
  ] })
  const r = await auditRekeying(f.api, EN_MIGRATION)
  assert.equal(r.lignes_sans_compte, 50, 'seules les tables tolerantes')
  assert.equal(r.sans_compte_non_deplacees, 3, 'et les autres sont dites a part')
})
