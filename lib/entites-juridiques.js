// lib/entites-juridiques.js — WRITER UNIQUE des entites juridiques.
// Spec : docs/specs/spec-facture-voyageur.md §5.1 et §5.2
// KB   : docs/kb/entites-juridiques.md (modif = MEME COMMIT)
//
// Une entite juridique = une identite legale d'un compte : l'hote en nom
// propre, une SCI, une societe. Elle emet les factures du voyageur et porte
// les charges du compte (chantier « compte de charges ») : UNE table, partagee
// (decision de Thierry du 8 novembre 2026).
//
// ⚠ CE MODULE NE GARDE RIEN. Il n'a ni session ni droits : c'est l'endpoint
// appelant qui garde (domaine `facturation`, ecriture reservee au titulaire,
// lecture selon `peutLire`). Il recoit un `userId` DEJA VERIFIE — le compte
// cible — et n'ecrit jamais que sur ce compte.
//
// ⚠ UNE PANNE N'EST PAS UNE ABSENCE. Chaque lecture rend `{ ok: false, motif:
// 'panne' }` sur erreur Supabase, jamais une liste vide : « aucune entite »
// bloquerait une facture avec le mauvais motif.
//
// ⚠ UN COMPTE PEUT N'AVOIR AUCUNE ENTITE (Thierry, 8 nov. 2026, reponse A).
// Rien ici n'en cree une a la place du titulaire.

function client () {
  return require('./cron-shared').supabase
}

const TYPES = ['personne_physique', 'societe']
const REGIMES = ['exonere', 'franchise', 'assujetti']
// Numerotation des factures (Thierry, 9 nov. 2026) : automatique, ou manuelle
// (l'hote saisit chaque numero parce qu'il facture aussi ailleurs).
const NUMEROTATIONS = ['auto', 'manuel']

// Les colonnes rendues. `user_id` n'en fait pas partie : le compte est connu
// de l'appelant, inutile de le renvoyer au navigateur.
const CHAMPS = 'id, type, forme_juridique, nom, adresse_ligne1, adresse_ligne2, ' +
  'code_postal, ville, pays, siret, tva_intracom, regime_tva, taux_tva, capital, ' +
  'rcs, email, telephone, debut_exercice, numerotation_factures, par_defaut, archivee_le, cree_le, modifie_le'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Aucun caractere de controle dans un texte imprime sur une facture.
const CONTROLE_RE = /[\u0000-\u001f\u007f]/

const refus = (motif, champ = null) => ({ ok: false, motif, ...(champ ? { champ } : {}) })
const panne = (contexte, error) => {
  console.error(`[entites-juridiques] ${contexte}`, error && error.message)
  return { ok: false, motif: 'panne' }
}

// Un texte facultatif : vide -> null, trop long ou avec un caractere de
// controle -> refus. Rend { valeur } ou { erreur: true }.
function texte (v, max) {
  if (v === undefined || v === null) return { valeur: null }
  if (typeof v !== 'string' && typeof v !== 'number') return { erreur: true }
  const s = String(v).trim()
  if (!s) return { valeur: null }
  if (s.length > max || CONTROLE_RE.test(s)) return { erreur: true }
  return { valeur: s }
}

// Le taux de TVA tel que l'hote le tape : « 10 », « 5,5 », 20. Deux decimales
// au plus, strictement entre 0 et 100.
function taux (v) {
  if (v === undefined || v === null || v === '') return null
  const n = Number(String(v).replace(',', '.').trim())
  if (!Number.isFinite(n) || n <= 0 || n >= 100) return NaN
  if (Math.round(n * 100) !== n * 100) return NaN
  return n
}

// « MM-JJ » d'un jour qui existe chaque annee : le 29 fevrier est refuse, un
// exercice ne peut pas commencer un jour absent trois ans sur quatre.
const JOURS_DU_MOIS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
function dateDeMoisValide (s) {
  const m = /^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/.exec(s)
  return !!m && Number(m[2]) <= JOURS_DU_MOIS[Number(m[1]) - 1]
}

