// lib/push/abonnements-prestataires.js — LE SEUL MODULE QUI ÉCRIT dans
// `push_abonnements_prestataires`. PWA lot 3, étape 1.
// Spec : docs/specs/spec-pwa-lot3-prestataires.md §7.1-7.4 · KB : docs/kb/pwa.md §13
//
// Une ligne = un appareil abonné, pour UN profil de prestataire. Le jumeau de
// `lib/push/abonnements.js` (lot 2), qui porte les personnes ayant un compte ;
// une prestataire n'en a pas : son lien est sa seule identité, et c'est
// `api/menages-public.js` qui la reconnaît (garde `profilActifDuJeton`) avant
// d'appeler ce module avec son profil.
//
// ⚠ LA VALIDATION DE L'ABONNEMENT EST CELLE DU LOT 2, PAS UNE COPIE. L'adresse
// d'envoi vient du navigateur et le serveur va l'appeler : sans contrôle, un
// porteur de lien ferait appeler par nos serveurs l'adresse de son choix
// (SSRF). `validerAbonnement` est importé : deux copies divergent.
//
// ⚠ L'UNICITÉ PORTE SUR (profil, adresse). Les applis installées d'une même
// prestataire chez deux hôtes partagent, sur Android, la portée
// `/apps/menages/` — donc le même abonnement, qui doit servir aux deux.
//
// ⚠ LA PURGE (nouveau lien, désactivation, changement de mode) EST EN BASE :
// migrations/2026-11-17-push-abonnements-prestataires.sql. Ce module n'a donc
// pas de « tout retirer » à appeler depuis les écrivains de `profiles`.
const { PLAFOND_APPAREILS, validerAbonnement, libelleAppareil, empreinte } = require('./abonnements')

const TABLE = 'push_abonnements_prestataires'

function client () {
  return require('../cron-shared').supabase
}

function normaliser (endpoint) {
  const s = String(endpoint == null ? '' : endpoint)
  try { return new URL(s).href } catch { return s }
}

async function enregistrer ({ profilId, compteId, abonnement, appareil, db = client() }) {
  if (!profilId || !compteId) return { ok: false, motif: 'personne_absente' }
  const v = validerAbonnement(abonnement)
  if (!v.ok) return { ok: false, motif: v.motif }
  const { endpoint, keys } = v.abonnement

  // Le plafond se compte HORS de cet appareil : réabonner un appareil déjà
  // enregistré n'est jamais refusé.
  const { data: siens, error: e1 } = await db.from(TABLE)
    .select('id, endpoint').eq('profil_id', profilId)
  if (e1) return { ok: false, motif: 'lecture_impossible' }
  const autres = (siens || []).filter(l => l.endpoint !== endpoint)
  if (autres.length >= PLAFOND_APPAREILS) return { ok: false, motif: 'plafond_atteint' }

  const ligne = {
    profil_id: profilId,
    compte_id: compteId,
    endpoint,
    cle_p256dh: keys.p256dh,
    cle_auth: keys.auth,
    appareil: libelleAppareil(appareil),
    cree_le: new Date().toISOString(),
    dernier_envoi_le: null,
    dernier_echec: null
  }
  const { error: e2 } = await db.from(TABLE).upsert(ligne, { onConflict: 'profil_id,endpoint' })
  if (e2) return { ok: false, motif: 'ecriture_impossible' }
  return { ok: true, empreinte: empreinte(endpoint) }
}

// Désabonner CET appareil, pour CE profil — jamais celui d'un autre profil qui
// partagerait la même adresse (deux hôtes, même téléphone).
async function retirer ({ profilId, endpoint, db = client() }) {
  if (!profilId) return { ok: false, motif: 'personne_absente' }
  if (!endpoint || typeof endpoint !== 'string') return { ok: false, motif: 'cible_absente' }
  const { error } = await db.from(TABLE).delete()
    .eq('profil_id', profilId).eq('endpoint', normaliser(endpoint))
  if (error) return { ok: false, motif: 'ecriture_impossible' }
  return { ok: true }
}

// Ses appareils, SANS adresse ni clé : l'empreinte suffit à la page pour se
// reconnaître, et le nombre suffit à l'hôte.
async function lister ({ profilId, db = client() }) {
  if (!profilId) return { ok: false, motif: 'personne_absente' }
  const { data, error } = await db.from(TABLE)
    .select('endpoint, appareil, cree_le, dernier_envoi_le')
    .eq('profil_id', profilId)
  if (error) return { ok: false, motif: 'lecture_impossible' }
  return {
    ok: true,
    appareils: (data || []).map(l => ({
      empreinte: empreinte(l.endpoint),
      appareil: l.appareil,
      cree_le: l.cree_le,
      dernier_envoi_le: l.dernier_envoi_le
    }))
  }
}

// Les abonnements COMPLETS, pour l'envoi. Jamais rendus au navigateur.
async function pourEnvoi ({ profilId, db = client() }) {
  if (!profilId) return { ok: false, motif: 'personne_absente' }
  const { data, error } = await db.from(TABLE)
    .select('id, endpoint, cle_p256dh, cle_auth')
    .eq('profil_id', profilId)
  if (error) return { ok: false, motif: 'lecture_impossible' }
  return { ok: true, abonnements: data || [] }
}

// Après un envoi : 404/410 = l'abonnement est mort, la ligne part ; un succès
// date le dernier envoi ; un autre échec se note, sans supprimer.
async function apresEnvoi ({ id, resultat, db = client() }) {
  if (resultat.mort) {
    await db.from(TABLE).delete().eq('id', id)
    return
  }
  const maj = resultat.ok
    ? { dernier_envoi_le: new Date().toISOString(), dernier_echec: null }
    : { dernier_echec: String(resultat.motif || resultat.statut || 'echec').slice(0, 120) }
  await db.from(TABLE).update(maj).eq('id', id)
}

module.exports = { TABLE, enregistrer, retirer, lister, pourEnvoi, apresEnvoi }
