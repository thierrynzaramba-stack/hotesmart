// lib/cleaning/assign.js
// DOC : docs/kb/menage.md (modif = MEME COMMIT)
//
// Moteur d'assignation des menages. Conception : spec §11.2 puis §12 (lot 3.3).
//
// ⚠ UN SEUL ALGORITHME, ET C'EST LA GARDE DU JOUR (§12.1). `choisirPrestataire`
// — « le plus petit rang actif, rang 1 = d'office » — n'existe plus. Le rang ne
// sert plus qu'a DEPARTAGER et a REMPLACER : ce qui decide, c'est
// `responsableDuJour(bien, date)`, la premiere personne attitree CE JOUR-LA
// (`weekdays`) et DISPONIBLE (RRULE + exceptions).
//
// ⚠ REGLE D'ENGAGEMENT — `requires_ack`, PAS LE RANG (§12.3).
//   - `requires_ack = false` -> elle PORTE le menage d'office ;
//   - `requires_ack = true`  -> elle recoit une PROPOSITION (modele parallele).
// Deduire l'engagement du rang condamnait une attitree du week-end en rang 2 a
// confirmer pour toujours, et interdisait a une seconde personne rodee d'etre
// assignee d'office sans la promouvoir rang 1 devant la titulaire.
//
// ⚠ L'INVARIANT DE LA PORTEUSE (§12.4) :
//   « Le menage est PORTE par la premiere candidate qui n'a rien a confirmer.
//     Il est PROPOSE a la responsable du jour si elle est differente. »
// Aucun etat sans porteuse, et l'escalade se termine d'elle-meme.
//
// ⚠ LA FILE DE PROPOSITION, CE SONT LES CANDIDATES QUI DOIVENT CONFIRMER, dans
// l'ordre du jour — PAS seulement celles placees avant la porteuse. C'est le
// deroule du cas reel de Bagneres (tableau du §12.4) : Regina est rang 1 ET
// d'office, la seconde est rang 2 et doit confirmer, et le tableau dit bien
// « Creation : portee par Regina, proposee a la seconde ». Borner la file aux
// candidates qui PRIMENT sur la porteuse — lecture litterale de « proposee a la
// premiere du classement si differente » — ne proposait plus jamais rien sur le
// seul cas reel du depot : tout le mecanisme de proposition et d'escalade
// serait ne mort. Le sens metier est celui du tableau : la titulaire couvre
// tous les jours, et quand la seconde est de garde on lui DEMANDE si elle
// prend — sans jamais decouvrir le logement en attendant sa reponse.
//
// ⚠ AUCUN FORCAGE (spec §11.4). Sans candidate, le menage reste NON ASSIGNE.
// Jamais de repli sur « le prestataire du bien d'a cote » : un menage attribue a
// quelqu'un qui ne l'a pas fait fausse aussi les avis, puisque l'attribution des
// remarques de proprete suit cette meme assignation.

const { responsableDuJour } = require('./garde')
const { indexerParPrestataire, jourUTC, cleJour } = require('./availability')

// ⚠ ON NE PROPOSE QU'AUX LIAISONS DONT LES JOURS SONT EXPLICITEMENT REGLES
// (decision du product owner, 4 septembre 2026 — a REVOIR AU LOT 3.5).
//
// `weekdays` vide ou NULL veut dire « attitree tous les jours » (§12.1) : c'est
// ce qui rend le modele retrocompatible sans migration. Mais tant qu'aucun ecran
// ne permet de regler ces jours (lot 3.5), TOUTE liaison a `requires_ack = true`
// est donc candidate a chaque depart, et recevrait une proposition — un SMS
// par menage, sur la cle Brevo de l'hote, pour quelqu'un qui n'a jamais declare
// prendre ces jours-la. Le defaut est donc le SILENCE : sans jours attitres
// reglés, pas de sollicitation.
//
// ⚠ CETTE RESTRICTION NE VAUT QUE POUR LA PROPOSITION. Elle ne retire personne
// des CANDIDATES : une liaison sans jours reste attitree tous les jours pour tout
// le reste — la porteuse d'office, elle, n'est pas concernee (elle ne confirme
// rien), et Regina continue de porter ses menages exactement comme avant.
function joursAttitresRegles (candidate) {
  return Array.isArray(candidate.weekdays) && candidate.weekdays.length > 0
}

