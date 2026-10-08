// lib/avis/cartes.js
//
// UNE CARTE PAR SEJOUR, POUR TOUS LES AVIS (recette de Thierry du 7 octobre
// 2026, point A). Les avis recus (Airbnb, Booking, saisis a la main, detectes
// en messagerie) et nos evaluations du voyageur vivaient dans deux listes, avec
// deux formats : un meme sejour s'y lisait deux fois, sans que rien ne relie
// « son avis » et « notre avis ».
//
// ⚠ FONCTION PURE : ni base, ni reseau, ni horloge (`maintenant` est injecte).
// L'endpoint lit, cette fonction assemble ; l'ecran ne fait qu'afficher.
//
// Trois sections (point C) :
//   1. `attente`  — une evaluation a faire dont le delai court encore, triee par
//                   delai restant ;
//   2. `recents`  — les sejours des 20 derniers jours ;
//   3. `anciens`  — le reste, repliable. Une evaluation HORS DELAI y passe,
//                   « expiree », et sort du compteur « vous attendent ».
//
// ⚠ L'IDENTITE DU VOYAGEUR ET SES DATES SUIVENT LES MEMES REGLES QU'AVANT :
//   - une carte qui porte une evaluation les montre, comme la liste des
//     evaluations les montrait (on evalue quelqu'un) ;
//   - une carte d'avis seul ne les montre qu'au droit `reservations`
//     (`voitSejours`), comme l'action `list` — le contenu d'un avis reste sous
//     `avis`, le sejour qu'il designe suit `reservations` (api/avis.js, bloc
//     CHAMPS_AVEC_SEJOUR). Sans ce droit, la carte dit « recu le … ».

const JOURS_RECENTS = 20
const JOUR_MS = 86400000

// Les etats qui demandent une action de l'hote, et leur ordre d'urgence.
const URGENCE = { echec_publication: 0, a_valider: 1, soumise_prestataire: 2, a_remplir: 3 }
const A_FAIRE = new Set(Object.keys(URGENCE))

// ⚠ L'ORIGINE DE NOTRE AVIS, TOUJOURS DITE (point B). La colonne
// `guest_evaluations.origine_texte` la porte depuis le 8 octobre 2026 ; avant,
// la base ne gardait que QUI avait valide. Une evaluation publiee sans origine
// enregistree dit ce qu'on sait seulement : « redige par l'IA » (decision de
// Thierry, point 2).
const ORIGINES = {
  humain: 'écrit par vous',
  ia: 'rédigé par l’IA, pas encore validé',
  ia_valide: 'rédigé par l’IA, validé par vous',
  ia_presta: 'rédigé par l’IA, validé par la prestataire',
  ia_auto: 'rédigé par l’IA, publié automatiquement',
  ailleurs: 'évalué directement sur Airbnb',
}

function origineDe (e) {
  if (!e) return null
  if (e.origine_texte && ORIGINES[e.origine_texte]) return { cle: e.origine_texte, libelle: ORIGINES[e.origine_texte] }
  if (e.status === 'evaluee_ailleurs') return { cle: 'ailleurs', libelle: ORIGINES.ailleurs }
  if (e.status === 'publiee') return { cle: 'ia_inconnue', libelle: 'rédigé par l’IA' }
  return null
}

const joursRestants = (echeance, maintenant) => {
  if (!echeance) return null
  const t = Date.parse(echeance)
  return Number.isFinite(t) ? Math.ceil((t - maintenant) / JOUR_MS) : null
}
const jour = v => (v ? String(v).slice(0, 10) : null)

// La plateforme d'une carte. Un avis saisi a la main ou detecte en messagerie
// est « direct », avec sa source (sms, email, oral, message).
function plateformeDe (avis, evaluation) {
  const a = avis[0]
  if (a && a.provider === 'manuel') return { cle: 'direct', source: a.source || null }
  const ota = String((evaluation && evaluation.ota) || (a && a.ota) || '').toLowerCase()
  return { cle: ota === 'airbnb' || ota === 'booking' ? ota : (ota || 'autre'), source: null }
}

