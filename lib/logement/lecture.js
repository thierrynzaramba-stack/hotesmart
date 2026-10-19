// ═══════════════════════════════════════════════════════════════════════════
// LECTURE DES LOGEMENTS — la liste V5 et la fiche d'un bien
// ═══════════════════════════════════════════════════════════════════════════
//
// Etape 0 du lot « Logements V5 » (docs/specs/logements-v5/). Ce module ne
// connait ni HTTP ni garde : il recoit un client Supabase deja porte par le bon
// compte, et rend des DONNEES. L'endpoint api/logement.js lui pose la garde.
//
// ⚠ QUATRE ETATS PAR BLOC, ET ILS NE SE CONFONDENT PAS. C'est la raison d'etre
// de ce module, et la lecon de la dette 59 :
//   · `null` + nom dans `indisponibles`  on n'a PAS PU lire ;
//   · `null` + nom dans `refuses`        vous n'avez pas le DROIT de le voir ;
//   · `[]` / `0` / `{ connue: false }`   on a lu, il n'y a rien. « Aucun avis
//                                        sur 30 jours » est une REPONSE ;
//   · donnees                            on affiche.
// Les confondre, c'est faire lire « aucun canal » a un hote qui en a deux, ou
// « personne dans l'equipe » a un delegue qui n'a pas le droit de voir les
// personnes — ce second cas est le constat de securite de la revue du
// 20 octobre 2026.
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
// ⚠ IMPORTE, PAS RECOPIE (constat M1 de la revue). Trois etats vivent dans cette
// colonne TEXT — 'calendrier', 'yieldflow', ou rien — et ma premiere version la
// lisait `=== true` : le champ valait FAUX pour La bulle et Coeur de vie 23, que
// YieldFlow pilote depuis le 23 septembre. L'ecran en aurait deduit que le
// calendrier decide les prix, et aurait propose « Publier mes prix » sur un bien
// pilote : deux ecrivains de prix sur la meme nuit, ce que ce module existe
// precisement pour interdire.
const { piloteDuBien } = require('../pilote-tarifaire')
// ⚠ ET CES DEUX-LA AUSSI SONT IMPORTEES. `lib/require-permission.js` les exporte
// en disant pourquoi : « une seconde definition ailleurs finirait par diverger ».
// Ma copie acceptait 36 tirets comme un UUID — donc la branche `id.in.()` emise
// avec une valeur non-uuid, donc 22P02, donc la requete ENTIERE en echec et
// l'hote qui lit « panne ». Le piege UUID, pour la quatrieme fois.
const { UUID_RE, REF_SURE_RE } = require('../require-permission')

// Convention du depot (lib/moteur-prix.js, lib/ouverture-marqueur.js) : un jour
// calendaire se lit a Paris, pas en UTC. A 23h30 UTC le 1er, l'hote est deja le 2 —
// et un depart « demain » affiche « aujourd'hui » fait rater un menage.
const jourParis = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(d)

// ⚠ TOUTE LECTURE EST PAGINEE, PAS « BORNEE HAUT ». Constat H3 de la revue du
// 20 octobre 2026, et c'est le plus insidieux du lot : PostgREST applique
// `max_rows = 1000` (supabase/config.toml) et RAMENE SILENCIEUSEMENT tout
// `.limit(n > 1000)` a 1000. Ma premiere version demandait 300 lignes par bien,
// soit 8 400 pour un compte a 28 biens : la base en rendait 1 000, et ma garde
// comparait 1 000 a 8 400 — elle ne pouvait plus mordre. Les biens dont les
// sejours tombaient hors du millier recevaient « rien a signaler », donc
// « Libre jusqu'au… » sur un bien COMPLET. Le mensonge commercial que ce lot
// interdit, arrive par le chemin « lu et vide » : sans log, sans 503, sans rien.
const PAGE = 1000
const MAX_PAGES = 20
const FENETRE_AVIS_JOURS = 30