// Fenetre pendant laquelle une PROPOSITION a un sens, en jours avant le depart.
//
// ⚠ POURQUOI UNE FENETRE. Une proposition expire en 48 h au plus (`echeanceOffre`).
// Posee a la creation d'un menage qui part dans six mois, elle serait morte deux
// jours plus tard, la file de proposition serait epuisee, et la responsable du
// jour n'aurait plus jamais l'occasion de prendre ce menage : il resterait chez
// sa porteuse pour toujours, sans que personne ne l'ait decide.
//
// ⚠ C'est AUSSI la garde d'envoi de masse de REVIEW.md regle 2. Le writer balaye
// J-30/J+180 : a la premiere activation d'un compte Channex, proposer a la
// creation aurait envoye un SMS par reservation historique future — la faute
// exacte qui a produit les messages « bienvenue » a des voyageurs partis.
//
// La proposition est donc POSEE PLUS TARD, par `poserPropositionsDues` (cron),
// quand le depart entre dans cette fenetre. Entre-temps le menage est porte par
// la premiere candidate d'office : personne n'est jamais decouvert.
const JOURS_PROPOSITION = 7

// Taille d'une PAGE de lecture, et plafond dur.
//
// ⚠ CES LECTURES SE PAGINENT, ELLES NE SE TRONQUENT PAS. Se tronquer en silence
// ferait paraitre disponible quelqu'un qui est en conge — on assignerait un
// menage qu'elle ne peut pas faire, et personne ne le saurait avant le jour J.
// Mais LEVER a la premiere page pleine etait pire : `synchroniserMenages` rend
// alors `interrompu:'db'`, donc plus AUCUNE creation, annulation ni alerte, a
// chaque cycle et sans reprise — et trois prestataires a qui on declare leurs
// conges de l'annee suffisent a atteindre le seuil. On lit donc toutes les
// pages ; le plafond dur n'est plus qu'un garde-fou contre une boucle.
const PAGE = 1000
const MAX_PAGES = 20

// Lit une table page par page jusqu'a epuisement. `q()` doit rendre une requete
// NEUVE a chaque appel : un builder PostgREST ne se rejoue pas.
//
// ⚠ L'ORDRE EST OBLIGATOIRE. Sans `order`, deux pages peuvent rendre la meme
// ligne et en sauter une autre — une exception de conge manquee, et le menage
// part a quelqu'un qui n'est pas la.
async function lireTout (q, etiquette, ordre) {
  const tout = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await q()
      .order(ordre, { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1)
    if (error) { const e = new Error(`${etiquette}: ${error.message}`); e.dbError = true; throw e }
    const lot = data || []
    tout.push(...lot)
    if (lot.length < PAGE) return tout
  }
  // Au-dela, c'est une anomalie : on le dit fort plutot que de decider sur un
  // sous-ensemble arbitraire.
  const e = new Error(`${etiquette}: plus de ${MAX_PAGES * PAGE} lignes`)
  e.dbError = true
  throw e
}

