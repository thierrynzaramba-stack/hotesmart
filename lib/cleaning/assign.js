// lib/cleaning/assign.js
// DOC : docs/kb/menage.md (modif = MEME COMMIT)
//
// Moteur d'assignation des menages. Conception : docs/specs/spec-prestataires-menage.md §11.2.
//
// V1 = mode `priorite` SEUL : on retient la liaison active de plus petit rang.
// Les modes `jour` et `quota` (spec §3) restent la cible et supposent les
// disponibilites RRULE (§2) ; `properties.cleaning_assignment_mode` est deja en
// base pour que leur arrivee ne demande pas de migration.
//
// ⚠ REGLE D'ENGAGEMENT (spec §11.3, decision du 3 septembre 2026) :
//   - le REFERENT (rang 1) est assigne D'OFFICE — l'assignation vaut engagement,
//     aucune confirmation. C'est le fonctionnement actuel de Regina.
//   - le SUPPLEANT (rang 2+) doit CONFIRMER : le menage nait `offered`.
// Confondre les deux, ce serait soit imposer un bouton a Regina qui n'en a
// jamais eu besoin, soit engager une remplacante sans qu'elle ait rien accepte.
//
// ⚠ AUCUN FORCAGE (spec §11.4). Sans liaison active, le menage reste NON
// ASSIGNE. Jamais de repli sur « le prestataire du bien d'a cote » : un menage
// attribue a quelqu'un qui ne l'a pas fait fausse aussi les avis, puisque
// l'attribution des remarques de proprete suit cette meme assignation.

// Charge les liaisons actives de plusieurs biens en UNE requete, indexees par
// `user_id|property_id`.
//
// ⚠ ISOLATION MULTI-COMPTES (REVIEW.md regle 1) : la cle est composite. Le
// writer traite un lot multi-comptes, et `provider_property_id` n'a AUCUNE
// unicite globale — deux hotes d'un meme property manager Beds24 portent les
// memes propIds. Une map indexee sur le seul propId assignerait la prestataire
// d'un hote aux menages d'un autre.
async function chargerLiaisons (sb, couples) {
  const parBien = new Map()
  if (!couples || !couples.length) return parBien

  const userIds = [...new Set(couples.map(c => String(c.userId)))]
  const propIds = [...new Set(couples.map(c => String(c.propertyId)))]

  // ⚠ L'erreur est REMONTEE. Une liste vide serait indiscernable de « aucun
  // prestataire lie » — un chemin de succes qui laisserait tous les menages non
  // assignes, et declencherait une alerte par bien.
  const { data, error } = await sb.from('property_cleaning_providers')
    .select('user_id, property_id, provider_id, rang')
    .in('user_id', userIds)
    .in('property_id', propIds)
    .eq('active', true)
    .order('rang', { ascending: true })
  if (error) { const e = new Error(`liaisons: ${error.message}`); e.dbError = true; throw e }

  for (const l of (data || [])) {
    const cle = `${l.user_id}|${String(l.property_id)}`
    if (!parBien.has(cle)) parBien.set(cle, [])
    parBien.get(cle).push({ providerId: l.provider_id, rang: l.rang })
  }
  // `order` porte sur la requete entiere, pas par groupe : on retrie.
  for (const liste of parBien.values()) liste.sort((a, b) => a.rang - b.rang)
  return parBien
}