// Au-dela, c'est une anomalie : on le dit fort plutot que de decider sur un
// sous-ensemble arbitraire. ⚠ L'ORDRE EST OBLIGATOIRE ET STABLE : sans lui, deux
// pages peuvent rendre la meme ligne et en sauter une autre.
async function lirePagine (faireQuery, etiquette, ordre) {
  const tout = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await faireQuery()
      .order(ordre, { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1)
    if (error) { const e = new Error(`${etiquette} : ${error.message}`); e.dbError = true; throw e }
    const lot = data || []
    tout.push(...lot)
    if (lot.length < PAGE) return tout
  }
  const e = new Error(`${etiquette} : plus de ${MAX_PAGES * PAGE} lignes, lecture refusee`)
  e.tronquee = true
  throw e
}

// Les colonnes de `properties` dont la fiche a besoin. `provider*` sont ici pour
// JOINDRE et pour decider, jamais pour descendre a l'ecran (voir `publier`).
const COLONNES_BIEN = [
  'id', 'name', 'city', 'country', 'address', 'zip_code', 'capacity', 'photo_url',
  'currency', 'base_price', 'prix_minimum', 'included_guests', 'extra_guest_fee',
  'rate_sync_mode', 'pilote_tarifaire', 'automation_paused', 'inventory_type',
  'ota_listing_urls', 'created_at',
  'provider', 'provider_property_id', 'migration_target_property_id', 'provider_rate_plan_id'
].join(', ')

// Un bien EN MIGRATION porte deja sa propriete chez le nouveau provider : sa cle
// utile est la cible, pas l'origine (lib/bien-du-provider.js).
const enMigration = (b) => !!b.migration_target_property_id &&
  String(b.provider_property_id) !== String(b.migration_target_property_id)

// ─────────────────────────────────────────────────────────────────────────────
// Le bien tel qu'il descend a l'ecran
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠ C'EST LA SEULE PORTE DE SORTIE, et elle est une LISTE BLANCHE. Un `...bien`
// aurait suffi aujourd'hui et aurait fuite demain : il suffit qu'une colonne
// `provider_*` soit ajoutee au SELECT pour qu'elle parte a l'ecran sans que
// personne l'ait voulu. Ici, une colonne nouvelle ne sort que si on l'ecrit.
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
    // La CHAINE, pas un booleen : 'calendrier' | 'yieldflow' (repli raisonne du
    // module, qui est 'calendrier' — le mode qui laisse l'hote ecrire).
    pilote_tarifaire: piloteDuBien(bien),
    assistant_en_pause: bien.automation_paused === true,
    type_inventaire: bien.inventory_type || null,
    annonces: bien.ota_listing_urls || null,
    cree_le: bien.created_at || null,
    // ⚠ LE SEUL ENDROIT OU UN NOM DE PARTENAIRE EST PERMIS (spec §6 : « Gere
    // depuis votre compte Beds24 », sans lien) — et c'est un BOOLEEN, pas un
    // identifiant : l'ecran compose la phrase, nous ne la donnons pas.
    // ⚠ FAUX PENDANT UNE MIGRATION (constat L2) : un bien deja servi par le
    // canal ne se dit plus « gere depuis Beds24 », meme si sa colonne `provider`
    // porte encore l'ancien nom. La phrase serait fausse pendant toute la bascule.
    beds24_de_l_hote: String(bien.provider || '') === 'beds24' && !enMigration(bien)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// La jointure TEXT / UUID
// ─────────────────────────────────────────────────────────────────────────────
//
// Le depot a DEUX facons de joindre un bien : des tables sur `property_id` TEXT
// (la cle du partenaire) et d'autres sur `properties.id` UUID. La spec interdit
// de faire ce raccord dans la page — et elle a raison, c'est la cause racine
// notee au projet.
//
// ⚠ LA CLE TEXT NE SE DEDUIT PAS D'UN SEUL CHAMP. Un bien EN MIGRATION porte sa
// cle utile dans `migration_target_property_id` : lire la seule
// `provider_property_id` montre la fiche de l'ANCIENNE propriete.
//
// ⚠ ET UNE CLE ABANDONNEE NE SE ROUVRE JAMAIS. Le 14 septembre 2026, la rouvrir
// a fait quitter 82 sejours de la fiche et annuler seize menages. Si la table
// des cles migrees est ILLISIBLE, on ne devine pas : `erreur: true`, et AUCUN
// bloc TEXT n'est lu. « Je ne sais pas » n'est pas « il n'y a rien ».
function clesCandidates (bien) {
  return Array.from(new Set([bien.provider_property_id, bien.migration_target_property_id]
    .filter(v => v != null && String(v).trim() !== '')
    .map(String)))
}