// Charge les liaisons actives de plusieurs biens en UNE requete, indexees par
// `user_id|property_id`.
//
// ⚠ ISOLATION MULTI-COMPTES (REVIEW.md regle 1) : la cle est composite. Le
// writer traite un lot multi-comptes, et `provider_property_id` n'a AUCUNE
// unicite globale — deux hotes d'un meme property manager Beds24 portent les
// memes propIds. Une map indexee sur le seul propId assignerait la prestataire
// d'un hote aux menages d'un autre.
//
// ⚠ `weekdays` ET `requires_ack` SONT LUS. Sans eux, `normaliserLiaison` retombe
// sur ses defauts — attitree tous les jours, et « doit confirmer » — c'est-a-dire
// que TOUTE personne assignee d'office redeviendrait une simple sollicitee, et
// qu'une attitree du week-end recevrait des menages en semaine.
async function chargerLiaisons (sb, couples) {
  const parBien = new Map()
  if (!couples || !couples.length) return parBien

  const userIds = [...new Set(couples.map(c => String(c.userId)))]
  const propIds = [...new Set(couples.map(c => String(c.propertyId)))]

  // ⚠ L'erreur est REMONTEE. Une liste vide serait indiscernable de « aucun
  // prestataire lie » — un chemin de succes qui laisserait tous les menages non
  // assignes, et declencherait une alerte par bien.
  const { data, error } = await sb.from('property_cleaning_providers')
    .select('user_id, property_id, provider_id, rang, weekdays, requires_ack, active')
    .in('user_id', userIds)
    .in('property_id', propIds)
    .eq('active', true)
    .order('rang', { ascending: true })
  if (error) { const e = new Error(`liaisons: ${error.message}`); e.dbError = true; throw e }

  for (const l of (data || [])) {
    const cle = `${l.user_id}|${String(l.property_id)}`
    if (!parBien.has(cle)) parBien.set(cle, [])
    // ⚠ La ligne est transmise TELLE QUELLE a `garde.js`, qui la normalise. La
    // reduire ici a `{ providerId, rang }` — ce que faisait la version rang —
    // perdait `weekdays` et `requires_ack` en silence.
    parBien.get(cle).push(l)
  }
  // `order` porte sur la requete entiere, pas par groupe : on retrie.
  for (const liste of parBien.values()) liste.sort((a, b) => Number(a.rang) - Number(b.rang))
  return parBien
}

// Les disponibilites de tout un lot, indexees par `user_id|provider_id`.
//
// ⚠ UNE PANNE COUPE, ELLE NE DEVINE PAS. Rendre des maps vides sur erreur ferait
// paraitre TOUT LE MONDE disponible (« aucune regle = disponible ») : les conges
// seraient ignores et les menages partiraient a des gens absents. C'est la meme
// regle que dans `availability.js` — une regle illisible rend indisponible.
async function chargerDisponibilites (sb, userIds, { du = null, au = null } = {}) {
  const vide = { regles: new Map(), exceptions: new Map() }
  const ids = [...new Set((userIds || []).map(String))]
  if (!ids.length) return vide

  const regles = await lireTout(() => sb.from('provider_availability_rules')
    .select('user_id, provider_id, rrule, active')
    .in('user_id', ids).eq('active', true), 'regles', 'id')

  const exceptions = await lireTout(() => {
    let q = sb.from('provider_availability_exceptions')
      .select('user_id, provider_id, date, available')
      .in('user_id', ids)
    // Bornes optionnelles : le writer connait sa fenetre, un appelant ponctuel non.
    if (du) q = q.gte('date', du)
    if (au) q = q.lte('date', au)
    return q
  }, 'exceptions', 'id')

  return {
    regles: indexerParPrestataire(regles || []),
    exceptions: indexerParPrestataire(exceptions || [])
  }
}

// Qui a DEJA dit non — ou n'a pas repondu — sur ces menages.
//
// ⚠ LE JOURNAL EST LA MEMOIRE DE L'ESCALADE. Sans lui, la proposition suivante
// retomberait sur la personne qui vient de refuser : elle refuserait encore, et
// le cycle recommencerait toutes les cinq minutes.
//
// ⚠ `expired` COMPTE COMME UN REFUS. Repropose apres son expiration, quelqu'un
// qui n'a pas repondu recevrait un SMS toutes les 48 h jusqu'au depart.
async function chargerRefus (sb, menageIds) {
  const parMenage = new Map()
  const ids = [...new Set((menageIds || []).map(String))].filter(Boolean)
  if (!ids.length) return parMenage

  // ⚠ PAGINE, COMME LES AUTRES — et c'est ici que la troncature couterait le plus
  // cher : une refusante absente du jeu lu redevient la premiere de la file, on
  // lui repose l'offre, et elle recoit un SMS toutes les 48 h jusqu'au depart.
  // C'est exactement la boucle que cette fonction existe pour empecher.
  // ⚠ L'erreur est REMONTEE : ne pas escalader vaut mieux que reproposer a qui
  // vient de refuser.
  const data = await lireTout(() => sb.from('menage_assignment_log')
    .select('menage_id, from_provider_id, event')
    .in('menage_id', ids)
    .in('event', ['declined', 'expired']), 'journal', 'created_at')

  for (const l of (data || [])) {
    if (!l.from_provider_id) continue
    const k = String(l.menage_id)
    if (!parMenage.has(k)) parMenage.set(k, new Set())
    parMenage.get(k).add(String(l.from_provider_id))
  }
  return parMenage
}

