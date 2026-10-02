// lib/avis/evaluations.js
//
// L'ORCHESTRATION D'UNE EVALUATION : charger la grille de l'hote, enregistrer
// les reponses, figer la grille au premier remplissage, decider du statut
// suivant. La publication elle-meme vit dans ./publication.js, la redaction
// dans ./redaction.js, le calcul des notes dans ./notes-evaluation.js.
//
// Ce module tient la partie que les trois autres ne peuvent pas tenir : ce qui
// touche a la BASE, et la transition de statut (spec §6).
//
// Spec docs/specs/spec-evaluation-voyageur.md §4.4, §6.

const { GRILLE_DEFAUT, grilleDe, estNegatif, validerGrille } = require('./notes-evaluation')

// ─── La grille de ce bien ───────────────────────────────────────────────────
// Le bien surcharge le compte ; sans critere ni a l'un ni a l'autre, c'est la
// grille par defaut du code — JAMAIS pre-inseree en base (decision de Thierry
// du 30 septembre 2026 : pas de seed de masse sur 30 000 comptes).
async function chargerGrille (sb, { userId, propertyId }) {
  const { data, error } = await sb
    .from('avis_criteres')
    // ⚠ LA RELATION EST NOMMEE, ET ELLE DOIT L'ETRE. Deux cles etrangeres
    // relient les niveaux aux criteres : la simple sur `critere_id`, et la
    // COMPOSITE `(critere_id, categorie)` qui empeche un niveau de contredire la
    // categorie de son critere. PostgREST refuse alors de choisir et rend
    // « more than one relationship was found » — que `chargerGrille` traduit,
    // a juste titre, en « grille illisible » : plus aucune grille d'hote ne se
    // chargeait.
    //
    // Trouve par scripts/prouver-parcours-avis.js sur la base STAGING. Aucun
    // test unitaire ne pouvait le voir : leur double de base n'execute pas de
    // SQL, ce que la review du lot 3 avait justement releve.
    //
    // On suit la composite : c'est elle qui porte le sens.
    .select('id, libelle, categorie, rempli_par, rang, actif, property_id, '
      + 'avis_criteres_niveaux!avis_niveaux_categorie_fk(cle, libelle, rang, note, recommande, negatif)')
    .eq('user_id', userId)
    .or(`property_id.eq.${propertyId},property_id.is.null`)

  // ⚠ UNE ERREUR DE LECTURE N'EST PAS UNE GRILLE VIDE. Sans ce refus, une
  // panne de base ferait silencieusement basculer l'hote sur la grille par
  // defaut : il croirait evaluer avec ses criteres, et ce seraient les notres.
  if (error) throw new Error(`[avis] grille illisible : ${error.message}`)

  // ⚠ LA CLE D'UN CRITERE EST SON IDENTIFIANT EN BASE, et la table n'a pas de
  // colonne `cle` — la spec §4.1 ne lui en donne pas. La requete en demandait
  // une : PostgREST rendait « column avis_criteres.cle does not exist », que
  // `chargerGrille` traduisait en « grille illisible ». Aucune grille d'hote ne
  // se chargeait. Trouve par scripts/prouver-parcours-avis.js sur STAGING.
  //
  // L'identifiant est le bon choix : il est unique, et il ne change JAMAIS —
  // ce que §4.4 exige d'une cle, puisque les reponses deja cochees s'y
  // referent. Consequence voulue : un critere invente par l'hote ne peut pas
  // usurper les tags d'un critere de la grille par defaut, sa cle etant un uuid.
  const lignes = (data || []).map(c => ({
    cle: c.id,
    libelle: c.libelle,
    categorie: c.categorie,
    rempli_par: c.rempli_par,
    rang: c.rang,
    actif: c.actif,
    property_id: c.property_id,
    niveaux: [...(c.avis_criteres_niveaux || [])].sort((a, b) => (a.rang || 0) - (b.rang || 0)),
  }))

  return grilleDe({
    duBien: lignes.filter(c => c.property_id === propertyId),
    duCompte: lignes.filter(c => !c.property_id),
  })
}