/**
 * Valide une entite telle que l'envoie l'ecran. Ne fait AUCUNE confiance au
 * client. Rend { ok: true, entite } (colonnes a ecrire) ou { ok: false, motif,
 * champ }.
 */
function validerEntite (brut) {
  const b = brut && typeof brut === 'object' ? brut : {}
  const e = {}

  if (!TYPES.includes(b.type)) return refus('entree_invalide', 'type')
  e.type = b.type

  const champsTexte = [
    ['nom', 200, true], ['forme_juridique', 60], ['adresse_ligne1', 200],
    ['adresse_ligne2', 200], ['code_postal', 20], ['ville', 120],
    ['capital', 60], ['rcs', 120]
  ]
  for (const [champ, max, requis] of champsTexte) {
    const t = texte(b[champ], max)
    if (t.erreur || (requis && !t.valeur)) return refus('entree_invalide', champ)
    e[champ] = t.valeur
  }

  const pays = texte(b.pays, 2)
  if (pays.erreur) return refus('entree_invalide', 'pays')
  e.pays = (pays.valeur || 'FR').toUpperCase()
  if (!/^[A-Z]{2}$/.test(e.pays)) return refus('entree_invalide', 'pays')

  // SIRET : 14 chiffres ; les espaces et points de saisie sont retires.
  const siret = texte(b.siret, 30)
  if (siret.erreur) return refus('entree_invalide', 'siret')
  e.siret = siret.valeur ? siret.valeur.replace(/[\s.]/g, '') : null
  if (e.siret !== null && !/^[0-9]{14}$/.test(e.siret)) return refus('entree_invalide', 'siret')

  const tva = texte(b.tva_intracom, 30)
  if (tva.erreur) return refus('entree_invalide', 'tva_intracom')
  e.tva_intracom = tva.valeur ? tva.valeur.replace(/\s/g, '').toUpperCase() : null
  if (e.tva_intracom !== null && !/^[A-Z]{2}[0-9A-Z]{2,13}$/.test(e.tva_intracom)) {
    return refus('entree_invalide', 'tva_intracom')
  }

  // Le regime de TVA (Q4) : trois choix ; un taux si et seulement si assujetti,
  // regle par l'hote lui-meme.
  if (!REGIMES.includes(b.regime_tva)) return refus('entree_invalide', 'regime_tva')
  e.regime_tva = b.regime_tva
  if (e.regime_tva === 'assujetti') {
    const t = taux(b.taux_tva)
    if (t === null || Number.isNaN(t)) return refus('entree_invalide', 'taux_tva')
    e.taux_tva = t
  } else {
    e.taux_tva = null
  }

  const email = texte(b.email, 200)
  if (email.erreur || (email.valeur && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.valeur))) {
    return refus('entree_invalide', 'email')
  }
  e.email = email.valeur

  const tel = texte(b.telephone, 40)
  if (tel.erreur || (tel.valeur && !/^[0-9 +().-]{4,40}$/.test(tel.valeur))) {
    return refus('entree_invalide', 'telephone')
  }
  e.telephone = tel.valeur

  // Le debut de l'exercice comptable (« MM-JJ »), VIDE POSSIBLE, sans defaut :
  // on ne suppose pas une annee civile a la place de l'hote (Thierry, 8 nov.
  // 2026, 22 h 50). Lu par le compte de charges pour presenter ses totaux par
  // exercice — rien n'est purge (Thierry, 22 h 53 : « on garde tout »).
  const ex = texte(b.debut_exercice, 5)
  if (ex.erreur) return refus('entree_invalide', 'debut_exercice')
  e.debut_exercice = ex.valeur
  if (e.debut_exercice !== null && !dateDeMoisValide(e.debut_exercice)) {
    return refus('entree_invalide', 'debut_exercice')
  }

  // La numerotation : absente -> automatique (le defaut de la base) ; une
  // autre valeur est refusee.
  const num = b.numerotation_factures === undefined || b.numerotation_factures === null || b.numerotation_factures === ''
    ? 'auto' : b.numerotation_factures
  if (!NUMEROTATIONS.includes(num)) return refus('entree_invalide', 'numerotation_factures')
  e.numerotation_factures = num

  return { ok: true, entite: e }
}