async function clesTextDuBien (sb, compte, bien) {
  const candidates = clesCandidates(bien)
  if (!candidates.length) return { cles: [], erreur: false }
  const migrees = await clesMigrees(sb, compte, 'beds24')
  if (migrees.lectureEnEchec) return { cles: [], erreur: true }
  return { cles: candidates.filter(c => !migrees.has(c)), erreur: false }
}

// ─────────────────────────────────────────────────────────────────────────────
// Les canaux, lus dans le coeur
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠ AUCUN IDENTIFIANT DU PARTENAIRE N'EST MEME DEMANDE. Le privilege par colonne
// les refuserait a un client ; on ne les demande pas non plus cote serveur, pour
// qu'aucune evolution du SELECT ne les fasse sortir par accident.
async function lireCanaux (sb, compte, idsUuid) {
  const lignes = await lirePagine(() => sb.from('canaux_du_bien')
    .select('id, property_id, ota, titre, actif, mappe_pour_ce_bien, listing_url, vu_le')
    .eq('user_id', compte)
    .in('property_id', idsUuid)
    .is('disparu_le', null), 'canaux', 'id')

  // ⚠ TROIS ETATS POUR L'HORLOGE AUSSI (constat M3). `lib/canoux-du-bien` en a
  // fait l'experience : « la premiere version les confondait ». Une PANNE de
  // `canaux_releve` ne vaut pas « aucun releve n'a jamais eu lieu » — la
  // premiere se dit, la seconde est un fait normal sur un compte neuf.
  let horlogeLigne = null
  let horlogeEnPanne = false
  const { data: h, error: eH } = await sb.from('canaux_releve')
    .select(COLONNES_HORLOGE_ECRAN)
    .eq('user_id', compte)
    .maybeSingle()
  if (eH) {
    // L'horloge est un ORNEMENT de l'ornement : son echec ne prive pas l'hote de
    // ses pastilles. Mais il se DIT — c'est le poste charge d'annoncer les
    // pannes, il ne se taira pas sur la sienne (constat de la revue de 6754f48).
    console.error('[logement] horloge des canaux illisible :', eH.message)
    horlogeEnPanne = true
  } else {
    horlogeLigne = h || null
  }

  const parBien = new Map()
  const datesParBien = new Map()
  for (const l of lignes) {
    const k = String(l.property_id)
    if (!parBien.has(k)) { parBien.set(k, []); datesParBien.set(k, []) }
    parBien.get(k).push({
      ota: l.ota,
      titre: l.titre,
      actif: l.actif === true,
      // ⚠ TRANSMIS TEL QUEL, `null` COMPRIS. Le writer pose `null` quand il n'a
      // pas pu conclure, et jamais `false` par defaut : l'ecraser ici en
      // « pas en vente » est exactement ce que le writer refuse de faire.
      mappe: l.mappe_pour_ce_bien,
      listing_url: l.listing_url || null
    })
    datesParBien.get(k).push({ vu_le: l.vu_le })
  }
  return { parBien, datesParBien, horloge: horlogeLigne ? horlogeLigne.vu_le : null, horlogeLigne, horlogeEnPanne }
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
// « Occupe » sur un bien a vendre.
//
// ⚠ PORTEE CONNUE, ET NOMMEE (constat M4) : un BLOCAGE proprietaire (`blocked`)
// et les fermetures de l'hote (table `fermetures`, lot 4.6.2) ne sont pas lus.
// La spec §2 dit « faits comptes depuis les reservations » — mais l'ecran, lui,
// dira « Libre » sur une periode fermee. Ecart assume, note aux constats.
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
  return lirePagine(() => sb.from('bookings_snapshot')
    .select('booking_id, property_id, snapshot')
    .eq('user_id', compte)
    .in('property_id', clesText)
    .gte('snapshot->>departure', jour), 'sejours', 'booking_id')
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
//
// ⚠ Un avis sans `received_at` reste hors fenetre (constat L5) : sans date, on ne
// peut pas affirmer qu'il est dans les 30 jours. Note, assume.
async function lireAvis (sb, compte, uuid, jour) {
  const depuis = new Date(`${jour}T00:00:00Z`)
  depuis.setUTCDate(depuis.getUTCDate() - FENETRE_AVIS_JOURS)
  const lignes = await lirePagine(() => sb.from('ota_reviews')
    .select('id, ai_clean_verdict, ai_analyzed_at, received_at')
    .eq('user_id', compte)
    .eq('property_id', uuid)
    .eq('is_hidden', false)
    .gte('received_at', depuis.toISOString()), 'avis', 'id')
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
// Menage — par les tables de l'app, avec SES cles
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠ AUCUNE REGLE METIER ICI (decision de Thierry). Ce qu'est « une prestataire
// assignee » appartient a l'app menage : on lit sa table de liaison avec SES
// colonnes — `rang`, `weekdays`, `requires_ack` — et on les transmet telles
// quelles. Les reduire a « assignee / proposee » recopierait ici une regle qui
// vit dans lib/cleaning/garde.js, et les deux copies divergeraient.
//
// ⚠ LES PERSONNES SONT DANS `profiles`, PAS DANS `public_tokens` (constat H2 de
// la revue, prouve par mutation : mon test etait VERT contre le code casse et
// ROUGE contre le code correct). `property_cleaning_providers.provider_id` est
// une cle etrangere vers `profiles(id)` ; `public_tokens` n'a ni `nom` ni
// `prenom` — PostgREST repondait 42703, donc tous les noms valaient `null`, pour
// toujours. Memes lectures que `api/menages.js` : `account_user_id`, et
// `access_mode = 'lien'`.
async function lireMenage (sb, compte, clesText) {
  const liaisons = await lirePagine(() => sb.from('property_cleaning_providers')
    .select('id, property_id, provider_id, rang, weekdays, requires_ack, active')
    .eq('user_id', compte)
    .in('property_id', clesText)
    .eq('active', true), 'menage', 'id')
  if (!liaisons.length) return []

  const ids = Array.from(new Set(liaisons.map(l => String(l.provider_id))))
  let personnes = null
  try {
    personnes = await lirePagine(() => sb.from('profiles')
      .select('id, first_name, last_name, active')
      .eq('account_user_id', compte)
      .in('id', ids), 'profils prestataires', 'id')
  } catch (e) {
    // ⚠ Un profil illisible ne vide pas le bloc : la liaison EXISTE, et la taire
    // ferait lire « personne au menage » sur un bien qui a une prestataire
    // attitree. On rend la liaison sans son nom, et le drapeau le DIT — sans
    // lui, l'ecran afficherait une ligne d'equipe sans personne dessus.
    console.error('[logement] profils prestataires illisibles :', e.message)
  }
  const nomDe = new Map((personnes || []).map(p =>
    [String(p.id), [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || null]))

  return liaisons
    .sort((a, b) => Number(a.rang) - Number(b.rang))
    .map(l => ({
      nom: nomDe.get(String(l.provider_id)) || null,
      nom_lu: personnes != null,
      rang: l.rang != null ? Number(l.rang) : null,
      jours: l.weekdays || null,
      doit_confirmer: l.requires_ack === true
    }))
}

// Serrure : `property_locks` (TEXT) -> `locks`. Memes lectures que le volet des
// messages programmes, qui les fait en RLS depuis le client.
async function lireSerrures (sb, compte, clesText) {
  const lignes = await lirePagine(() => sb.from('property_locks')
    .select('id, property_id, role, locks(label, brand)')
    .eq('user_id', compte)
    .in('property_id', clesText), 'serrures', 'id')
  return lignes.map(l => ({
    role: l.role || null,
    nom: l.locks ? (l.locks.label || null) : null,
    marque: l.locks ? (l.locks.brand || null) : null
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Taxe de sejour : ce que le coeur SAIT du bien
// ─────────────────────────────────────────────────────────────────────────────
//
// Pas un bareme regle a la main : il n'existe aucun ecran pour le faire (voir
// les constats de l'etape 0). On rend la derniere ligne ecrite par le writer
// unique, qui porte la commune et les trois composantes.
//
// ⚠ PAR UUID (constat M6). `taxes_sejour` porte `property_uuid`, et c'est son
// SEUL index par bien. Joindre en TEXT couplait ce bloc a la garde des cles
// migrees — il disparaissait des que `provider_keys_migrated` etait illisible,
// alors que l'UUID ne depend d'aucune migration. C'est l'argument deja retenu
// pour les avis.
//
// ⚠ TOUJOURS UN OBJET (constat M5). Rendre `[]` pour « aucune ligne » et un
// objet sinon obligeait l'ecran a un `Array.isArray` pour distinguer trois
// etats : `taxe.commune` valait `undefined` sans erreur. `connue: false` dit
// « lu, et il n'y a rien » sans changer de type.
async function lireTaxe (sb, compte, uuid) {
  const { data, error } = await sb.from('taxes_sejour')
    .select('commune, communale_cents, departementale_cents, regionale_cents, collecteur, origine, inclus_dans_prix, updated_at')
    .eq('user_id', compte)
    .eq('property_uuid', uuid)
    .order('updated_at', { ascending: false })
    .limit(1)
  if (error) throw new Error(`taxe : ${error.message}`)
  const l = (data || [])[0]
  if (!l) return { connue: false }
  return {
    connue: true,
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
// definitif). A `null`, l'ecran desactive le bouton et dit pourquoi.
//
// ⚠ LA REGLE EST CELLE DU SERVEUR, PAS CELLE DE LA MAQUETTE. La garde DELETE
// d'aujourd'hui refuse un bien ENCORE RELIE a une annonce OTA — elle ne regarde
// ni les reservations ni les messages, qu'elle purge au contraire. La spec §3.4
// annonce l'inverse : ce serait afficher une condition que le serveur n'applique
// pas, donc mentir dans les deux sens. On affiche la VRAIE regle, et l'ecart est
// pose a Thierry.
//
// ⚠ ET ELLE SE LIT DANS LE COEUR, SANS APPELER LE PARTENAIRE : la garde DELETE
// interroge `/channels` et `/channels/:id/mappings`, ce que §4 interdit a
// l'affichage. `canaux_du_bien.mappe_pour_ce_bien` dit la meme chose depuis la
// dette 59 — avec une nuance de perimetre notee aux constats.
//
// ⚠ QUATRE REFUS, et trois viennent de la revue du 20 octobre :
//   · `mappe === null` (H4) : le writer pose `null` quand il n'a PAS PU
//     conclure. Le lire comme « pas relie » ouvrait le bouton Supprimer sur un
//     bien encore en vente sur Airbnb ;
//   · aucun canal ET aucune date de releve (M1a) : « jamais releve » n'est pas
//     « pas relie ». La dette 59 n'est en prod que depuis le 19 octobre ;
//   · `peutSupprimer === false` (M1b) : la garde DELETE exige `reglages: write`.
//     Rendre `possible: true` a un membre en lecture lui promettrait une action
//     qui sera refusee en 403 — et la spec §5 veut « aucun bouton d'action dans
//     le DOM » pour ce profil.
function suppressionPossible (bien, canaux, { vuLe = null, peutSupprimer = true } = {}) {
  if (!peutSupprimer) return { possible: null, motif: 'droit_refuse' }
  const estDuCanal = ['channex', 'channel'].includes(String(bien.provider || '')) || bien.provider == null
  // La garde OTA ne s'applique qu'a un bien du canal pourvu d'un plan tarifaire :
  // hors de ce cas, le serveur ne verifie rien, et le bouton est actif.
  if (!estDuCanal || !bien.provider_property_id || !bien.provider_rate_plan_id) {
    return { possible: true, motif: null }
  }
  if (canaux == null) return { possible: null, motif: 'canaux_illisibles' }
  if (canaux.some(c => c.mappe === true)) return { possible: false, motif: 'annonce_reliee' }
  if (canaux.some(c => c.mappe == null)) return { possible: null, motif: 'mapping_inconnu' }
  if (!canaux.length && !vuLe) return { possible: null, motif: 'jamais_releve' }
  return { possible: true, motif: null }
}

// ─────────────────────────────────────────────────────────────────────────────
// Les droits par DOMAINE, au-dela de la garde d'entree
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠ C'EST LE CONSTAT DE SECURITE DE LA REVUE DU 20 OCTOBRE 2026, et il etait
// juste. La garde d'entree est `reservations: read` — mais trois blocs de la
// fiche appartiennent a d'AUTRES domaines, et leurs policies RLS le disent :
//   · `property_cleaning_providers` -> can_read(user_id, 'prestataires', …)
//   · `ota_reviews`                 -> can_read(user_id, 'avis', …)
//   · `taxes_sejour`                -> `revoke all from authenticated` : table
//     de service, qu'aucun client ne lit aujourd'hui.
// L'endpoint tourne en service key, qui contourne la RLS par conception : c'est
// precisement pourquoi il doit verifier lui-meme. Sans ces trois verifications,
// un co-hote invite avec `reservations: read` et `prestataires: none` recevait
// le nom de la prestataire, son rang et SES JOURS DE TRAVAIL — que
// `api/menages.js` lui refuse, et que la RLS lui refuserait depuis le navigateur.
//
// Le precedent est explicite (api/menages.js, equipe du 13 octobre) : « TROIS
// DROITS, TROIS CHOSES ».
const DROITS_DES_BLOCS = { menage: 'prestataires', avis: 'avis', taxe: 'facturation' }

function blocsRefuses (droits) {
  // `droits` : { prestataires: bool, avis: bool, facturation: bool, reglages_write: bool }
  // Absent (lecture interne, script) = tout ouvert : ce module est appele par un
  // endpoint qui a deja authentifie, jamais par un client.
  if (!droits) return []
  return Object.entries(DROITS_DES_BLOCS)
    .filter(([, domaine]) => droits[domaine] === false)
    .map(([bloc]) => bloc)
}

// ─────────────────────────────────────────────────────────────────────────────
// La fiche d'un bien
// ─────────────────────────────────────────────────────────────────────────────
async function lireFiche (sb, { compte, bienId, maintenant = new Date(), droits = null }) {
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
  const refuses = blocsRefuses(droits)
  const fiche = { bien: publier(bien) }

  // Les canaux d'abord : « suppression possible » en depend.
  let canauxDuBien = null
  let vuLeDuBien = null
  try {
    const { parBien, datesParBien, horloge, horlogeLigne, horlogeEnPanne } = await lireCanaux(sb, compte, [String(bien.id)])
    canauxDuBien = parBien.get(String(bien.id)) || []
    vuLeDuBien = fraicheurDuBien(datesParBien.get(String(bien.id)), horloge)
    fiche.canaux = canauxDuBien
    fiche.canaux_vu_le = vuLeDuBien
    // Meme reserve que l'ecran des biens : un compte sans aucun bien chez ce
    // partenaire n'est plus releve, et son drapeau resterait allume a vie.
    fiche.canaux_echec = canauxDuBien.length > 0 && (horlogeEnPanne || echecVisibleParLHote(horlogeLigne))
  } catch (e) {
    console.error('[logement] canaux illisibles :', e.message)
    fiche.canaux = null
    fiche.canaux_vu_le = null
    fiche.canaux_echec = false
    indisponibles.push('canaux')
  }

  fiche.suppression = suppressionPossible(bien, canauxDuBien, {
    vuLe: vuLeDuBien,
    peutSupprimer: droits ? droits.reglages_write !== false : true
  })

  // Avis : par UUID, aucune cle TEXT en jeu.
  if (refuses.includes('avis')) {
    fiche.avis = null
  } else {
    try {
      fiche.avis = await lireAvis(sb, compte, bien.id, jour)
    } catch (e) {
      console.error('[logement] avis illisibles :', e.message)
      fiche.avis = null
      indisponibles.push('avis')
    }
  }

  // Taxe : par UUID aussi, donc independante des cles migrees.
  if (refuses.includes('taxe')) {
    fiche.taxe = null
  } else {
    try {
      fiche.taxe = await lireTaxe(sb, compte, bien.id)
    } catch (e) {
      console.error('[logement] taxe illisible :', e.message)
      fiche.taxe = null
      indisponibles.push('taxe')
    }
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
  fiche.cles_motif = clesEnEchec ? 'cles_illisibles' : (cles.length ? 'ok' : 'aucune_cle')

  // ⚠ SI LES CLES SONT ILLISIBLES, AUCUN BLOC TEXT N'EST LU. Un bloc vide
  // signifierait « il n'y a rien » ; ici on ne SAIT pas, et le bien pourrait
  // etre en migration. On refuse de deviner, et chaque bloc le dit.
  if (clesEnEchec || !cles.length) {
    // Pas de cle du tout n'est pas une panne : un bien cree a la main et jamais
    // provisionne n'a simplement rien a montrer dans ces blocs.
    const vide = { menage: [], serrures: [], fait_date: { occupe: false, depart: null, prochaine_arrivee: null } }
    for (const bloc of ['menage', 'serrures', 'fait_date']) {
      if (refuses.includes(bloc)) { fiche[bloc] = null; continue }
      fiche[bloc] = clesEnEchec ? null : vide[bloc]
      if (clesEnEchec) indisponibles.push(bloc)
    }
    fiche.indisponibles = indisponibles
    fiche.refuses = refuses
    return fiche
  }

  const blocs = [
    ['fait_date', async () => faitDate(await lireSejours(sb, compte, cles, jour), jour, bien.provider)],
    ['menage',    () => lireMenage(sb, compte, cles)],
    ['serrures',  () => lireSerrures(sb, compte, cles)]
  ].filter(([nom]) => !refuses.includes(nom))
  for (const nom of ['fait_date', 'menage', 'serrures']) {
    if (refuses.includes(nom)) fiche[nom] = null
  }
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
  fiche.refuses = refuses
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
async function lireListe (sb, { compte, refsPerimetre = null, maintenant = new Date(), droits = null }) {
  const jour = jourParis(maintenant)

  // Perimetre vide : on echoue FERME, on n'elargit pas.
  if (Array.isArray(refsPerimetre) && refsPerimetre.length === 0) {
    return { biens: [], indisponibles: [], refuses: blocsRefuses(droits) }
  }

  let q = sb.from('properties').select(COLONNES_BIEN).eq('user_id', compte)
  if (Array.isArray(refsPerimetre)) {
    // ⚠ LE PIEGE UUID, QUI A DEJA COUTE QUATRE FOIS. `properties.id` est de type
    // uuid : y passer une reference partenaire numerique (« 209413 ») fait
    // echouer la requete ENTIERE en 22P02 — pas rendre zero ligne. Le membre
    // lisait « Erreur de chargement » et croyait a une panne. La branche `id` ne
    // recoit donc que des UUID, et n'est pas emise s'il n'y en a aucun. Les deux
    // motifs sont IMPORTES de la garde, jamais recopies.
    const sures = refsPerimetre.map(String).filter(r => REF_SURE_RE.test(r))
    if (!sures.length) return { biens: [], indisponibles: [], refuses: blocsRefuses(droits) }
    const uuids = sures.filter(r => UUID_RE.test(r))
    const filtres = [`provider_property_id.in.(${sures.join(',')})`]
    if (uuids.length) filtres.unshift(`id.in.(${uuids.join(',')})`)
    q = q.or(filtres.join(','))
  }

  // ⚠ UNE LISTE DE BIENS ILLISIBLE SE LEVE. Un 200 a liste vide est la pire des
  // reponses : l'ecran dit « Ajoutez votre premier logement » a un hote qui en a
  // quatre, et l'onboarding reconcilie contre du vide, ce qui CREE des biens en
  // double chez le canal. Lecon de la garde aveugle : c'est pour ca que `biens`
  // n'a pas de troisieme etat.
  let lignes
  try {
    lignes = await lirePagine(() => q, 'biens', 'id')
  } catch (e) {
    e.panne = true
    throw e
  }
  const refuses = blocsRefuses(droits)
  if (!lignes.length) return { biens: [], indisponibles: [], refuses }

  const indisponibles = []
  const idsUuid = lignes.map(b => String(b.id))

  let canauxParBien = null
  let datesParBien = new Map()
  let horloge = null
  let horlogeLigne = null
  let horlogeEnPanne = false
  try {
    const r = await lireCanaux(sb, compte, idsUuid)
    canauxParBien = r.parBien
    datesParBien = r.datesParBien
    horloge = r.horloge
    horlogeLigne = r.horlogeLigne
    horlogeEnPanne = r.horlogeEnPanne
  } catch (e) {
    console.error('[logement] canaux de la liste illisibles :', e.message)
    indisponibles.push('canaux')
  }

  // Les cles TEXT de tous les biens, en UNE lecture des cles migrees.
  const clesParBien = new Map()
  let clesEnEchec = false
  try {
    const migrees = await clesMigrees(sb, compte, 'beds24')
    if (migrees.lectureEnEchec) clesEnEchec = true
    else for (const b of lignes) {
      clesParBien.set(String(b.id), clesCandidates(b).filter(c => !migrees.has(c)))
    }
  } catch (e) {
    console.error('[logement] cles migrees illisibles :', e.message)
    clesEnEchec = true
  }

  // Le fait date de tous les biens, en UNE lecture paginee des sejours a venir.
  let sejoursParCle = null
  if (clesEnEchec) {
    indisponibles.push('fait_date')
  } else {
    const toutesCles = Array.from(new Set([...clesParBien.values()].flat()))
    if (!toutesCles.length) sejoursParCle = new Map()
    else {
      try {
        sejoursParCle = new Map()
        for (const l of await lireSejours(sb, compte, toutesCles, jour)) {
          const k = String(l.property_id)
          if (!sejoursParCle.has(k)) sejoursParCle.set(k, [])
          sejoursParCle.get(k).push(l)
        }
      } catch (e) {
        console.error('[logement] sejours de la liste illisibles :', e.message)
        sejoursParCle = null
        indisponibles.push('fait_date')
      }
    }
  }

  const biens = lignes.map(b => {
    const k = String(b.id)
    const canaux = canauxParBien ? (canauxParBien.get(k) || []) : null
    const cles = clesEnEchec ? null : (clesParBien.get(k) || [])
    const vuLe = canauxParBien ? fraicheurDuBien(datesParBien.get(k), horloge) : null
    // ⚠ `null`, JAMAIS « Libre ». Un fait date qu'on n'a pas pu lire ne devient
    // pas « Libre jusqu'au… » : ce serait un mensonge commercial affiche sur la
    // carte d'un bien peut-etre complet.
    let fait = null
    if (sejoursParCle && cles) {
      fait = faitDate(cles.flatMap(c => sejoursParCle.get(String(c)) || []), jour, b.provider)
    }
    return {
      ...publier(b),
      canaux,
      canaux_vu_le: vuLe,
      canaux_echec: canauxParBien ? ((canaux || []).length > 0 && (horlogeEnPanne || echecVisibleParLHote(horlogeLigne))) : false,
      fait_date: fait
    }
  })

  return { biens, indisponibles: Array.from(new Set(indisponibles)), refuses }
}

module.exports = {
  lireFiche,
  lireListe,
  // exportes pour les tests, et pour qu'une regle ne soit ecrite qu'une fois
  publier,
  faitDate,
  suppressionPossible,
  clesTextDuBien,
  blocsRefuses,
  jourParis,
  DROITS_DES_BLOCS,
  FENETRE_AVIS_JOURS,
  PAGE,
  MAX_PAGES
}