// ─── Ce que la prestataire a le droit de remplir ────────────────────────────
// eval_scope vaut `aucun` ou `selon_grille` (§4.6). `selon_grille` veut dire :
// les criteres que la grille elle-meme marque `rempli_par` prestataire ou les
// deux. Ce n'est plus une liste de categories en dur.
function criteresPour (grille, role, evalScope) {
  if (role === 'hote') return grille.criteres
  // ⚠ LA MEME REGLE QUE LA LECTURE ET LA PUBLICATION : seule `selon_grille`
  // ouvre quelque chose. Constat de re-revue : `!== 'aucun'` laissait une
  // valeur heritee (`proprete`, `complet`, encore admises par le CHECK) remplir,
  // declencher la redaction payante et recevoir le texte, alors que la lecture
  // et la publication la refusaient.
  if (evalScope !== 'selon_grille') return []
  return grille.criteres.filter(c => c.rempli_par === 'prestataire' || c.rempli_par === 'les_deux')
}

// ─── La transition de statut (spec §6) ──────────────────────────────────────
// Fonction PURE : c'est la regle la plus lourde de consequence du chantier, et
// elle doit pouvoir etre lue et testee sans base.
//
// ⚠ LE GARDE-FOU DU NEGATIF PASSE AVANT LE POUVOIR. Une prestataire `valider`
// qui coche un point negatif ne publie pas : l'hote tranche (§3).
// L'hote a-t-il repondu a au moins une question ? (option B, 2 octobre 2026)
function hoteARepondu (evaluation) {
  const h = (evaluation && evaluation.answers_host) || {}
  return Object.keys(h).some(k => h[k] !== undefined && h[k] !== null && h[k] !== '')
}

function deciderStatut ({ role, evalPower = 'soumettre', negatif, completRole, completTotal, hoteARepondu: hoteAJoue = false }) {
  if (role === 'hote') {
    if (!completTotal) return { statut: 'a_remplir', peutPublier: false, motif: 'formulaire incomplet' }
    return { statut: 'a_valider', peutPublier: true, motif: 'l hote valide lui-meme' }
  }

  // ⚠ LA PRESTATAIRE A FINI QUAND SA PART EST FINIE, PAS QUAND TOUT L'EST.
  // Constat de review : `complet` etait calcule sur TOUS les criteres de la
  // grille, y compris ceux que `criteresPour` interdit a la prestataire — et
  // auxquels repondre LEVE. Une prestataire qui cochait 100 % de ce qu'elle a
  // le droit de cocher retombait donc en `a_remplir`. Le statut
  // `soumise_prestataire` de la spec §6 etait inatteignable, l'hote ne
  // recevait aucun signal, et les branches `eval_power` ci-dessous etaient du
  // code mort.
  if (!completRole) return { statut: 'a_remplir', peutPublier: false, motif: 'la prestataire n a pas fini sa part' }

  // ⚠ LE GARDE-FOU DU NEGATIF PASSE AVANT LE POUVOIR. Une prestataire
  // `valider` qui coche un point negatif ne publie pas : l'hote tranche (§3).
  if (negatif) return { statut: 'a_valider', peutPublier: false, motif: 'avis negatif : l hote tranche, quel que soit le pouvoir' }

  // ⚠ OPTION B (decision de Thierry du 2 octobre 2026) : DES QUE L'HOTE A AJOUTE
  // UNE REPONSE, LA PUBLICATION LUI REVIENT. La prestataire ne publie seule que
  // ce qu'elle a entierement rempli — une grille « couverte » par les reponses
  // de l'hote n'est pas la sienne.
  // Une prestataire « soumettre » garde son chemin ordinaire (`soumise_prestataire`).
  if (hoteAJoue && evalPower === 'valider') return { statut: 'a_valider', peutPublier: false, motif: 'l hote a repondu : la publication lui revient' }

  // ⚠ ELLE NE PUBLIE QUE SI SES CRITERES COUVRENT TOUTE LA GRILLE DU BIEN.
  // Decision de Thierry du 30 septembre 2026, qui tranche un aller-retour. La
  // spec §6 promet a une prestataire « valider » une publication directe ; j'en
  // avais deduit qu'elle pouvait partir sur sa seule part. Refuse : jamais de
  // publication partielle chez Airbnb.
  //
  // Sa part faite, deux issues. Si la grille du bien ne contient QUE des
  // criteres qui lui sont ouverts, elle publie — c'est le cas d'un hote qui a
  // confie toute l'evaluation a sa prestataire. Sinon l'evaluation passe a
  // l'hote, avec le texte deja redige, et c'est lui qui tranche.
  if (evalPower === 'valider') {
    if (completTotal) {
      return { statut: 'a_valider', peutPublier: true, motif: 'pouvoir valider, avis non negatif, grille entierement couverte' }
    }
    return {
      statut: 'a_valider', peutPublier: false,
      motif: 'sa part est faite, mais des criteres de l hote restent vides : l hote tranche',
    }
  }
  return { statut: 'soumise_prestataire', peutPublier: false, motif: 'la prestataire soumet, l hote valide' }
}

