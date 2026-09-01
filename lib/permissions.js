// lib/permissions.js
// DOC : docs/kb/profils-et-droits.md (modif = MEME COMMIT)
//
// Miroir JS des fonctions SQL perm_level / in_scope / can_read / can_write.
//
// POURQUOI un miroir. La RLS ne protege que les acces DIRECTS a Supabase depuis
// le navigateur. Les endpoints serverless ecrivent en service key, qui la
// contourne : tout endpoint agissant AU NOM d'un utilisateur doit donc verifier
// les droits lui-meme. Ce module est cette verification.
//
// ⚠ La semantique doit rester STRICTEMENT alignee sur le SQL
// (migrations/2026-09-01-profils-et-droits-structures.sql). Toute divergence
// donnerait un endpoint plus permissif que la base — ou l'inverse, plus
// perturbant encore a diagnostiquer.
//
// Etape 1 : module non branche. Le cablage dans les endpoints est l'etape 3.

const DOMAINES = [
  'reservations', 'menages', 'prestataires', 'messages',
  'avis', 'reglages', 'facturation', 'equipe'
]

const NIVEAUX = ['none', 'read', 'write']

// Domaines que le titulaire ne peut pas deleguer en ECRITURE.
const NON_DELEGABLES = ['facturation', 'equipe']

// Presets de la page Equipe : un POINT DE DEPART qui remplit le formulaire,
// jamais un role fige en base. Rien dans le code ne doit tester « est-ce un
// proprietaire » — seuls les niveaux comptent.
const PRESETS = {
  employe: {
    property_scope: 'all',
    reservations: 'write', menages: 'write', prestataires: 'write', messages: 'write',
    avis: 'write', reglages: 'write', facturation: 'none', equipe: 'none',
    self_availability: 'none', self_view_reviews: true
  },
  proprietaire: {
    property_scope: 'selected',
    reservations: 'read', menages: 'read', prestataires: 'none', messages: 'read',
    avis: 'read', reglages: 'none', facturation: 'none', equipe: 'none',
    self_availability: 'none', self_view_reviews: true
  },
  prestataire: {
    property_scope: 'all',
    reservations: 'none', menages: 'none', prestataires: 'none', messages: 'none',
    avis: 'none', reglages: 'none', facturation: 'none', equipe: 'none',
    self_availability: 'write', self_view_reviews: true
  }
}

// ─── Niveau effectif ─────────────────────────────────────────────────────────
// `contexte` : { userId, accountUserId, profil, permissions }
//   userId        = l'utilisateur connecte (auth.uid())
//   accountUserId = le compte proprietaire de la donnee (user_id de la ligne)
//   profil        = ligne profiles du membre sur ce compte, ou null
//   permissions   = ligne profile_permissions correspondante, ou null
function niveauEffectif(contexte, domaine) {
  const { userId, accountUserId, profil, permissions } = contexte || {}
  if (!domaine || !DOMAINES.includes(domaine)) return 'none'

  // Le titulaire a tout, sans passer par un profil.
  if (userId && accountUserId && userId === accountUserId) return 'write'

  // Un profil inactif ou dont l'invitation n'est pas acceptee n'a aucun droit.
  if (!profil || !permissions) return 'none'
  // ⚠ `!== true`, pas `=== false` : le SQL exige `pr.active` VRAI. Un appelant
  // qui construirait le contexte avec un select partiel (sans la colonne active)
  // obtiendrait `undefined` — traite comme actif, donc PLUS PERMISSIF que la base.
  if (profil.active !== true) return 'none'
  if (!profil.accepted_at) return 'none'
  if (profil.member_user_id !== userId) return 'none'
  if (profil.account_user_id !== accountUserId) return 'none'

  const niveau = permissions[domaine]
  return NIVEAUX.includes(niveau) ? niveau : 'none'
}

