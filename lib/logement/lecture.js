// ═══════════════════════════════════════════════════════════════════════════
// LECTURE DES LOGEMENTS — la liste V5 et la fiche d'un bien
// ═══════════════════════════════════════════════════════════════════════════
//
// Etape 0 du lot « Logements V5 » (docs/specs/logements-v5/). Ce module ne
// connait ni HTTP ni garde : il recoit un client Supabase deja porte par le bon
// compte, et rend des DONNEES. L'endpoint api/logement.js lui pose la garde.
//
// ⚠ TROIS ETATS PAR BLOC, JAMAIS DEUX. C'est la regle du lot, et c'est la lecon
// de la dette 59 :
//   · `null`    on n'a PAS PU lire. Le bloc le dira « Information indisponible »,
//               et le motif descend dans `indisponibles`.
//   · `[]` / 0  on a lu, il n'y a rien. « Aucun avis sur 30 jours » est une
//               REPONSE, pas une panne.
//   · donnees   on affiche.
// Confondre les deux premiers, c'est faire lire « aucun canal » a un hote qui en
// a deux — exactement ce que l'ecran faisait avant que les canaux entrent au
// coeur.
//
// ⚠ UN BLOC EN PANNE N'EMPORTE PAS LA FICHE. Chaque bloc a son try/catch : la
// fiche s'affiche avec ce qu'on sait. Seule `properties` est bloquante — sans le
// bien, il n'y a pas de fiche.
//
// ⚠ AUCUN APPEL AU PARTENAIRE, AUCUNE ECRITURE, AUCUN IDENTIFIANT DU PARTENAIRE
// EN SORTIE. Les canaux viennent du coeur (`canaux_du_bien`), jamais d'un appel
// a l'affichage ; et `provider_property_id`, `provider_rate_plan_id`,
// `provider_channel_id` ne quittent pas ce module — ils servent a JOINDRE, pas a
// montrer.

const { fraicheurDuBien, echecVisibleParLHote, COLONNES_HORLOGE_ECRAN } = require('../canaux-du-bien')
const { clesMigrees } = require('../cles-migrees')
const { isActiveStatus } = require('../bookings-snapshot-status')

// Convention du depot (lib/moteur-prix.js, lib/ouverture-marqueur.js) : un jour
// calendaire se lit a Paris, pas en UTC. A 00h30 un 2 octobre UTC, l'hote est
// deja le 2 ; mais a 23h30 UTC le 1er, il est le 2 aussi — et un depart « demain »
// affiche « aujourd'hui » fait rater un menage.
const jourParis = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(d)

// ⚠ TOUTE LECTURE EST BORNEE. PostgREST tronque a 1000 lignes SANS LEVER : une
// lecture sans borne rend un resultat FAUX qui a l'air juste. Ces plafonds sont
// hauts pour ne jamais mordre en vrai, et une lecture qui les atteint LEVE
// (`tronquee`) au lieu de decider sur un morceau.
const BORNE_BIENS    = 500
const BORNE_CANAUX   = 20   // par bien ; 2 OTA aujourd'hui, la marge est large
const BORNE_SEJOURS  = 300  // par bien, et seulement les sejours non termines
const BORNE_AVIS     = 500
const BORNE_LIAISONS = 100
const BORNE_SERRURES = 20
const FENETRE_AVIS_JOURS = 30

// Les colonnes de `properties` dont la fiche a besoin. `provider*` sont ici pour
// JOINDRE et pour decider, jamais pour descendre a l'ecran (voir `publier`).
const COLONNES_BIEN = [
  'id', 'name', 'city', 'country', 'address', 'zip_code', 'capacity', 'photo_url',
  'currency', 'base_price', 'prix_minimum', 'included_guests', 'extra_guest_fee',
  'rate_sync_mode', 'pilote_tarifaire', 'automation_paused', 'inventory_type',
  'ota_listing_urls', 'created_at',
  'provider', 'provider_property_id', 'migration_target_property_id', 'provider_rate_plan_id'
].join(', ')