// ─── Enregistrer des reponses ───────────────────────────────────────────────
// Rend { evaluation, decision } ou leve une Error nommee. N'ecrit jamais de
// reponse partielle sous le nom d'un formulaire complet.
async function enregistrerReponses (sb, {
  evaluation, reponses, role, evalScope = 'aucun', evalPower = 'soumettre',
  parProfil = null, maintenant = () => new Date(), autoValidationHeures = null,
} = {}) {
  const e = evaluation || {}
  if (e.status === 'publiee') throw new Error('[avis] cette évaluation est déjà publiée')
  if (e.status === 'abandonnee') throw new Error('[avis] cette évaluation a été abandonnée')
  if (e.status === 'expiree') throw new Error('[avis] le délai de la plateforme est passé')
  if (e.status === 'evaluee_ailleurs') throw new Error('[avis] cette évaluation a déjà été faite sur Airbnb')

  // ⚠ LA GRILLE SE FIGE AU PREMIER REMPLISSAGE, ET PLUS JAMAIS APRES (§4.4).
  // Si l'hote modifie sa grille entre la saisie de la prestataire et sa propre
  // validation, les reponses deja cochees doivent garder leur sens.
  let grille = e.grille_figee && e.grille_figee.criteres && e.grille_figee.criteres.length
    ? e.grille_figee
    : null
  const premier = !grille
  if (premier) {
    grille = await chargerGrille(sb, { userId: e.user_id, propertyId: e.property_id })
    validerGrille(grille)
  }

  // ⚠ UNE PRESTATAIRE NON AUTORISEE N'ECRIT RIEN, pas meme des reponses vides.
  // Constat de re-revue : `reponses: {}` passait la boucle ci-dessous (aucune
  // cle a refuser), et l'ecriture qui suit faisait regresser une evaluation
  // `a_valider` de l'hote en `a_remplir`, a son nom.
  if (role !== 'hote' && evalScope !== 'selon_grille') {
    throw new Error('[avis] cette prestataire n’est pas autorisée à participer aux évaluations')
  }
  if (!Object.keys(reponses || {}).length) throw new Error('[avis] aucune réponse à enregistrer')

  const permis = new Set(criteresPour(grille, role, evalScope).map(c => c.cle))
  for (const cle of Object.keys(reponses || {})) {
    // ⚠ Un role qui repond a un critere qui ne lui est pas ouvert est une
    // erreur nommee, pas une reponse ignoree en silence.
    if (!permis.has(cle)) throw new Error(`[avis] « ${cle} » n’est pas ouvert à ce rôle`)
  }

  // Les reponses des deux roles se cumulent : la prestataire remplit sa part,
  // l'hote complete la sienne.
  const champ = role === 'hote' ? 'answers_host' : 'answers_cleaner'
  const fusion = { ...(e.answers_cleaner || {}), ...(e.answers_host || {}), ...(reponses || {}) }
  const repondu = (c) => fusion[c.cle] !== undefined && fusion[c.cle] !== null
  const completTotal = grille.criteres.every(repondu)
  const ouverts = criteresPour(grille, role, evalScope)
  const completRole = ouverts.length > 0 && ouverts.every(repondu)
  const avant = { ...(e.answers_cleaner || {}), ...(e.answers_host || {}) }
  const completRoleAvant = ouverts.length > 0 && ouverts.every(c => avant[c.cle] !== undefined && avant[c.cle] !== null)

  // ⚠ LE NEGATIF SE JUGE SUR CE QUI EST DEJA REPONDU, pas seulement sur un
  // formulaire complet. Un « tres sale » coche par la prestataire doit
  // declencher le garde-fou tout de suite, sans attendre que l'hote ait rempli
  // sa part : c'est lui qui devra trancher, autant que le statut le dise des
  // maintenant. `estNegatif` exige toutes les reponses de la grille qu'on lui
  // donne, on lui donne donc la sous-grille des criteres repondus.
  const remplis = { criteres: grille.criteres.filter(repondu) }
  let negatif = false
  if (remplis.criteres.length) {
    try {
      negatif = estNegatif(fusion, remplis)
    } catch (err) {
      throw new Error(`[avis] réponses hors grille : ${err.message}`)
    }
  }

  const decision = deciderStatut({
    role, evalPower, negatif, completRole, completTotal,
    // Les reponses de l'hote APRES cet enregistrement : les siennes s'il ecrit.
    hoteARepondu: role === 'hote' ? true : hoteARepondu(evaluation),
  })

  const maj = {
    [champ]: { ...(e[champ] || {}), ...(reponses || {}) },
    status: decision.statut,
    updated_at: maintenant().toISOString(),
  }
  if (premier) maj.grille_figee = grille
  if (parProfil) maj.filled_by_profile = parProfil

  // ─── L'horloge de l'auto-validation (spec §10 bis) ─────────────────────────
  // ⚠ TOUTE REPONSE DE L'HOTE L'ARRETE ; un negatif aussi — il attend l'hote.
  // Elle ne PART qu'une fois : au moment ou la prestataire termine sa part, sans
  // negatif, sans reponse de l'hote. Re-enregistrer les memes reponses ne la
  // relance pas, et une evaluation que l'hote a deja reprise ne se reprogramme
  // pas toute seule.
  if (role === 'hote' || negatif) {
    if (e.auto_publier_le) maj.auto_publier_le = null
  } else if (completRole && (!completRoleAvant || (negatifAvant(e, grille) && !e.public_text)) && !hoteARepondu(e) && autoValidationHeures && !e.auto_publier_le) {
    const { echeanceAuto } = require('./auto-validation')
    const quand = echeanceAuto({ maintenant: maintenant().getTime(), heures: autoValidationHeures, deadline: e.deadline_at })
    if (quand) maj.auto_publier_le = quand
  }

  const { data, error } = await sb
    .from('guest_evaluations')
    .update(maj)
    .eq('id', e.id)
    .eq('user_id', e.user_id)
    .select()
    .single()
  if (error) throw new Error(`[avis] enregistrement refusé : ${error.message}`)

  return { evaluation: data, decision, grille, negatif, complet: completTotal, completRole }
}

