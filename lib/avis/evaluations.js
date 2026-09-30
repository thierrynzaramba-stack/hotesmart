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
    .select('id, cle, libelle, categorie, rempli_par, rang, actif, property_id, avis_criteres_niveaux(cle, libelle, rang, note, recommande, negatif)')
    .eq('user_id', userId)
    .or(`property_id.eq.${propertyId},property_id.is.null`)

  // ⚠ UNE ERREUR DE LECTURE N'EST PAS UNE GRILLE VIDE. Sans ce refus, une
  // panne de base ferait silencieusement basculer l'hote sur la grille par
  // defaut : il croirait evaluer avec ses criteres, et ce seraient les notres.
  if (error) throw new Error(`[avis] grille illisible : ${error.message}`)

  const lignes = (data || []).map(c => ({
    cle: c.cle,
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
  if (evalScope === 'aucun') return []
  return grille.criteres.filter(c => c.rempli_par === 'prestataire' || c.rempli_par === 'les_deux')
}

// ─── La transition de statut (spec §6) ──────────────────────────────────────
// Fonction PURE : c'est la regle la plus lourde de consequence du chantier, et
// elle doit pouvoir etre lue et testee sans base.
//
// ⚠ LE GARDE-FOU DU NEGATIF PASSE AVANT LE POUVOIR. Une prestataire `valider`
// qui coche un point negatif ne publie pas : l'hote tranche (§3).
function deciderStatut ({ role, evalPower = 'soumettre', negatif, completRole, completTotal }) {
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

  // ⚠ ELLE PUBLIE DES QUE SA PART EST FINIE, sans attendre l'hote.
  // C'est la spec §6 (« prestataire valider + non negatif => publication
  // directe ») et la decision de Thierry du 30 septembre 2026. J'avais resserre
  // cela a un formulaire ENTIEREMENT rempli apres une revue qui objectait qu'un
  // avis partiel prive l'hote de la moitie du jugement. L'objection est reelle,
  // la reponse produit est assumee : les criteres reserves a l'hote restent
  // vides, `scores[]` part partiel, et lib/avis/publication.js ne tolere cette
  // absence QUE pour une prestataire.
  if (evalPower === 'valider') {
    return {
      statut: 'a_valider', peutPublier: true,
      motif: completTotal
        ? 'pouvoir valider, avis non negatif, formulaire complet'
        : 'pouvoir valider, avis non negatif — les criteres de l hote restent vides',
    }
  }
  return { statut: 'soumise_prestataire', peutPublier: false, motif: 'la prestataire soumet, l hote valide' }
}

// ─── Enregistrer des reponses ───────────────────────────────────────────────
// Rend { evaluation, decision } ou leve une Error nommee. N'ecrit jamais de
// reponse partielle sous le nom d'un formulaire complet.
async function enregistrerReponses (sb, {
  evaluation, reponses, role, evalScope = 'selon_grille', evalPower = 'soumettre',
  parProfil = null, maintenant = () => new Date(),
} = {}) {
  const e = evaluation || {}
  if (e.status === 'publiee') throw new Error('[avis] cette evaluation est deja publiee')
  if (e.status === 'abandonnee') throw new Error('[avis] cette evaluation a ete abandonnee')
  if (e.status === 'expiree') throw new Error('[avis] le delai de l OTA est passe')

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

  const permis = new Set(criteresPour(grille, role, evalScope).map(c => c.cle))
  for (const cle of Object.keys(reponses || {})) {
    // ⚠ Un role qui repond a un critere qui ne lui est pas ouvert est une
    // erreur nommee, pas une reponse ignoree en silence.
    if (!permis.has(cle)) throw new Error(`[avis] « ${cle} » n est pas ouvert a ce role`)
  }

  // Les reponses des deux roles se cumulent : la prestataire remplit sa part,
  // l'hote complete la sienne.
  const champ = role === 'hote' ? 'answers_host' : 'answers_cleaner'
  const fusion = { ...(e.answers_cleaner || {}), ...(e.answers_host || {}), ...(reponses || {}) }
  const repondu = (c) => fusion[c.cle] !== undefined && fusion[c.cle] !== null
  const completTotal = grille.criteres.every(repondu)
  const ouverts = criteresPour(grille, role, evalScope)
  const completRole = ouverts.length > 0 && ouverts.every(repondu)

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
      throw new Error(`[avis] reponses hors grille : ${err.message}`)
    }
  }

  const decision = deciderStatut({ role, evalPower, negatif, completRole, completTotal })

  const maj = {
    [champ]: { ...(e[champ] || {}), ...(reponses || {}) },
    status: decision.statut,
    updated_at: maintenant().toISOString(),
  }
  if (premier) maj.grille_figee = grille
  if (parProfil) maj.filled_by_profile = parProfil

  const { data, error } = await sb
    .from('guest_evaluations')
    .update(maj)
    .eq('id', e.id)
    .eq('user_id', e.user_id)
    .select()
    .single()
  if (error) throw new Error(`[avis] enregistrement refuse : ${error.message}`)

  return { evaluation: data, decision, grille, negatif, complet: completTotal, completRole }
}

// ─── Abandonner ─────────────────────────────────────────────────────────────
// L'hote choisit de ne pas evaluer. Un statut terminal, jamais rouvert : sans
// cela, une relance automatique ressusciterait une evaluation ecartee a la
// main.
async function abandonner (sb, { evaluation, parProfil = null, maintenant = () => new Date() } = {}) {
  const e = evaluation || {}
  if (e.status === 'publiee') throw new Error('[avis] une evaluation publiee ne s abandonne pas')
  const { data, error } = await sb
    .from('guest_evaluations')
    .update({
      status: 'abandonnee',
      validated_by_profile: parProfil,
      updated_at: maintenant().toISOString(),
    })
    .eq('id', e.id)
    .eq('user_id', e.user_id)
    .select()
    .single()
  if (error) throw new Error(`[avis] abandon refuse : ${error.message}`)
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

module.exports = {
  chargerGrille,
  criteresPour,
  deciderStatut,
  enregistrerReponses,
  abandonner,
  journaliser,
  GRILLE_DEFAUT,
}