// ⚠ UN AVIS MASQUE se lit dans le BRUT, strictement (revue de 5497a67, vie
// privee) : seul `is_hidden === false` chez Airbnb/Channex vaut « visible ».
// Booking et la saisie manuelle n'ont pas de double aveugle.
const estMasque = a => a.provider === 'channex' && String(a.ota).toLowerCase() === 'airbnb' && a.cache !== false

function avisPourCarte (a) {
  const masque = estMasque(a)
  return {
    id: a.id,
    provider: a.provider, ota: a.ota, source: a.source || null,
    masque,
    // Un avis masque n'a ni note ni texte a montrer : on ne montre RIEN de lui
    // que sa presence (point E : jamais « 0/10 »).
    note: masque ? null : (a.overall_score ?? null),
    texte: masque ? null : (a.content_public || a.content || null),
    extrait: masque ? null : (a.ai_clean_excerpt || null),
    verdict: masque ? null : (a.ai_clean_verdict || null),
    verdict_source: a.verdict_source || null,
    analyse: !masque && Boolean(a.ai_analyzed_at),
    detecte: a.statut === 'detecte',
    recu_le: a.received_at || null,
  }
}

/**
 * @param evaluations  lignes de guest_evaluations (perimetre deja applique)
 * @param avis         lignes d'ota_reviews (perimetre applique), avec `cache`
 *                     = raw->attributes->is_hidden, `booking_uid`, `guest_name`,
 *                     `stay_start`, `stay_end`
 * @param sejours      Map booking_uid -> { voyageur, arrivee, depart, menagePar }
 * @param nomBien      (property_id, property_id_ref) -> nom
 * @param voitSejours  droit `reservations` en lecture
 * @param maintenant   instant (ms), injecte
 * @returns { attente: [], recents: [], anciens: [] }
 */