// La part d'avant etait-elle negative ? (recette du 2 octobre 2026 : une
// prestataire qui corrige un negatif en positif doit armer l'horloge — sa part
// etait deja complete, la regle « une seule fois » l'oubliait.)
// ⚠ SEULEMENT SI AUCUN TEXTE N'EXISTE (constat de securite de la revue de
// 5f6a82f) : un negatif n'est jamais redige automatiquement, donc un texte
// present est la trace d'un hote qui l'a demande — il a repris l'evaluation,
// et son texte ne part pas sans lui. Exception sans danger : un texte redige
// quand l'avis etait encore positif survit a un passage par le negatif, et
// bloque alors le rearmement a tort — on publie moins, jamais plus. Une
// tentative de l'hote qui ne laisse AUCUNE trace (redaction refusee) n'arrete
// pas l'horloge : le moteur redige alors lui-meme, sur des reponses positives.
function negatifAvant (e, grille) {
  const avant = { ...(e.answers_cleaner || {}), ...(e.answers_host || {}) }
  const remplis = { criteres: (grille.criteres || []).filter(c => avant[c.cle] !== undefined && avant[c.cle] !== null) }
  if (!remplis.criteres.length) return false
  try { return estNegatif(avant, remplis) } catch { return false }
}

// ─── Abandonner ─────────────────────────────────────────────────────────────
// L'hote choisit de ne pas evaluer. Un statut terminal, jamais rouvert : sans
// cela, une relance automatique ressusciterait une evaluation ecartee a la
// main.
async function abandonner (sb, { evaluation, parProfil = null, maintenant = () => new Date() } = {}) {
  const e = evaluation || {}
  if (e.status === 'publiee') throw new Error('[avis] une évaluation publiée ne s’abandonne pas')
  const { data, error } = await sb
    .from('guest_evaluations')
    .update({
      status: 'abandonnee',
      validated_by_profile: parProfil,
      auto_publier_le: null,
      updated_at: maintenant().toISOString(),
    })
    .eq('id', e.id)
    .eq('user_id', e.user_id)
    .select()
    .single()
  if (error) throw new Error(`[avis] abandon refusé : ${error.message}`)
  return data
}