// ─────────────────────────────────────────────────────────────────────────────
// Le bien tel qu'il descend a l'ecran
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠ C'EST LA SEULE PORTE DE SORTIE, et elle est une LISTE BLANCHE. Un `...bien`
// aurait suffi aujourd'hui et aurait fuite demain : il suffit qu'une colonne
// `provider_*` soit ajoutee au SELECT pour qu'elle parte a l'ecran sans que
// personne l'ait voulu. Ici, une colonne nouvelle ne sort que si on l'ecrit.
//
// `beds24_de_l_hote` est le SEUL endroit ou un nom de partenaire est permis
// (spec §6 : « Gere depuis votre compte Beds24 », sans lien) — et c'est un
// BOOLEEN, pas un identifiant : l'ecran compose la phrase, nous ne la donnons
// pas, et aucun numero de bien ne descend avec.
function publier (bien) {
  return {
    id: bien.id,
    nom: bien.name || null,
    ville: bien.city || null,
    pays: bien.country || null,
    adresse: bien.address || null,
    code_postal: bien.zip_code || null,
    // ⚠ D3 : une capacite vide ne devient PAS 0. « 0 voyageur » est faux, et
    // « Capacite : personne(s) » etait le defaut a corriger. `null` = l'ecran
    // n'affiche rien du tout.
    capacite: Number.isFinite(Number(bien.capacity)) && Number(bien.capacity) > 0 ? Number(bien.capacity) : null,
    photo_url: bien.photo_url || null,
    devise: bien.currency || 'EUR',
    prix_de_base: bien.base_price != null ? Number(bien.base_price) : null,
    prix_plancher: bien.prix_minimum != null ? Number(bien.prix_minimum) : null,
    voyageurs_inclus: bien.included_guests != null ? Number(bien.included_guests) : null,
    supplement_voyageur: bien.extra_guest_fee != null ? Number(bien.extra_guest_fee) : null,
    mode_des_prix: bien.rate_sync_mode || null,
    pilote_tarifaire: bien.pilote_tarifaire === true,
    assistant_en_pause: bien.automation_paused === true,
    type_inventaire: bien.inventory_type || null,
    annonces: bien.ota_listing_urls || null,
    cree_le: bien.created_at || null,
    beds24_de_l_hote: String(bien.provider || '') === 'beds24'
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// La jointure TEXT / UUID
// ─────────────────────────────────────────────────────────────────────────────
//
// Le depot a DEUX facons de joindre un bien : 25 tables sur `property_id` TEXT
// (la cle du partenaire) et 25 sur `properties.id` UUID. La spec interdit de
// faire ce raccord dans la page — et elle a raison, c'est la cause racine notee
// au projet.
//
// ⚠ LA CLE TEXT NE SE DEDUIT PAS D'UN SEUL CHAMP. Un bien EN MIGRATION porte sa
// cle utile dans `migration_target_property_id` (lib/bien-du-provider.js) : lire
// la seule `provider_property_id` montre la fiche de l'ANCIENNE propriete.
//
// ⚠ ET UNE CLE ABANDONNEE NE SE ROUVRE JAMAIS. Le 14 septembre 2026, la rouvrir
// a fait quitter 82 sejours de la fiche et annuler seize menages. Si la table
// des cles migrees est ILLISIBLE, on ne devine pas : `erreur: true`, et AUCUN
// bloc TEXT n'est lu — ils rendent tous `null` avec leur motif. « Je ne sais
// pas » n'est pas « il n'y a rien ».
async function clesTextDuBien (sb, compte, bien) {
  const candidates = [bien.provider_property_id, bien.migration_target_property_id]
    .filter(v => v != null && String(v).trim() !== '')
    .map(String)
  if (!candidates.length) return { cles: [], erreur: false }

  const migrees = await clesMigrees(sb, compte, 'beds24')
  if (migrees.lectureEnEchec) return { cles: [], erreur: true }

  const gardees = candidates.filter(c => !migrees.has(c))
  return { cles: Array.from(new Set(gardees)), erreur: false }
}

// Une lecture qui atteint sa borne LEVE : mieux vaut un bloc « indisponible »
// qu'un bloc faux. C'est la regle du `.limit()` explicite, prise au serieux.
function verifierBorne (lignes, borne, etiquette) {
  if ((lignes || []).length >= borne) {
    const e = new Error(`${etiquette} : ${borne} lignes atteintes, lecture refusee`)
    e.tronquee = true
    throw e
  }
  return lignes || []
}

// ─────────────────────────────────────────────────────────────────────────────
// Les canaux, lus dans le coeur
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠ AUCUN IDENTIFIANT DU PARTENAIRE N'EST MEME DEMANDE. Le privilege par colonne
// les refuserait a un client ; on ne les demande pas non plus cote serveur, pour
// qu'aucune evolution du SELECT ne les fasse sortir par accident.
async function lireCanaux (sb, compte, idsUuid) {
  const borne = Math.max(BORNE_CANAUX * Math.max(idsUuid.length, 1), BORNE_CANAUX)
  const { data, error } = await sb.from('canaux_du_bien')
    .select('property_id, ota, titre, actif, mappe_pour_ce_bien, listing_url, vu_le')
    .eq('user_id', compte)
    .in('property_id', idsUuid)
    .is('disparu_le', null)
    .limit(borne)
  if (error) throw new Error(`canaux : ${error.message}`)
  const lignes = verifierBorne(data, borne, 'canaux')

  const { data: h, error: eH } = await sb.from('canaux_releve')
    .select(COLONNES_HORLOGE_ECRAN)
    .eq('user_id', compte)
    .maybeSingle()
  // ⚠ L'horloge est un ORNEMENT de l'ornement : son echec ne doit pas priver
  // l'hote de ses pastilles. Mais il se DIT dans le journal — c'est le poste
  // charge d'annoncer les pannes, il ne se taira pas sur la sienne (constat de
  // la revue de 6754f48).
  if (eH) console.error('[logement] horloge des canaux illisible :', eH.message)
  const horloge = h ? h.vu_le : null

  const parBien = new Map()
  const datesParBien = new Map()
  for (const l of lignes) {
    const k = String(l.property_id)
    if (!parBien.has(k)) { parBien.set(k, []); datesParBien.set(k, []) }
    parBien.get(k).push({
      ota: l.ota,
      titre: l.titre,
      actif: l.actif === true,
      mappe: l.mappe_pour_ce_bien,
      listing_url: l.listing_url || null
    })
    datesParBien.get(k).push({ vu_le: l.vu_le })
  }
  return { parBien, datesParBien, horloge, horlogeLigne: h || null }
}

// ─────────────────────────────────────────────────────────────────────────────
// Le fait date
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠ DES FAITS, PAS UNE PHRASE. L'endpoint rend « occupe / depart / prochaine
// arrivee » ; c'est l'ecran qui choisit les mots et les traduit. Fabriquer la
// phrase ici la rendrait intraduisible (D1) et graverait en dur un texte que la
// maquette fera bouger.
//
// ⚠ ET SEULS LES SEJOURS ACTIFS COMPTENT. `isActiveStatus` : une reservation
// annulee n'occupe pas le logement. Compter les annulees ferait afficher
// « Occupe » sur un bien libre — donc un hote qui ne relance pas sa vente.
function faitDate (lignes, jour, defaultProvider = null) {
  let depart = null
  let prochaine = null
  for (const l of lignes || []) {
    const s = l.snapshot || {}
    if (!isActiveStatus(s, defaultProvider)) continue
    const a = s.arrival ? String(s.arrival).slice(0, 10) : null
    const d = s.departure ? String(s.departure).slice(0, 10) : null
    if (!a || !d) continue
    // Occupe aujourd'hui : arrivee <= jour < depart. Le jour du DEPART, le
    // logement se libere — c'est la convention des nuitees de tout le depot.
    if (a <= jour && jour < d) {
      if (!depart || d < depart) depart = d
    } else if (a > jour) {
      if (!prochaine || a < prochaine) prochaine = a
    }
  }
  return { occupe: depart != null, depart, prochaine_arrivee: prochaine }
}

// Les sejours non termines d'un ou plusieurs biens.
//
// ⚠ LE FILTRE PORTE SUR LE JSONB. Les dates vivent dans `snapshot`, pas en
// colonne : `.gte('snapshot->>departure', jour)` ecarte cote base les sejours
// termines — sinon on rapatrierait tout l'historique du bien (1436 lignes au
// dernier backfill) pour en garder trois.
async function lireSejours (sb, compte, clesText, jour) {
  const borne = Math.max(BORNE_SEJOURS * Math.max(clesText.length, 1), BORNE_SEJOURS)
  const { data, error } = await sb.from('bookings_snapshot')
    .select('property_id, snapshot')
    .eq('user_id', compte)
    .in('property_id', clesText)
    .gte('snapshot->>departure', jour)
    .limit(borne)
  if (error) throw new Error(`sejours : ${error.message}`)
  return verifierBorne(data, borne, 'sejours')
}

// ─────────────────────────────────────────────────────────────────────────────
// Les avis — des comptes par verdict, jamais d'etoiles
// ─────────────────────────────────────────────────────────────────────────────
//
// La spec §3.6 veut des pouces sur 30 jours. On rend les COMPTES par verdict de
// proprete du coeur (`ai_clean_verdict`), plus les avis pas encore analyses :
// « pas encore analyse » n'est pas « rien signale », et les confondre
// afficherait un pouce vert pour un avis qu'on n'a pas lu.
//
// ⚠ Lecture par UUID. `ota_reviews` porte les deux cles, et l'UUID ne depend
// d'aucune migration : un bien en bascule garde ses avis (dette notee au projet).
async function lireAvis (sb, compte, uuid, jour) {
  const depuis = new Date(`${jour}T00:00:00Z`)
  depuis.setUTCDate(depuis.getUTCDate() - FENETRE_AVIS_JOURS)
  const borne = BORNE_AVIS
  const { data, error } = await sb.from('ota_reviews')
    .select('ai_clean_verdict, ai_analyzed_at, received_at')
    .eq('user_id', compte)
    .eq('property_id', uuid)
    .eq('is_hidden', false)
    .gte('received_at', depuis.toISOString())
    .limit(borne)
  if (error) throw new Error(`avis : ${error.message}`)
  const lignes = verifierBorne(data, borne, 'avis')
  const compteur = { positif: 0, remarque: 0, rien_signale: 0, non_analyses: 0 }
  for (const l of lignes) {
    if (!l.ai_analyzed_at) { compteur.non_analyses++; continue }
    const v = String(l.ai_clean_verdict || '')
    if (v === 'positif' || v === 'remarque' || v === 'rien_signale') compteur[v]++
    else compteur.non_analyses++
  }
  return { fenetre_jours: FENETRE_AVIS_JOURS, total: lignes.length, ...compteur }
}

// ─────────────────────────────────────────────────────────────────────────────
// Menage — par le module de l'app, pas par une regle recopiee
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠ AUCUNE REGLE METIER ICI (decision de Thierry, 19 octobre 2026). Ce qu'est
// « une prestataire assignee » appartient a l'app menage : on lit sa table de
// liaison avec SES colonnes — `rang`, `weekdays`, `requires_ack` — et on les
// transmet telles quelles. Les reduire a « assignee / proposee » recopierait
// ici une regle qui vit dans lib/cleaning/garde.js, et les deux copies
// divergeraient.
async function lireMenage (sb, compte, clesText) {
  const borne = BORNE_LIAISONS
  const { data, error } = await sb.from('property_cleaning_providers')
    .select('property_id, provider_id, rang, weekdays, requires_ack, active')
    .eq('user_id', compte)
    .in('property_id', clesText)
    .eq('active', true)
    .limit(borne)
  if (error) throw new Error(`menage : ${error.message}`)
  const liaisons = verifierBorne(data, borne, 'menage')
  if (!liaisons.length) return []

  const ids = Array.from(new Set(liaisons.map(l => String(l.provider_id))))
  const { data: profils, error: eP } = await sb.from('public_tokens')
    .select('id, nom, prenom')
    .eq('user_id', compte)
    .in('id', ids)
    .limit(ids.length + 1)
  // ⚠ Un profil illisible ne vide pas le bloc : la liaison EXISTE, et la taire
  // ferait lire « personne au menage » sur un bien qui a une prestataire
  // attitree. On rend la liaison sans son nom, et on le dit.
  if (eP) console.error('[logement] profils prestataires illisibles :', eP.message)
  const nomDe = new Map((profils || []).map(p => [String(p.id), [p.prenom, p.nom].filter(Boolean).join(' ').trim() || null]))

  return liaisons
    .sort((a, b) => Number(a.rang) - Number(b.rang))
    .map(l => ({
      nom: nomDe.has(String(l.provider_id)) ? nomDe.get(String(l.provider_id)) : null,
      rang: l.rang != null ? Number(l.rang) : null,
      jours: l.weekdays || null,
      doit_confirmer: l.requires_ack === true
    }))
}

// Serrure : `property_locks` (TEXT) -> `locks`. Memes lectures que le volet des
// messages programmes, qui les fait en RLS depuis le client.
async function lireSerrures (sb, compte, clesText) {
  const borne = BORNE_SERRURES
  const { data, error } = await sb.from('property_locks')
    .select('property_id, role, locks(label, brand)')
    .eq('user_id', compte)
    .in('property_id', clesText)
    .limit(borne)
  if (error) throw new Error(`serrures : ${error.message}`)
  const lignes = verifierBorne(data, borne, 'serrures')
  return lignes.map(l => ({
    role: l.role || null,
    nom: l.locks ? (l.locks.label || null) : null,
    marque: l.locks ? (l.locks.brand || null) : null
  }))
}

// Taxe de sejour : ce que le coeur SAIT du bien, pas un bareme regle a la main —
// il n'y a aucun ecran de reglage a ce jour (voir la note de fin d'etape 0). On
// rend la derniere ligne ecrite par le writer unique, qui porte la commune et
// les trois composantes.
async function lireTaxe (sb, compte, clesText) {
  const { data, error } = await sb.from('taxes_sejour')
    .select('property_id, commune, communale_cents, departementale_cents, regionale_cents, collecteur, origine, inclus_dans_prix, updated_at')
    .eq('user_id', compte)
    .in('property_id', clesText)
    .order('updated_at', { ascending: false })
    .limit(1)
  if (error) throw new Error(`taxe : ${error.message}`)
  const l = (data || [])[0]
  if (!l) return []
  return {
    commune: l.commune || null,
    communale_cents: l.communale_cents,
    departementale_cents: l.departementale_cents,
    regionale_cents: l.regionale_cents,
    collecteur: l.collecteur || null,
    origine: l.origine || null,
    inclus_dans_prix: l.inclus_dans_prix,
    vu_le: l.updated_at || null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// « Suppression possible » — le point le plus sensible de l'endpoint
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠ TROIS VALEURS, ET `null` DESACTIVE LE BOUTON. Une lecture ratee ne doit
// JAMAIS ouvrir une suppression : c'est l'action la plus destructrice du produit
// (elle purge bookings_snapshot, messages, menages, codes d'acces, et c'est
// definitif). A `null`, l'ecran desactive le bouton et dit « Impossible de
// verifier pour l'instant ».
//
// ⚠ LA REGLE EST CELLE DU SERVEUR, PAS CELLE DE LA MAQUETTE. La garde DELETE
// d'aujourd'hui (api/channel-property.js) refuse un bien ENCORE RELIE a une
// annonce OTA — elle ne regarde ni les reservations ni les messages, qu'elle
// purge au contraire. La spec §3.4 annonce « impossible tant qu'il a des
// reservations ou des messages » : ce serait afficher une condition que le
// serveur n'applique pas, donc mentir a l'hote dans les deux sens (bouton
// desactive alors que ca passerait, bouton actif alors que le serveur refuse).
// On affiche la VRAIE regle, et l'ecart est pose a Thierry.
//
// ⚠ ET ELLE SE LIT DANS LE COEUR, SANS APPELER LE PARTENAIRE. La garde DELETE
// interroge `/channels` et `/channels/:id/mappings` — un appel par canal, ce que
// §4 interdit a l'affichage. `canaux_du_bien.mappe_pour_ce_bien` dit exactement
// la meme chose depuis la dette 59.
function suppressionPossible (bien, canaux) {
  const estChannex = String(bien.provider || '') === 'channex' || String(bien.provider || '') === 'channel' || bien.provider == null
  // La garde OTA ne s'applique qu'a un bien du canal pourvu d'un plan tarifaire :
  // hors de ce cas, le serveur ne verifie rien, et le bouton est actif.
  if (!estChannex || !bien.provider_property_id || !bien.provider_rate_plan_id) {
    return { possible: true, motif: null }
  }
  if (canaux == null) return { possible: null, motif: 'canaux_illisibles' }
  const reliee = canaux.some(c => c.mappe === true)
  return reliee ? { possible: false, motif: 'annonce_reliee' } : { possible: true, motif: null }
}

// ─────────────────────────────────────────────────────────────────────────────
// La fiche d'un bien
// ─────────────────────────────────────────────────────────────────────────────
async function lireFiche (sb, { compte, bienId, maintenant = new Date() }) {
  const jour = jourParis(maintenant)

  const { data: bien, error: eB } = await sb.from('properties')
    .select(COLONNES_BIEN)
    .eq('id', bienId)
    .eq('user_id', compte)
    .maybeSingle()
  // ⚠ SEUL CAS BLOQUANT, et les deux echecs se distinguent : une PANNE de
  // lecture (503) n'est pas un bien ABSENT (404). Les confondre ferait croire a
  // l'hote que son logement a disparu — et, a l'onboarding, declencherait une
  // reconciliation contre une liste amputee, donc des biens en double chez le
  // canal (meme piege que la garde aveugle de channel-property).
  if (eB) { const e = new Error(`bien : ${eB.message}`); e.panne = true; throw e }
  if (!bien) return null

  const indisponibles = []
  const fiche = { bien: publier(bien) }

  // Les canaux d'abord : « suppression possible » en depend.
  let canauxDuBien = null
  try {
    const { parBien, datesParBien, horloge, horlogeLigne } = await lireCanaux(sb, compte, [String(bien.id)])
    canauxDuBien = parBien.get(String(bien.id)) || []
    fiche.canaux = canauxDuBien
    fiche.canaux_vu_le = fraicheurDuBien(datesParBien.get(String(bien.id)), horloge)
    // Meme reserve que l'ecran des biens : un compte sans aucun bien chez ce
    // partenaire n'est plus releve, et son drapeau resterait allume a vie.
    fiche.canaux_echec = canauxDuBien.length > 0 && echecVisibleParLHote(horlogeLigne)
  } catch (e) {
    console.error('[logement] canaux illisibles :', e.message)
    fiche.canaux = null
    fiche.canaux_vu_le = null
    fiche.canaux_echec = false
    indisponibles.push('canaux')
  }

  fiche.suppression = suppressionPossible(bien, canauxDuBien)

  // Avis : par UUID, aucune cle TEXT en jeu.
  try {
    fiche.avis = await lireAvis(sb, compte, bien.id, jour)
  } catch (e) {
    console.error('[logement] avis illisibles :', e.message)
    fiche.avis = null
    indisponibles.push('avis')
  }

  // ─── Les blocs TEXT ───
  let cles = []
  let clesEnEchec = false
  try {
    const r = await clesTextDuBien(sb, compte, bien)
    cles = r.cles
    clesEnEchec = r.erreur
  } catch (e) {
    console.error('[logement] cles du bien illisibles :', e.message)
    clesEnEchec = true
  }

  // ⚠ SI LES CLES SONT ILLISIBLES, AUCUN BLOC TEXT N'EST LU. Un bloc vide
  // signifierait « il n'y a rien » ; ici on ne SAIT pas, et le bien pourrait
  // etre en migration. On refuse de deviner, et chaque bloc le dit.
  if (clesEnEchec || !cles.length) {
    const motif = clesEnEchec ? 'cles_illisibles' : 'aucune_cle'
    // Pas de cle du tout n'est pas une panne : un bien cree a la main et jamais
    // provisionne n'a simplement rien a montrer dans ces blocs.
    const valeur = clesEnEchec ? null : []
    for (const bloc of ['menage', 'serrures', 'taxe']) {
      fiche[bloc] = valeur
      if (clesEnEchec) indisponibles.push(bloc)
    }
    fiche.fait_date = clesEnEchec ? null : { occupe: false, depart: null, prochaine_arrivee: null }
    if (clesEnEchec) indisponibles.push('fait_date')
    fiche.cles_motif = motif
    fiche.indisponibles = indisponibles
    return fiche
  }

  const blocs = [
    ['fait_date', async () => faitDate(await lireSejours(sb, compte, cles, jour), jour, bien.provider)],
    ['menage',    () => lireMenage(sb, compte, cles)],
    ['serrures',  () => lireSerrures(sb, compte, cles)],
    ['taxe',      () => lireTaxe(sb, compte, cles)]
  ]
  // ⚠ `allSettled`, pas `all` : avec `all`, le PREMIER bloc en panne emporte les
  // trois autres — c'est exactement « la fiche s'affiche quand meme » qui
  // tombe. Chaque bloc echoue seul.
  const resultats = await Promise.allSettled(blocs.map(([, f]) => f()))
  resultats.forEach((r, i) => {
    const nom = blocs[i][0]
    if (r.status === 'fulfilled') { fiche[nom] = r.value; return }
    console.error(`[logement] ${nom} illisible :`, r.reason && r.reason.message)
    fiche[nom] = null
    indisponibles.push(nom)
  })

  fiche.indisponibles = indisponibles
  return fiche
}

// ─────────────────────────────────────────────────────────────────────────────
// La liste V5
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠ LE COEUR SEUL, AUCUN APPEL AU PARTENAIRE (§4). L'ancien GET de
// channel-property complete sa liste par un fetch live Beds24 ; ici on lit la
// base, ou le cron materialise ces biens. Consequence assumee et nommee : un
// bien cree dans Beds24 apparait au prochain passage du cron, pas dans la
// seconde.
//
// ⚠ ET `refsPerimetre` EST UN FILTRE, PAS UNE VERIFICATION. Sur une COLLECTION,
// le perimetre ne peut pas se verifier bien par bien : sans ce filtre, un membre
// invite sur UN bien recevait le portefeuille complet du titulaire — noms,
// adresses, prix de base.
async function lireListe (sb, { compte, refsPerimetre = null, maintenant = new Date() }) {
  const jour = jourParis(maintenant)

  // Perimetre vide : on echoue FERME, on n'elargit pas.
  if (Array.isArray(refsPerimetre) && refsPerimetre.length === 0) {
    return { biens: [], indisponibles: [] }
  }

  let q = sb.from('properties').select(COLONNES_BIEN).eq('user_id', compte)
  if (Array.isArray(refsPerimetre)) {
    // ⚠ LE PIEGE UUID, QUI A DEJA COUTE TROIS FOIS. `properties.id` est de type
    // uuid : y passer une reference partenaire numerique (« 209413 ») fait
    // echouer la requete ENTIERE en 22P02 — pas rendre zero ligne. Le membre
    // lisait « Erreur de chargement » et croyait a une panne. La branche `id` ne
    // recoit donc que des UUID, et n'est pas emise s'il n'y en a aucun.
    const sures = refsPerimetre.map(String).filter(r => /^[A-Za-z0-9_-]+$/.test(r))
    if (!sures.length) return { biens: [], indisponibles: [] }
    const uuids = sures.filter(r => /^[0-9a-fA-F-]{36}$/.test(r))
    const filtres = [`provider_property_id.in.(${sures.join(',')})`]
    if (uuids.length) filtres.unshift(`id.in.(${uuids.join(',')})`)
    q = q.or(filtres.join(','))
  }
  const { data, error } = await q.order('name', { ascending: true }).limit(BORNE_BIENS)
  // ⚠ UNE LISTE DE BIENS ILLISIBLE SE LEVE. Un 200 a liste vide est la pire des
  // reponses : l'ecran dit « Ajoutez votre premier logement » a un hote qui en a
  // quatre, et l'onboarding reconcilie contre du vide. Lecon de la garde
  // aveugle, et c'est pour ca que `biens` n'a pas de troisieme etat.
  if (error) { const e = new Error(`biens : ${error.message}`); e.panne = true; throw e }
  const lignes = verifierBorne(data, BORNE_BIENS, 'biens')
  if (!lignes.length) return { biens: [], indisponibles: [] }

  const indisponibles = []
  const idsUuid = lignes.map(b => String(b.id))

  let canauxParBien = null
  let datesParBien = new Map()
  let horloge = null
  let horlogeLigne = null
  try {
    const r = await lireCanaux(sb, compte, idsUuid)
    canauxParBien = r.parBien
    datesParBien = r.datesParBien
    horloge = r.horloge
    horlogeLigne = r.horlogeLigne
  } catch (e) {
    console.error('[logement] canaux de la liste illisibles :', e.message)
    indisponibles.push('canaux')
  }

  // Les cles TEXT de tous les biens, en UNE lecture des cles migrees.
  let clesParBien = new Map()
  let clesEnEchec = false
  try {
    const migrees = await clesMigrees(sb, compte, 'beds24')
    if (migrees.lectureEnEchec) clesEnEchec = true
    else {
      for (const b of lignes) {
        const cand = [b.provider_property_id, b.migration_target_property_id]
          .filter(v => v != null && String(v).trim() !== '').map(String)
          .filter(c => !migrees.has(c))
        clesParBien.set(String(b.id), Array.from(new Set(cand)))
      }
    }
  } catch (e) {
    console.error('[logement] cles migrees illisibles :', e.message)
    clesEnEchec = true
  }

  // Le fait date de tous les biens, en UNE lecture des sejours non termines.
  let sejoursParCle = null
  if (!clesEnEchec) {
    const toutesCles = Array.from(new Set([...clesParBien.values()].flat()))
    if (toutesCles.length) {
      try {
        const lignesSejours = await lireSejours(sb, compte, toutesCles, jour)
        sejoursParCle = new Map()
        for (const l of lignesSejours) {
          const k = String(l.property_id)
          if (!sejoursParCle.has(k)) sejoursParCle.set(k, [])
          sejoursParCle.get(k).push(l)
        }
      } catch (e) {
        console.error('[logement] sejours de la liste illisibles :', e.message)
        indisponibles.push('fait_date')
      }
    } else {
      sejoursParCle = new Map()
    }
  } else {
    indisponibles.push('fait_date')
  }

  const biens = lignes.map(b => {
    const k = String(b.id)
    const canaux = canauxParBien ? (canauxParBien.get(k) || []) : null
    const cles = clesEnEchec ? null : (clesParBien.get(k) || [])
    // ⚠ `null`, JAMAIS « Libre ». Un fait date qu'on n'a pas pu lire ne devient
    // pas « Libre jusqu'au… » : ce serait un mensonge commercial affiche sur la
    // carte d'un bien peut-etre complet.
    let fait = null
    if (sejoursParCle && cles) {
      const lignesDuBien = cles.flatMap(c => sejoursParCle.get(String(c)) || [])
      fait = faitDate(lignesDuBien, jour, b.provider)
    }
    return {
      ...publier(b),
      canaux,
      canaux_vu_le: canauxParBien ? fraicheurDuBien(datesParBien.get(k), horloge) : null,
      canaux_echec: canauxParBien ? ((canaux || []).length > 0 && echecVisibleParLHote(horlogeLigne)) : false,
      fait_date: fait
    }
  })

  return { biens, indisponibles: Array.from(new Set(indisponibles)) }
}

module.exports = {
  lireFiche,
  lireListe,
  // exportes pour les tests, et pour qu'une regle ne soit ecrite qu'une fois
  publier,
  faitDate,
  suppressionPossible,
  clesTextDuBien,
  jourParis,
  FENETRE_AVIS_JOURS,
  BORNE_BIENS,
  BORNE_SEJOURS
}