// Le depart est-il assez proche pour qu'une proposition ait un sens ?
function dansLaFenetreDeProposition (date, maintenant = Date.now(), jours = JOURS_PROPOSITION) {
  const d = jourUTC(date)
  if (!d) return false
  const m = jourUTC(new Date(maintenant))
  if (!m) return false
  const ecart = Math.round((d.getTime() - m.getTime()) / 86400000)
  // ⚠ BORNEE DES DEUX COTES. Le passe PROCHE reste dedans — un menage d'hier peut
  // encore etre a faire, et c'est justement le moment ou l'hote cherche quelqu'un
  // en urgence — mais pas au-dela : le writer balaye J-30, et une fenetre ouverte
  // vers le passe faisait re-signaler a chaque cycle des menages vieux d'un mois
  // que plus personne ne fera. C'est la meme borne que la lecture de
  // `poserPropositionsDues` (J-1).
  return ecart >= -1 && ecart <= jours
}

const AUCUNE_CANDIDATE = {
  providerId: null, offeredTo: null, status: 'unassigned', assignedBy: null,
  mode: 'garde', trouDeGarde: false, differee: false, epuise: false,
  sansJoursAttitres: false
}

/**
 * QUI FAIT CE MENAGE, ce jour-la, et dans quel etat il nait.
 *
 * Rend TOUJOURS un objet — jamais null : l'absence de candidate est un RESULTAT,
 * pas une panne, et l'appelant doit pouvoir la distinguer d'une erreur.
 *
 * @param {{userId, propertyId, liaisons, regles?: Map, exceptions?: Map}} bien
 * @param {string|Date} date  le jour du menage = la date de DEPART
 * @param {{exclus?: Set, maintenant?: number, fenetre?: number}} opts
 *        `exclus` : les personnes a qui on ne repropose pas (refus, expiration).
 */