// ─── Lectures (exposees au chantier compte de charges) ───────────────────────

/** Les entites du compte, ARCHIVEES COMPRISES, de la plus ancienne a la plus recente. */
async function entitesDuCompte (userId, { db = client() } = {}) {
  const { data, error } = await db.from('entites_juridiques')
    .select(CHAMPS).eq('user_id', userId).order('cree_le', { ascending: true })
  if (error) return panne('lecture des entites', error)
  return { ok: true, entites: data || [] }
}

async function entiteDuCompte (userId, id, { db = client() } = {}) {
  if (!UUID_RE.test(String(id || ''))) return { ok: true, entite: null }
  const { data, error } = await db.from('entites_juridiques')
    .select(CHAMPS).eq('user_id', userId).eq('id', id).maybeSingle()
  if (error) return panne('lecture d\'une entite', error)
  return { ok: true, entite: data || null }
}

/**
 * L'entite qui vaut pour un bien : sa ligne `biens_entites`, sinon l'entite
 * par defaut du compte, sinon `null`. Rendue MEME ARCHIVEE, avec sa provenance
 * (`bien` ou `defaut`) : c'est l'appelant qui decide — la facture refuse une
 * entite archivee (spec §4 bis, P4).
 */
async function entiteDuBien (userId, propertyUuid, { db = client() } = {}) {
  if (!UUID_RE.test(String(propertyUuid || ''))) return { ok: true, entite: null, provenance: null }
  const { data: lien, error: errLien } = await db.from('biens_entites')
    .select('entite_id').eq('user_id', userId).eq('property_uuid', propertyUuid).maybeSingle()
  if (errLien) return panne('lecture du lien bien -> entite', errLien)
  if (lien) {
    const r = await entiteDuCompte(userId, lien.entite_id, { db })
    if (!r.ok) return r
    return { ok: true, entite: r.entite, provenance: r.entite ? 'bien' : null }
  }
  const { data: defaut, error } = await db.from('entites_juridiques')
    .select(CHAMPS).eq('user_id', userId).eq('par_defaut', true).maybeSingle()
  if (error) return panne('lecture de l\'entite par defaut', error)
  return { ok: true, entite: defaut || null, provenance: defaut ? 'defaut' : null }
}

/** Les liens bien -> entite du compte. */
async function liensDuCompte (userId, { db = client() } = {}) {
  const { data, error } = await db.from('biens_entites')
    .select('property_uuid, entite_id').eq('user_id', userId)
  if (error) return panne('lecture des liens', error)
  return { ok: true, liens: data || [] }
}

// ─── Ecritures (le titulaire seul, garanti par l'endpoint) ───────────────────

/** L'entite par defaut, en UNE transaction (fonction SQL). */
async function definirDefaut (userId, id, { db = client() } = {}) {
  if (!UUID_RE.test(String(id || ''))) return refus('introuvable')
  const { data, error } = await db.rpc('entite_definir_defaut', { p_user_id: userId, p_entite_id: id })
  if (error) return panne('entite par defaut', error)
  if (data !== true) return refus('introuvable')
  return { ok: true }
}

/**
 * Cree une entite. La PREMIERE entite active du compte devient celle par
 * defaut : c'est l'identite du compte (decision D2). Une autre ne le devient
 * que sur demande (`par_defaut: true`).
 */
async function creer (userId, brut, { db = client() } = {}) {
  const v = validerEntite(brut)
  if (!v.ok) return v
  const { data: actives, error: errL } = await db.from('entites_juridiques')
    .select('id, par_defaut').eq('user_id', userId).is('archivee_le', null)
  if (errL) return panne('lecture avant creation', errL)
  const { data, error } = await db.from('entites_juridiques')
    .insert({ ...v.entite, user_id: userId, par_defaut: false }).select('id').single()
  if (error) return panne('creation', error)
  // ⚠ « AUCUNE ENTITE ACTIVE », PAS « AUCUNE PAR DEFAUT » (constat 3 de la
  // revue de 447ff3e0). A par defaut et B active ; A archivee, puis C creee :
  // tester l'absence de defaut faisait de C l'emetteur de TOUS les logements
  // sans lien — peut-etre une societe creee pour un seul. Sans defaut, une
  // facture est refusee avec son motif (P4), et le titulaire choisit.
  const premiere = !(actives || []).length
  if (premiere || (brut && brut.par_defaut === true)) {
    const d = await definirDefaut(userId, data.id, { db })
    if (!d.ok) return d
  }
  return entiteDuCompte(userId, data.id, { db })
}