// ─── L'evenement du coeur ───────────────────────────────────────────────────
// ⚠ L'ECHEC D'ECRITURE DE L'EVENEMENT NE FAIT PAS ECHOUER LA PUBLICATION :
// l'avis est deja parti chez l'OTA, on ne peut pas le reprendre. Mais il ne
// disparait pas non plus : il remonte a l'appelant, qui le journalise.
async function journaliser (sb, { userId, type, sujet, charge = {} }) {
  const { error } = await sb.from('core_events').insert({
    user_id: userId,
    type,
    subject_type: 'guest_evaluation',
    subject_id: sujet,
    payload: charge,
  })
  return error ? { ok: false, erreur: error.message } : { ok: true }
}

// ─── « Deja evaluee sur Airbnb » (spec §6) ──────────────────────────────────
// L'hote l'a ecrite dans l'application Airbnb : rien ne nous en parvient, c'est
// donc lui qui la range. Etat terminal, comme l'abandon.
async function marquerEvalueeAilleurs (sb, { evaluation, parProfil = null, maintenant = () => new Date() } = {}) {
  const e = evaluation || {}
  if (['publiee', 'expiree', 'abandonnee', 'evaluee_ailleurs'].includes(e.status)) {
    throw new Error('[avis] cette évaluation est déjà close')
  }
  const { data, error } = await sb.from('guest_evaluations')
    .update({ status: 'evaluee_ailleurs', auto_publier_le: null, validated_by_profile: parProfil, updated_at: maintenant().toISOString() })
    .eq('id', e.id).eq('user_id', e.user_id)
    // Garde en base : une publication concurrente qui a ecrit `publiee` gagne.
    .in('status', ['a_remplir', 'soumise_prestataire', 'a_valider', 'echec_publication'])
    .select().single()
  if (error) throw new Error(`[avis] rangement refusé : ${error.message}`)
  return data
}

module.exports = {
  hoteARepondu,
  marquerEvalueeAilleurs,
  chargerGrille,
  criteresPour,
  deciderStatut,
  enregistrerReponses,
  abandonner,
  journaliser,
  GRILLE_DEFAUT,
}