// ─── Perimetre de biens ──────────────────────────────────────────────────────
// `bien` : { id } (UUID properties.id) et/ou { ref } (provider_property_id TEXT).
// Une donnee non rattachee a un bien est toujours dans le perimetre.
function dansPerimetre(contexte, bien) {
  const { userId, accountUserId, profil, permissions } = contexte || {}
  if (userId && accountUserId && userId === accountUserId) return true
  if (!bien || (bien.id == null && bien.ref == null)) return true
  if (!profil || !permissions) return false

  // Memes portes d'entree que niveauEffectif. Cette fonction est EXPORTEE et
  // utilisable seule : sans ces controles, un appelant qui chargerait le profil
  // du membre sur un AUTRE compte obtiendrait true.
  if (profil.active !== true) return false
  if (!profil.accepted_at) return false
  if (profil.member_user_id !== userId) return false
  if (profil.account_user_id !== accountUserId) return false

  if (permissions.property_scope === 'all') return true

  const ids  = (permissions.property_ids  || []).map(String)
  const refs = (permissions.property_refs || []).map(String)
  if (bien.id != null && ids.includes(String(bien.id))) return true
  // `ids` est aussi consulte pour une reference TEXTE : knowledge et messages
  // portent tantot le provider_property_id, tantot l'UUID properties.id. Ne
  // comparer qu'a `refs` rendrait invisibles des lignes legitimes (aligne sur
  // in_scope(uuid, text) cote SQL).
  if (bien.ref != null && (refs.includes(String(bien.ref)) || ids.includes(String(bien.ref)))) return true
  return false
}

// Perimetre sous forme de LISTE, pour les endpoints qui renvoient une COLLECTION
// (et n'ont donc pas un bien unique a soumettre a dansPerimetre).
//
// Retourne `null` quand il n'y a rien a filtrer (titulaire, ou perimetre 'all'),
// et sinon la liste des references acceptees. UUID et provider_property_id sont
// melanges a dessein : `messages.property_id` porte tantot l'un, tantot l'autre,
// exactement comme dans dansPerimetre.
//
// ⚠ Un profil absent/inactif ne donne PAS `null` mais une liste VIDE : sans ce
// distinguo, un membre revoque obtiendrait « aucun filtre » donc TOUT.
//
// ⚠ CE QUE LA LISTE NE DIT PAS : dansPerimetre considere qu'une donnee SANS bien
// est toujours dans le perimetre. Une liste consommee par un `.in(...)` nu
// exclurait au contraire les lignes a property_id NULL, donc plus strict que le
// SQL. C'est a l'appelant d'ajouter le cas NULL — api/messages.js le fait avec un
// `.or(property_id.is.null, ...)`.
function refsDuPerimetre(contexte) {
  const { userId, accountUserId, profil, permissions } = contexte || {}
  if (userId && accountUserId && userId === accountUserId) return null
  if (!profil || !permissions) return []
  if (profil.active !== true) return []
  if (!profil.accepted_at) return []
  if (profil.member_user_id !== userId) return []
  if (profil.account_user_id !== accountUserId) return []
  if (permissions.property_scope === 'all') return null
  const ids  = (permissions.property_ids  || []).map(String)
  const refs = (permissions.property_refs || []).map(String)
  return Array.from(new Set([...ids, ...refs]))
}

// Traduit un perimetre (refsDuPerimetre) en expression PostgREST `.or(...)`.
//
// Retourne null quand il n'y a rien a filtrer, et '' quand le perimetre est vide
// ou contient une reference au format refuse — dans les deux cas l'appelant doit
// echouer FERME (ne rien renvoyer), jamais elargir.
//
// Le cas NULL est inclus : une donnee sans bien est dans le perimetre (aligne sur
// dansPerimetre et sur in_scope cote SQL). Les valeurs viennent de
// profile_permissions, pas du client, mais elles sont interpolees dans
// l'expression : une virgule ou une parenthese y injecterait des filtres.
const REF_SQL_SURE = /^[A-Za-z0-9_-]{1,64}$/
function filtrePerimetreSql(refs, colonne = 'property_id') {
  if (refs == null) return null
  if (!Array.isArray(refs) || refs.length === 0) return ''
  if (!refs.every(r => REF_SQL_SURE.test(String(r)))) return ''
  return `${colonne}.is.null,${colonne}.in.(${refs.map(String).join(',')})`
}

function peutLire(contexte, domaine, bien) {
  const n = niveauEffectif(contexte, domaine)
  return (n === 'read' || n === 'write') && dansPerimetre(contexte, bien)
}

function peutEcrire(contexte, domaine, bien) {
  if (niveauEffectif(contexte, domaine) !== 'write') return false
  if (!dansPerimetre(contexte, bien)) return false
  // facturation / equipe : titulaire uniquement, quel que soit le niveau stocke.
  if (NON_DELEGABLES.includes(domaine)) {
    return !!(contexte && contexte.userId && contexte.userId === contexte.accountUserId)
  }
  return true
}

module.exports = {
  DOMAINES, NIVEAUX, NON_DELEGABLES, PRESETS,
  niveauEffectif, dansPerimetre, refsDuPerimetre, filtrePerimetreSql, peutLire, peutEcrire
}