/** Remplace les champs d'une entite active. Une entite archivee ne se modifie plus. */
async function modifier (userId, id, brut, { db = client() } = {}) {
  const lue = await entiteDuCompte(userId, id, { db })
  if (!lue.ok) return lue
  if (!lue.entite) return refus('introuvable')
  if (lue.entite.archivee_le) return refus('archivee')
  const v = validerEntite(brut)
  if (!v.ok) return v
  const { error } = await db.from('entites_juridiques')
    .update({ ...v.entite, modifie_le: new Date().toISOString() })
    .eq('user_id', userId).eq('id', id).is('archivee_le', null)
  if (error) return panne('modification', error)
  return entiteDuCompte(userId, id, { db })
}

/**
 * Archive une entite : on ne supprime jamais, des factures et des charges y
 * renvoient. Elle cesse d'etre celle par defaut. Ses liens aux biens restent :
 * une facture sur un tel bien est refusee avec son motif (P4) jusqu'a ce que
 * le titulaire rattache le bien a une autre entite.
 */
async function archiver (userId, id, { db = client() } = {}) {
  const lue = await entiteDuCompte(userId, id, { db })
  if (!lue.ok) return lue
  if (!lue.entite) return refus('introuvable')
  if (lue.entite.archivee_le) return { ok: true, deja: true }
  const { error } = await db.from('entites_juridiques')
    .update({ archivee_le: new Date().toISOString(), par_defaut: false, modifie_le: new Date().toISOString() })
    .eq('user_id', userId).eq('id', id).is('archivee_le', null)
  if (error) return panne('archivage', error)
  return { ok: true }
}

/**
 * Rattache un bien a une entite du compte, ou le rend a l'entite par defaut
 * (`entiteId` null). Le bien et l'entite doivent etre du compte ; l'entite,
 * active. La base le garantit aussi (cle composite + trigger) : ce controle-ci
 * donne le bon motif avant l'erreur SQL.
 */
async function rattacherBien (userId, propertyUuid, entiteId, { db = client() } = {}) {
  if (!UUID_RE.test(String(propertyUuid || ''))) return refus('introuvable')
  const { data: bien, error: errB } = await db.from('properties')
    .select('id, user_id').eq('id', propertyUuid).eq('user_id', userId).maybeSingle()
  if (errB) return panne('lecture du bien', errB)
  if (!bien) return refus('introuvable')

  if (entiteId === null || entiteId === undefined || entiteId === '') {
    const { error } = await db.from('biens_entites')
      .delete().eq('user_id', userId).eq('property_uuid', propertyUuid)
    if (error) return panne('retrait du lien', error)
    return { ok: true, entite_id: null }
  }
  const lue = await entiteDuCompte(userId, entiteId, { db })
  if (!lue.ok) return lue
  if (!lue.entite) return refus('introuvable')
  if (lue.entite.archivee_le) return refus('archivee')
  const { error } = await db.from('biens_entites')
    .upsert({ property_uuid: propertyUuid, entite_id: entiteId, user_id: userId, modifie_le: new Date().toISOString() },
      { onConflict: 'property_uuid' })
  if (error) return panne('rattachement', error)
  return { ok: true, entite_id: entiteId }
}

// ─── La numerotation (Q5) ────────────────────────────────────────────────────

const PREFIXE_DEFAUT = 'F'

/** L'annee d'Europe/Paris : le 1er janvier a 00 h 30 est deja l'annee nouvelle. */
function anneeParis (maintenant = new Date()) {
  return Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric' }).format(maintenant))
}

/** `F-2026-0001` : le format de Q5. */
function formaterNumero (prefixe, annee, n) {
  return `${prefixe}-${annee}-${String(n).padStart(4, '0')}`
}