function deciderParGarde (bien, date, opts = {}) {
  const { exclus = null, maintenant = Date.now(), fenetre = JOURS_PROPOSITION } = opts
  // ⚠ `Array.isArray`, pas un simple test de verite : une chaine passait le test
  // `.length` et faisait croire a des liaisons. Le bien paraissait alors avoir
  // des prestataires dont aucune n'etait la — un TROU DE GARDE, donc une alerte —
  // au lieu de « ce bien n'est pas gere ».
  const liaisons = Array.isArray(bien && bien.liaisons) ? bien.liaisons : []

  // ⚠ « AUCUNE LIAISON » N'EST PAS « AUCUNE CANDIDATE ». Le premier veut dire
  // que ce bien n'est pas gere par l'app menage — il ne doit PAS alerter, sans
  // quoi chaque depart d'un hote qui fait son menage lui-meme produirait du
  // bruit permanent (decision du product owner, 3 septembre 2026). Le second est
  // le TROU DE GARDE : le bien a des prestataires, mais personne n'est la ce
  // jour-la — et celui-la, quand un menage existe, merite une alerte (§12.6).
  if (!liaisons.length) {
    return { ...AUCUNE_CANDIDATE, aucuneLiaison: true, candidates: [],
             raison: 'Aucun prestataire lie a ce bien.' }
  }

  const { candidates } = responsableDuJour(bien, date)
  if (!candidates.length) {
    return { ...AUCUNE_CANDIDATE, aucuneLiaison: false, trouDeGarde: true, candidates: [],
             raison: `Personne de garde le ${cleJour(date) || date} : ni attitree, ni disponible.` }
  }

  // La PORTEUSE : la premiere qui n'a rien a confirmer.
  const porteuse = candidates.find(c => c.requiresAck === false) || null

  // LA FILE DE PROPOSITION : les candidates du jour qui DOIVENT confirmer, dans
  // l'ordre du classement, moins celles qui ont deja dit non ou laisse expirer.
  // ⚠ Elle ne contient jamais la porteuse (elle, par definition, ne confirme
  // pas) : `menages_offre_pas_a_soi` refuserait l'ecriture.
  // ⚠ Et jamais une liaison SANS JOURS ATTITRES REGLES (voir plus haut).
  const aConfirmer = candidates.filter(c => c.requiresAck !== false)
  // Celles a qui on n'a pas deja demande. L'ordre des deux filtres compte pour
  // le diagnostic rendu plus bas.
  const restantes = aConfirmer.filter(c => !exclus || !exclus.has(String(c.providerId)))
  const file = restantes.filter(joursAttitresRegles)
  // ⚠ « BRIDEE » VEUT DIRE : il reste quelqu'un a qui demander, et AUCUNE de ces
  // personnes n'a de jours regles. Un `some` sur toutes les candidates disait
  // « aucune n'a de jours regles » des qu'UNE seule en manquait : une file
  // reellement EPUISEE (tout le monde a refuse) etait alors rapportee comme un
  // probleme de reglage, et l'hote cherchait un jour a regler au lieu de voir
  // qu'on lui demandait de trancher.
  const bridees = restantes.length > 0 && file.length === 0

  const proposable = dansLaFenetreDeProposition(date, maintenant, fenetre)
  const proposee = proposable ? (file[0] || null) : null
  // ⚠ `differee` SE JUGE AVANT LA RESTRICTION DES JOURS. Le calculer sur `file`
  // — donc apres le filtre — faisait disparaitre le report : un depart a cinq
  // mois sur un bien sans jours regles tombait dans la branche « bridee » et
  // alertait l'hote des la creation, au lieu d'attendre en silence que la date
  // approche. On ne signale un manque de reglage que quand il commence a compter.
  const differee = !proposable && restantes.length > 0

  if (porteuse) {
    return {
      providerId: porteuse.providerId,
      offeredTo: proposee ? proposee.providerId : null,
      status: 'accepted', assignedBy: 'auto', mode: 'garde',
      // ⚠ AUCUNE ALERTE ICI, MEME BRIDEE : quelqu'un porte le menage, le
      // logement sera prepare. Le seul manque est une sollicitation de confort.
      aucuneLiaison: false, trouDeGarde: false, differee, epuise: false,
      sansJoursAttitres: false,
      candidates: candidates.map(c => c.providerId),
      raison: proposee
        ? 'Portee par la premiere candidate d\'office, proposee a la responsable du jour.'
        : 'Responsable du jour, assignee d\'office.'
    }
  }

  // Personne ne porte : toutes les candidates du jour doivent confirmer.
  if (proposee) {
    return {
      providerId: null, offeredTo: proposee.providerId,
      status: 'offered', assignedBy: 'auto', mode: 'garde',
      aucuneLiaison: false, trouDeGarde: false, differee: false, epuise: false,
      sansJoursAttitres: false,
      candidates: candidates.map(c => c.providerId),
      raison: 'Aucune candidate d\'office ce jour-la : proposee a la responsable du jour.'
    }
  }

  // Ni porteuse, ni personne a solliciter. Deux causes tres differentes :
  //   - la file est EPUISEE (tout le monde a refuse ou laisse expirer) : c'est
  //     une decision humaine qui manque -> `orphaned`, et l'hote est alerte ;
  //   - la proposition est simplement DIFFEREE (depart lointain) : le menage
  //     attend son tour, il n'y a rien a signaler.
  if (differee) {
    return { ...AUCUNE_CANDIDATE, aucuneLiaison: false, differee: true,
             candidates: candidates.map(c => c.providerId), assignedBy: 'auto',
             raison: 'Proposition differee : le depart est encore loin.' }
  }
  // ⚠ PERSONNE NE PORTE, ET LA SEULE RAISON EST LA RESTRICTION. Se taire ici
  // laisserait un logement sans personne SANS QUE PERSONNE NE LE SACHE — le
  // silence voulu porte sur le SMS, pas sur le fait qu'un menage n'a personne.
  // Le statut reste `unassigned` (et non `orphaned`, qui verrouille) : le jour ou
  // l'hote regle les jours, le rattrapage du writer reprend ce menage tout seul.
  if (bridees) {
    return { ...AUCUNE_CANDIDATE, aucuneLiaison: false, assignedBy: 'auto',
             sansJoursAttitres: true,
             candidates: candidates.map(c => c.providerId),
             raison: 'Personne d\'office, et aucune candidate n\'a de jours attitres regles.' }
  }
  return {
    providerId: null, offeredTo: null, status: 'orphaned', assignedBy: 'auto',
    mode: 'garde', aucuneLiaison: false, trouDeGarde: false, differee: false, epuise: true,
    candidates: candidates.map(c => c.providerId),
    raison: 'Toutes les candidates du jour ont ete sollicitees sans suite.'
  }
}