function assemblerCartes ({ evaluations = [], avis = [], sejours = new Map(), nomBien = () => null, voitSejours = false, maintenant }) {
  if (!Number.isFinite(maintenant)) throw new Error('[avis] cartes : maintenant requis')
  const cartes = new Map()
  const carte = cle => {
    if (!cartes.has(cle)) cartes.set(cle, { cle, evaluation: null, avis: [] })
    return cartes.get(cle)
  }
  const cleDeLAvis = new Map()
  for (const e of evaluations) {
    const c = carte(`sejour:${e.booking_uid}`)
    c.e = e
    if (e.ota_review_id) cleDeLAvis.set(String(e.ota_review_id), c.cle)
  }
  // Le lien EXPLICITE de l'evaluation passe avant la reservation de l'avis :
  // s'ils divergeaient, un meme sejour ferait deux cartes (revue de ed445b2).
  for (const a of avis) {
    const cle = cleDeLAvis.get(String(a.id)) || (a.booking_uid ? `sejour:${a.booking_uid}` : `avis:${a.id}`)
    carte(cle).avis.push(a)
  }

  const limiteRecents = maintenant - JOURS_RECENTS * JOUR_MS
  const sections = { attente: [], recents: [], anciens: [] }
  for (const c of cartes.values()) {
    const e = c.e || null
    const uid = e ? String(e.booking_uid) : (c.avis.find(a => a.booking_uid) || {}).booking_uid
    const s = (uid && sejours.get(String(uid))) || {}
    const a0 = c.avis[0] || null
    // L'identite et les dates : voir l'en-tete du fichier.
    const montreSejour = Boolean(e) || voitSejours
    let voyageur = montreSejour ? (s.voyageur || null) : null
    if (montreSejour && !voyageur) {
      const g = c.avis.map(a => a.guest_name).find(Boolean)
      if (g) {
        const [prenom, ...reste] = String(g).trim().split(/\s+/)
        voyageur = { prenom: prenom || null, nom: reste.join(' ') || null }
      }
    }
    const arrivee = montreSejour ? (s.arrivee || jour(c.avis.map(a => a.stay_start).find(Boolean))) : null
    const depart = montreSejour ? (s.depart || jour(c.avis.map(a => a.stay_end).find(Boolean))) : null
    const recu = c.avis.map(a => a.received_at).filter(Boolean).sort().pop() || null

    let evaluation = null
    let section
    if (e) {
      const jr = joursRestants(e.deadline_at, maintenant)
      const aFaire = A_FAIRE.has(e.status)
      // ⚠ LE DELAI SE JUGE A L'INSTANT, pas en jours arrondis : `Math.ceil` d'un
      // delai depasse de quelques heures donne -0, et `-0 < 0` est faux — la
      // carte restait « a faire » un jour de trop (revue de ed445b2).
      // ⚠ UN ECHEC DE PUBLICATION N'EXPIRE PAS ICI : l'avis est peut-etre parti
      // chez Airbnb, un humain doit regarder (spec §8 : il passe devant tout).
      const echeanceMs = e.deadline_at ? Date.parse(e.deadline_at) : NaN
      const horsDelai = aFaire && e.status !== 'echec_publication' && Number.isFinite(echeanceMs) && echeanceMs < maintenant
      evaluation = {
        booking_uid: e.booking_uid,
        status: e.status,
        // L'etat AFFICHE : une evaluation a faire dont le delai est passe est
        // « expiree », quel que soit son statut en base (rien ne la bascule
        // toute seule : seule une tentative de publication l'ecrit).
        etat: horsDelai ? 'expiree' : e.status,
        echeance: e.deadline_at || null,
        jours_restants: aFaire && !horsDelai && jr !== null ? Math.max(0, jr) : null,
        publie_le: e.published_at || null,
        // Notre texte n'est servi qu'une fois PUBLIE (il est alors public chez
        // Airbnb) ; un brouillon reste dans la fenetre d'evaluation.
        texte: e.status === 'publiee' ? (e.public_text || null) : null,
        origine: origineDe(e),
        evaluable: aFaire && !horsDelai,
      }
      if (aFaire && !horsDelai) section = 'attente'
      else if (horsDelai || e.status === 'expiree') section = 'anciens'
    }
    // La date qui range la carte : la fin du sejour quand on la connait (meme
    // cachee a l'ecran, elle ne sort pas : seule la section en depend), sinon
    // la reception de l'avis, sinon la naissance de l'evaluation.
    const dateRef = s.depart || jour(c.avis.map(a => a.stay_end).find(Boolean)) || jour(recu) || jour(e && e.created_at)
    if (!section) section = dateRef && Date.parse(`${dateRef}T23:59:59Z`) >= limiteRecents ? 'recents' : 'anciens'

    sections[section].push({
      // ⚠ La cle d'une carte d'avis seul, sans le droit `reservations`, ne
      // porte pas l'identifiant de la reservation (revue de ed445b2).
      cle: montreSejour || !c.cle.startsWith('sejour:') ? c.cle : `avis:${(c.avis[0] || {}).id}`,
      section,
      // ⚠ La date de TRI peut etre la fin du sejour ; elle ne sort que si le
      // sejour se montre. Sinon la carte dit sa date de reception.
      _tri: dateRef,
      date_ref: montreSejour ? dateRef : jour(recu),
      bien: nomBien(e ? e.property_id : null, e ? e.property_id_ref : (a0 && a0.property_id_ref)) || null,
      plateforme: plateformeDe(c.avis, e),
      voyageur, arrivee, depart,
      recu_le: recu,
      menage_par: montreSejour ? (s.menagePar || null) : null,
      avis: c.avis.map(avisPourCarte),
      evaluation,
    })
  }
  sections.attente.sort((x, y) => {
    // Un echec de publication passe devant tout (spec §8) ; ensuite le delai
    // restant (demande de Thierry), sans echeance en dernier.
    const ex = x.evaluation.status === 'echec_publication' ? 0 : 1
    const ey = y.evaluation.status === 'echec_publication' ? 0 : 1
    if (ex !== ey) return ex - ey
    const jx = x.evaluation.jours_restants
    const jy = y.evaluation.jours_restants
    if (jx !== jy) return jx === null ? 1 : jy === null ? -1 : jx - jy
    return (URGENCE[x.evaluation.status] ?? 9) - (URGENCE[y.evaluation.status] ?? 9)
  })
  const parDate = (x, y) => String(y._tri || '').localeCompare(String(x._tri || ''))
  sections.recents.sort(parDate)
  sections.anciens.sort(parDate)
  for (const l of Object.values(sections)) for (const c of l) delete c._tri
  return sections
}

module.exports = { assemblerCartes, origineDe, estMasque, ORIGINES, A_FAIRE, JOURS_RECENTS }
