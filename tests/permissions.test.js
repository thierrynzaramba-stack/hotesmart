// tests/permissions.test.js
// Miroir JS des fonctions SQL de droits. La RLS ne protege pas les endpoints
// serverless (service key) : ce module est leur seule defense.

const test = require('node:test')
const assert = require('node:assert')
const { DOMAINES, NIVEAUX, PRESETS, niveauEffectif, dansPerimetre, peutLire, peutEcrire } = require('../lib/permissions')

const OWNER = 'owner-uuid'
const MEMBRE = 'membre-uuid'

const ctx = (o = {}) => ({
  userId: MEMBRE,
  accountUserId: OWNER,
  profil: {
    member_user_id: MEMBRE, account_user_id: OWNER,
    active: true, accepted_at: '2026-09-01T00:00:00Z', ...(o.profil || {})
  },
  permissions: { property_scope: 'all', property_ids: [], property_refs: [], ...(o.permissions || {}) },
  ...(o.racine || {})
})

// ─── Le titulaire ────────────────────────────────────────────────────────────

test('le titulaire a tout, sans profil ni permissions', () => {
  const t = { userId: OWNER, accountUserId: OWNER, profil: null, permissions: null }
  for (const d of DOMAINES) {
    assert.strictEqual(niveauEffectif(t, d), 'write', d)
    assert.ok(peutEcrire(t, d), d)
  }
  assert.ok(dansPerimetre(t, { id: 'nimporte-quel-bien' }))
})

// ─── Portes d'entree : actif, accepte, bon compte ───────────────────────────

test('profil inactif -> aucun droit', () => {
  const c = ctx({ profil: { active: false }, permissions: { menages: 'write' } })
  assert.strictEqual(niveauEffectif(c, 'menages'), 'none')
  assert.ok(!peutLire(c, 'menages'))
})

test('invitation non acceptee -> aucun droit', () => {
  const c = ctx({ profil: { accepted_at: null }, permissions: { menages: 'write' } })
  assert.strictEqual(niveauEffectif(c, 'menages'), 'none')
})

test('profil d\'un AUTRE compte -> aucun droit (isolation)', () => {
  const c = ctx({ profil: { account_user_id: 'un-autre-compte' }, permissions: { menages: 'write' } })
  assert.strictEqual(niveauEffectif(c, 'menages'), 'none')
})

test('profil d\'un AUTRE membre -> aucun droit', () => {
  const c = ctx({ profil: { member_user_id: 'quelqu-un-dautre' }, permissions: { menages: 'write' } })
  assert.strictEqual(niveauEffectif(c, 'menages'), 'none')
})

test('aucun profil sur ce compte -> aucun droit', () => {
  const c = { userId: MEMBRE, accountUserId: OWNER, profil: null, permissions: null }
  for (const d of DOMAINES) assert.strictEqual(niveauEffectif(c, d), 'none', d)
})

// ─── Niveaux ─────────────────────────────────────────────────────────────────

test('read permet de lire, jamais d\'ecrire', () => {
  const c = ctx({ permissions: { menages: 'read' } })
  assert.ok(peutLire(c, 'menages'))
  assert.ok(!peutEcrire(c, 'menages'))
})

test('write permet les deux', () => {
  const c = ctx({ permissions: { menages: 'write' } })
  assert.ok(peutLire(c, 'menages'))
  assert.ok(peutEcrire(c, 'menages'))
})

test('none ne permet rien', () => {
  const c = ctx({ permissions: { menages: 'none' } })
  assert.ok(!peutLire(c, 'menages'))
  assert.ok(!peutEcrire(c, 'menages'))
})

test('un domaine absent des permissions vaut none', () => {
  const c = ctx({ permissions: {} })
  assert.strictEqual(niveauEffectif(c, 'avis'), 'none')
})