// L'echeance d'une proposition : 48 h, JAMAIS au-dela de la veille du depart a
// 18 h. Au-dela, une reponse arriverait trop tard pour servir a quoi que ce soit.
const HEURES_OFFRE = 48
// ⚠ AUCUN PLANCHER : ON PROPOSE A TOUT MOMENT (decision du 4 septembre 2026).
// Un plancher de deux heures avait ete pose, puis retire : les changements de
// derniere minute font partie du metier, et refuser la proposition a une heure
// du depart obligeait l'hote a engager quelqu'un sans son accord alors qu'un
// simple oui aurait suffi. Une proposition courte vaut mieux qu'une proposition
// impossible.
//
// ⚠ L'ECHEANCE, ELLE, RESTE OBLIGATOIRE — `menages_offre_datee` l'impose, et une
// proposition sans terme resterait en suspens indefiniment. Quand la veille du
// depart est deja passee, on retient UNE HEURE : c'est court, mais c'est un vrai
// terme, et rien ne l'efface avant.
function echeanceOffre (departureDate, maintenant = Date.now()) {
  const plafond48 = maintenant + HEURES_OFFRE * 3600 * 1000
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(departureDate || ''))
  if (!m) return new Date(plafond48).toISOString()
  // Veille du depart a 18 h, en heure de Paris (UTC+2 l'ete, +1 l'hiver). On
  // prend 16 h UTC : c'est 18 h a Paris en ete, 17 h en hiver — une heure de
  // marge dans le sens prudent, jamais l'inverse.
  const veille = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - 1, 16, 0, 0)
  const limite = Math.min(plafond48, veille)
  // Derniere minute : la veille est passee, mais on propose quand meme.
  if (limite <= maintenant) return new Date(maintenant + 3600 * 1000).toISOString()
  return new Date(limite).toISOString()
}

// Les horodatages qui accompagnent l'etat, pour ne pas les recalculer partout.
//
// ⚠ `offered_at` SUIT LA PROPOSITION, PAS LE STATUT. Depuis le modele parallele,
// un menage peut etre `accepted` — quelqu'un le porte — ET sous proposition en
// meme temps : c'est meme le cas nominal du §12.4. Lier `offered_at` au seul
// statut `offered` laissait une proposition sans date de depart dans la PWA, qui
// affiche le delai restant a partir d'elle.
function horodatages (choix, maintenant = new Date()) {
  const iso = maintenant.toISOString()
  const offert = choix && choix.offeredTo ? iso : null
  if (choix.status === 'accepted') return { accepted_at: iso, offered_at: offert }
  if (choix.status === 'offered')  return { offered_at: iso, accepted_at: null }
  return { offered_at: offert, accepted_at: null }
}

// Les colonnes de la proposition, remises a zero. Un refus, une expiration ou un
// retrait effacent la PROPOSITION — jamais le porteur.
const SANS_OFFRE = { offered_to: null, offered_at: null, offer_expires_at: null }

module.exports = {
  chargerLiaisons, chargerDisponibilites, chargerRefus,
  deciderParGarde, dansLaFenetreDeProposition, joursAttitresRegles,
  horodatages, echeanceOffre, SANS_OFFRE, HEURES_OFFRE, JOURS_PROPOSITION
}