// Decide qui fait le menage, et dans quel etat il nait.
//
// Rend TOUJOURS un objet — jamais null : l'absence de candidate est un resultat,
// pas une panne, et l'appelant doit pouvoir la distinguer d'une erreur.
function choisirPrestataire (liaisons, { mode = 'priorite' } = {}) {
  const candidates = Array.isArray(liaisons) ? liaisons : []
  if (!candidates.length) {
    return {
      providerId: null, rang: null, referent: false,
      status: 'unassigned', assignedBy: null,
      // ⚠ `aucuneLiaison` distingue « ce bien n'a personne » de « personne n'est
      // disponible ce jour-la » (mode `jour`, a venir). Le premier ne doit PAS
      // alerter : un bien sans prestataire lie n'est pas en panne, il n'est pas
      // gere — decision du product owner du 3 septembre 2026.
      aucuneLiaison: true,
      raison: 'Aucun prestataire lie a ce bien.'
    }
  }

  // Mode `priorite` : le plus petit rang. Les autres modes rendront une liste
  // ordonnee differemment, mais la suite du traitement ne changera pas.
  const retenue = candidates[0]
  const referent = retenue.rang === 1

  // ⚠ LA RESPONSABILITE NE SE TRANSFERE QU'A L'ACCEPTATION (decision du
  // 4 septembre 2026). Un referent PORTE le menage des sa creation. Un
  // suppleant, lui, ne le porte pas : il recoit une PROPOSITION, qui vit dans
  // `offered_to` a cote de `provider_id` — jamais a sa place.
  //
  // Ici, l'automate ne propose qu'a defaut : s'il n'y a pas de referent actif
  // sur ce bien, personne ne porte le menage, et le suppleant de plus petit
  // rang est sollicite. Le cas normal — proposer a une suppleante un menage que
  // la referente porte deja — vient de l'hote, par reassignation manuelle.
  if (referent) {
    return {
      providerId: retenue.providerId, offeredTo: null,
      rang: retenue.rang, referent: true,
      status: 'accepted', assignedBy: 'auto', aucuneLiaison: false,
      raison: 'Referent du bien (rang 1), assigne d\'office.',
      mode
    }
  }

  return {
    // Personne ne porte : c'est un bien sans referent actif.
    providerId: null, offeredTo: retenue.providerId,
    rang: retenue.rang, referent: false,
    status: 'offered', assignedBy: 'auto', aucuneLiaison: false,
    raison: `Aucun referent sur ce bien : propose au suppleant (rang ${retenue.rang}).`,
    mode
  }
}

// L'echeance d'une proposition : 48 h, JAMAIS au-dela de la veille du depart a
// 18 h. Au-dela, une reponse arriverait trop tard pour servir a quoi que ce soit.
//
// ⚠ Rend `null` quand l'echeance serait DEJA PASSEE. L'appelant doit alors
// refuser de proposer plutot qu'envoyer une proposition morte-nee : une
// proposition doit laisser un vrai delai de reponse (decision du 4 septembre).
const HEURES_OFFRE = 48
function echeanceOffre (departureDate, maintenant = Date.now()) {
  const plafond48 = maintenant + HEURES_OFFRE * 3600 * 1000
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(departureDate || ''))
  if (!m) return new Date(plafond48).toISOString()
  // Veille du depart a 18 h, en heure de Paris (UTC+2 l'ete, +1 l'hiver). On
  // prend 16 h UTC : c'est 18 h a Paris en ete, 17 h en hiver — une heure de
  // marge dans le sens prudent, jamais l'inverse.
  const veille = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - 1, 16, 0, 0)
  const limite = Math.min(plafond48, veille)
  if (limite <= maintenant) return null
  return new Date(limite).toISOString()
}

// Les horodatages qui accompagnent l'etat, pour ne pas les recalculer partout.
function horodatages (choix, maintenant = new Date()) {
  const iso = maintenant.toISOString()
  if (choix.status === 'accepted') return { accepted_at: iso, offered_at: null }
  if (choix.status === 'offered')  return { offered_at: iso, accepted_at: null }
  return { offered_at: null, accepted_at: null }
}

// Les colonnes de la proposition, remises a zero. Un refus, une expiration ou un
// retrait effacent la PROPOSITION — jamais le porteur.
const SANS_OFFRE = { offered_to: null, offered_at: null, offer_expires_at: null }

module.exports = { chargerLiaisons, choisirPrestataire, horodatages, echeanceOffre, SANS_OFFRE, HEURES_OFFRE }