test('un domaine inconnu vaut none (pas d\'ouverture par faute de frappe)', () => {
  const c = ctx({ permissions: { menages: 'write', menagee: 'write' } })
  assert.strictEqual(niveauEffectif(c, 'menagee'), 'none')
  assert.strictEqual(niveauEffectif(c, ''), 'none')
  assert.strictEqual(niveauEffectif(c, null), 'none')
})

test('un niveau invalide en base vaut none', () => {
  const c = ctx({ permissions: { menages: 'admin' } })
  assert.strictEqual(niveauEffectif(c, 'menages'), 'none')
})

// ─── facturation et equipe : jamais delegables en ecriture ──────────────────

test('facturation et equipe : write stocke ne suffit pas pour un membre', () => {
  const c = ctx({ permissions: { facturation: 'write', equipe: 'write' } })
  assert.strictEqual(niveauEffectif(c, 'facturation'), 'write', 'le niveau brut est bien write')
  assert.ok(!peutEcrire(c, 'facturation'), 'mais l\'ecriture est refusee a un membre')
  assert.ok(!peutEcrire(c, 'equipe'))
  assert.ok(peutLire(c, 'facturation'), 'la lecture reste possible')
})

test('facturation et equipe : le titulaire ecrit', () => {
  const t = { userId: OWNER, accountUserId: OWNER, profil: null, permissions: null }
  assert.ok(peutEcrire(t, 'facturation'))
  assert.ok(peutEcrire(t, 'equipe'))
})

// ─── Perimetre de biens — LE PONT TEXT/UUID ─────────────────────────────────

test('scope all : tous les biens', () => {
  const c = ctx({ permissions: { property_scope: 'all', menages: 'write' } })
  assert.ok(dansPerimetre(c, { id: 'bien-a' }))
  assert.ok(dansPerimetre(c, { ref: '169567' }))
})

test('scope selected : le bien est reconnu par son UUID', () => {
  const c = ctx({ permissions: { property_scope: 'selected', property_ids: ['bien-a'], property_refs: ['169567'] } })
  assert.ok(dansPerimetre(c, { id: 'bien-a' }))
  assert.ok(!dansPerimetre(c, { id: 'bien-b' }))
})

test('scope selected : le bien est reconnu par son identifiant TEXT provider', () => {
  // Le cas des 17 tables enfants, qui ne portent que le provider_property_id.
  const c = ctx({ permissions: { property_scope: 'selected', property_ids: ['bien-a'], property_refs: ['169567'] } })
  assert.ok(dansPerimetre(c, { ref: '169567' }))
  assert.ok(!dansPerimetre(c, { ref: '209413' }))
})

test('scope selected : une donnee sans bien reste accessible', () => {
  const c = ctx({ permissions: { property_scope: 'selected', property_ids: ['bien-a'] } })
  assert.ok(dansPerimetre(c, null))
  assert.ok(dansPerimetre(c, {}))
  assert.ok(dansPerimetre(c, { id: null, ref: null }))
})

test('perimetre et niveau se combinent : hors perimetre = rien', () => {
  const c = ctx({ permissions: { property_scope: 'selected', property_ids: ['bien-a'], property_refs: ['169567'], menages: 'write' } })
  assert.ok(peutLire(c, 'menages', { ref: '169567' }))
  assert.ok(peutEcrire(c, 'menages', { ref: '169567' }))
  assert.ok(!peutLire(c, 'menages', { ref: '209413' }), 'bon droit, mauvais bien')
  assert.ok(!peutEcrire(c, 'menages', { ref: '209413' }))
})

test('identifiants compares en chaine (un propId numerique reste egal a lui-meme)', () => {
  const c = ctx({ permissions: { property_scope: 'selected', property_refs: ['169567'] } })
  assert.ok(dansPerimetre(c, { ref: 169567 }))
})

// ─── Presets ─────────────────────────────────────────────────────────────────