/** La suite de l'annee pour une entite ; ses valeurs par defaut si elle n'existe pas encore. */
async function numerotation (userId, entiteId, { db = client(), maintenant = new Date() } = {}) {
  const annee = anneeParis(maintenant)
  if (!UUID_RE.test(String(entiteId || ''))) return refus('introuvable')
  const { data, error } = await db.from('factures_voyageur_suites')
    .select('prefixe, prochain_numero, dernier_emis, annee')
    .eq('user_id', userId).eq('entite_id', entiteId).eq('annee', annee).maybeSingle()
  if (error) return panne('lecture de la numerotation', error)
  let s = data
  if (!s) {
    // ⚠ LE PREFIXE SURVIT AU 1er JANVIER (constat 4 de la revue de 447ff3e0).
    // La ligne de l'annee nouvelle n'existe pas encore : sans ce repli, un
    // prefixe « SCI » regle en 2026 redevenait « F » en 2027. Le numero, lui,
    // repart a 1.
    const { data: avant, error: errAvant } = await db.from('factures_voyageur_suites')
      .select('prefixe, annee').eq('user_id', userId).eq('entite_id', entiteId)
      .order('annee', { ascending: false }).limit(1)
    if (errAvant) return panne('lecture de la numerotation precedente', errAvant)
    const precedent = (avant || []).find(r => r.annee < annee)
    s = { prefixe: precedent ? precedent.prefixe : PREFIXE_DEFAUT, prochain_numero: 1, dernier_emis: null, annee }
  }
  return {
    ok: true,
    // `fige` : une facture est deja partie cette annee, la suite enchaine seule.
    suite: { ...s, fige: s.dernier_emis !== null, prochain: formaterNumero(s.prefixe, s.annee, s.prochain_numero) }
  }
}

/**
 * Regle le prefixe et le prochain numero de l'annee (Q5), pour reprendre une
 * suite commencee ailleurs — TANT QU'AUCUNE FACTURE N'EST PARTIE CETTE ANNEE.
 * Ensuite la suite est figee : HoteSmart enchaine, sans trou (Thierry, 9 nov.
 * 2026 ; l'hote qui facture aussi ailleurs choisit la numerotation manuelle).
 * La base porte la meme regle (trigger `fvs_suite_protegee`) : ce controle-ci
 * donne le motif.
 */
async function reglerNumerotation (userId, entiteId, brut, { db = client(), maintenant = new Date() } = {}) {
  const b = brut && typeof brut === 'object' ? brut : {}
  const prefixe = typeof b.prefixe === 'string' ? b.prefixe.trim() : ''
  if (!/^[A-Za-z0-9]{1,12}$/.test(prefixe)) return refus('entree_invalide', 'prefixe')
  const prochain = Number(b.prochain_numero)
  if (!Number.isInteger(prochain) || prochain < 1 || prochain > 999999) {
    return refus('entree_invalide', 'prochain_numero')
  }
  const lue = await entiteDuCompte(userId, entiteId, { db })
  if (!lue.ok) return lue
  if (!lue.entite) return refus('introuvable')
  if (lue.entite.archivee_le) return refus('archivee')

  const actuelle = await numerotation(userId, entiteId, { db, maintenant })
  if (!actuelle.ok) return actuelle
  const s = actuelle.suite
  if (s.dernier_emis !== null) return refus('suite_figee')
  const { error } = await db.from('factures_voyageur_suites')
    .upsert({ entite_id: entiteId, user_id: userId, annee: s.annee, prefixe, prochain_numero: prochain,
      modifie_le: new Date().toISOString() }, { onConflict: 'entite_id,annee' })
  if (error) return panne('reglage de la numerotation', error)
  return numerotation(userId, entiteId, { db, maintenant })
}

module.exports = {
  TYPES, REGIMES, NUMEROTATIONS, CHAMPS, PREFIXE_DEFAUT,
  validerEntite, entitesDuCompte, entiteDuCompte, entiteDuBien, liensDuCompte,
  creer, modifier, archiver, definirDefaut, rattacherBien,
  anneeParis, formaterNumero, numerotation, reglerNumerotation
}
