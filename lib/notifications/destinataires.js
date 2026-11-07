// lib/notifications/destinataires.js — QUI REÇOIT UN ÉVÉNEMENT D'UN COMPTE.
// Spec : docs/specs/spec-pwa-lot2-notifications.md §5 et §16.2 · KB : docs/kb/pwa.md §10
//
// Le titulaire, et les membres qui ont le domaine de l'événement sur ce bien.
// Les droits sont relus À CHAQUE ENVOI : un membre qui perd un domaine ne reçoit
// plus rien de ce domaine dès l'envoi suivant.
//
// ⚠ LA MÊME RÈGLE QUE LES ENDPOINTS : `niveauEffectif` et `dansPerimetre`
// (lib/permissions.js), miroir des fonctions SQL. Aucun contrôle n'est réécrit
// ici : profil actif, invitation acceptée, membre égal à l'abonné, domaine, bien.
//
// ⚠ LES ACCÈS PAR LIEN (prestataires) NE REÇOIVENT JAMAIS RIEN PAR CE CANAL : ils
// n'ont pas de session, donc pas d'appareil abonné ni de réglages ; leurs
// notifications viendront avec l'appli prestataire (lot 3).
//
// ⚠ LE TITULAIRE SE RECONNAÎT À `is_owner` (docs/kb/alertes.md, « Qui est
// joignable ») — jamais à un `member_user_id` nul, qui désigne un accès par lien.
const catalogue = require('./catalogue')
const { niveauEffectif, dansPerimetre } = require('../permissions')

function client () {
  return require('../cron-shared').supabase
}

const RANG = { none: 0, read: 1, write: 2 }

/**
 * @param {object} p
 * @param {string} p.compte  l'utilisateur titulaire du compte (account_user_id)
 * @param {string} p.code    code du catalogue
 * @param {object} [p.bien]  { id: UUID properties.id } et/ou { ref: provider_property_id }
 * @returns {{ ok: true, personnes: Array<{ userId, email, telephone, titulaire }> } | { ok: false, motif }}
 */
async function destinataires ({ compte, code, bien = null, db = client() }) {
  const e = catalogue.evenement(code)
  if (!e) return { ok: false, motif: 'evenement_inconnu' }
  if (!compte) return { ok: false, motif: 'compte_absent' }

  // Une poignée de profils par compte : aucune troncature possible à 1 000
  // lignes ici (le plafond du dépôt vise les tables qui grossissent avec le temps).
  const { data: profils, error: e1 } = await db.from('profiles')
    .select('id, account_user_id, member_user_id, is_owner, active, accepted_at, access_mode, email, phone')
    .eq('account_user_id', compte)
    .eq('access_mode', 'compte')
  // ⚠ Une panne de lecture n'est pas « personne à prévenir » : elle se dit.
  if (e1) return { ok: false, motif: 'lecture_impossible' }

  const lignes = profils || []
  const proprio = lignes.find(p => p.is_owner === true)
  const personnes = [{
    userId: compte,
    email: (proprio && proprio.email) || null,
    telephone: (proprio && proprio.phone) || null,
    titulaire: true
  }]

  // Un événement sans domaine (k, la pause automatique) ne va qu'au titulaire.
  if (!e.domaine) return { ok: true, personnes }

  const membres = lignes.filter(p => p.is_owner !== true && p.member_user_id && p.member_user_id !== compte)
  if (!membres.length) return { ok: true, personnes }

  const { data: perms, error: e2 } = await db.from('profile_permissions')
    .select('*')
    .in('profile_id', membres.map(p => p.id))
  if (e2) return { ok: false, motif: 'lecture_impossible' }
  const parProfil = new Map((perms || []).map(p => [p.profile_id, p]))

  const exige = e.ecriture ? RANG.write : RANG.read
  for (const profil of membres) {
    const contexte = { userId: profil.member_user_id, accountUserId: compte, profil, permissions: parProfil.get(profil.id) || null }
    if (RANG[niveauEffectif(contexte, e.domaine)] < exige) continue
    if (!dansPerimetre(contexte, bien)) continue
    // Une personne membre deux fois du même compte ne reçoit qu'une fois.
    if (personnes.some(x => x.userId === profil.member_user_id)) continue
    personnes.push({ userId: profil.member_user_id, email: profil.email || null, telephone: profil.phone || null, titulaire: false })
  }
  return { ok: true, personnes }
}

module.exports = { destinataires }