test('presets : structure valide et niveaux legaux', () => {
  for (const [nom, p] of Object.entries(PRESETS)) {
    for (const d of DOMAINES) {
      assert.ok(NIVEAUX.includes(p[d]), `${nom}.${d} = ${p[d]}`)
    }
    assert.ok(NIVEAUX.includes(p.self_availability), `${nom}.self_availability`)
    assert.ok(['all', 'selected'].includes(p.property_scope), `${nom}.property_scope`)
  }
})

test('preset employe : tout sauf facturation et equipe', () => {
  const p = PRESETS.employe
  assert.strictEqual(p.facturation, 'none')
  assert.strictEqual(p.equipe, 'none')
  assert.strictEqual(p.menages, 'write')
})

test('preset proprietaire : lecture seule, biens selectionnes', () => {
  const p = PRESETS.proprietaire
  assert.strictEqual(p.property_scope, 'selected')
  for (const d of DOMAINES) assert.notStrictEqual(p[d], 'write', d)
})

test('preset prestataire : aucun domaine dashboard, gere ses disponibilites', () => {
  const p = PRESETS.prestataire
  for (const d of DOMAINES) assert.strictEqual(p[d], 'none', d)
  assert.strictEqual(p.self_availability, 'write')
  assert.strictEqual(p.self_view_reviews, true)
})

test('un preste n\'ouvre aucun acces par lui-meme : il faut un profil actif', () => {
  // Applique le preset employe a un profil non accepte : toujours rien.
  const c = ctx({ profil: { accepted_at: null }, permissions: { ...PRESETS.employe } })
  assert.ok(!peutLire(c, 'menages'))
})

// ─── Alignement STRICT sur le SQL (retours de revue) ────────────────────────

test('active absent du contexte -> aucun droit (le SQL exige active VRAI)', () => {
  // Un select partiel qui oublie la colonne `active` donnerait `undefined` :
  // le traiter comme actif rendrait l'endpoint PLUS PERMISSIF que la base.
  const c = ctx({ profil: { active: undefined }, permissions: { menages: 'write' } })
  assert.strictEqual(niveauEffectif(c, 'menages'), 'none')
  assert.ok(!dansPerimetre(c, { ref: '169567' }))
})

test('dansPerimetre seule : un profil d\'un AUTRE compte ne passe pas', () => {
  // La fonction est exportee et utilisable hors peutLire/peutEcrire.
  const c = ctx({
    profil: { account_user_id: 'un-autre-compte' },
    permissions: { property_scope: 'all' }
  })
  assert.ok(!dansPerimetre(c, { id: 'bien-a' }), 'sans ce controle, scope=all suffirait')
})

test('dansPerimetre seule : un profil d\'un AUTRE membre ne passe pas', () => {
  const c = ctx({ profil: { member_user_id: 'quelqu-un-dautre' }, permissions: { property_scope: 'all' } })
  assert.ok(!dansPerimetre(c, { id: 'bien-a' }))
})

test('dansPerimetre seule : profil inactif ou non accepte ne passe pas', () => {
  assert.ok(!dansPerimetre(ctx({ profil: { active: false }, permissions: { property_scope: 'all' } }), { id: 'b' }))
  assert.ok(!dansPerimetre(ctx({ profil: { accepted_at: null }, permissions: { property_scope: 'all' } }), { id: 'b' }))
})

test('COLONNES MIXTES : une reference TEXTE qui est en fait un UUID est reconnue', () => {
  // knowledge et messages portent tantot le provider_property_id, tantot l'UUID
  // properties.id. Ne comparer qu'a property_refs masquerait des lignes valides.
  const c = ctx({ permissions: {
    property_scope: 'selected',
    property_ids: ['49b2d1f6-0000-0000-0000-000000000000'],
    property_refs: ['169567']
  } })
  assert.ok(dansPerimetre(c, { ref: '169567' }), 'reference provider')
  assert.ok(dansPerimetre(c, { ref: '49b2d1f6-0000-0000-0000-000000000000' }), 'meme bien, saisi en UUID')
  assert.ok(!dansPerimetre(c, { ref: 'un-autre-uuid' }))
})
