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
// ⚠ LA POPULATION DES AVIS VIENT DU DOMAINE AVIS, elle ne se recopie pas ici.
// `avisQuiComptent` porte la lecon de la recette du 7 octobre 2026 (les avis
// masques tiraient la moyenne vers le bas) ; deux definitions de « les avis de
// ce logement » afficheraient deux nombres differents sur deux ecrans.
const { avisQuiComptent } = require('../stats-avis')
// ⚠ ET « UN AVIS » N'EST PAS « UNE LIGNE ». Constat G1 de la revue du 20 octobre
// 2026. `avisQuiComptent` filtre le STATUT et la VISIBILITE ; ce qui fait qu'un
// voyageur a ecrit quelque chose est une AUTRE regle, et le depot l'a deja
// ecrite deux fois : une note > 0 OU un texte, « un objet vide et non cache ne
// prouve rien » (lib/avis/naissance.js). Le cas est atteignable : l'objet
// Channex nait au depart, cache et vide, et Airbnb le revele au bout de
// 14 jours MEME si le voyageur n'a rien ecrit. Sans ce filtre, une telle ligne
// gonflerait le total ET entrerait a 0/10 dans la moyenne — le defaut exact de
// la recette du 7 octobre, arrive par l'autre porte.
// Mesure de production du 20 octobre 2026 : 0 ligne dans ce cas aujourd'hui.
const { voyageurAEcrit } = require('../avis/naissance')
// ⚠ ET L'ECHELLE EST UN CALCUL D'APP, ECRIT UNE SEULE FOIS. Decision de Thierry
// du 20 octobre 2026 : tout se ramene sur 5, un seul arrondi a la fin. Le
// module dit aussi POURQUOI « diviser Booking par deux mais pas Airbnb » serait
// faux : la mesure montre que les deux canaux arrivent deja sur 10.
const { noteSur5Des, sonnerSourcesInconnues } = require('../avis/echelle')

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
// ⚠ `ordres` EST UNE LISTE, et le DERNIER doit etre unique (constat R1). La
// premiere version ne prenait qu'une colonne : en passant a la pagination, la
// cle unique a chasse la cle d'AFFICHAGE, et la liste des logements s'est
// retrouvee triee par UUID — donc dans un ordre aleatoire, invisible a l'etape 0
// puisqu'il n'y a pas d'ecran, et herite tel quel par l'etape 1.
//
// ⚠ ET `faireQuery` DOIT CONSTRUIRE UNE REQUETE NEUVE (constat M6). PostgREST
// CONCATENE les `order` successifs sur un meme builder (`order=id.asc,id.asc`) :
// reutiliser le meme objet sur vingt pages entrelacerait les termes des qu'il y
// en a deux. C'est sans effet avec un seul ordre, et faux avec deux.
async function lirePagine (faireQuery, etiquette, ordres) {
  const liste = Array.isArray(ordres) ? ordres : [ordres]
  const tout = []
  for (let page = 0; page < MAX_PAGES; page++) {
    let q = faireQuery()
    for (const o of liste) q = q.order(o, { ascending: true })
    const { data, error } = await q
      .range(page * PAGE, page * PAGE + PAGE - 1)
    if (error) { const e = new Error(`${etiquette} : ${error.message}`); e.dbError = true; throw e }
    const lot = data || []
    tout.push(...lot)
    if (lot.length < PAGE) return tout
  }
  const e = new Error(`${etiquette} : ${MAX_PAGES * PAGE} lignes atteintes, lecture refusee`)
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
    // ⚠ `prix_minimum` EST EN CENTIMES, SEULE DE SES QUATRE VOISINES.
    // `base_price`, `included_guests` et `extra_guest_fee` sont en euros ;
    // celle-ci est en centimes, et son commentaire de colonne le dit
    // (migrations/0000-schema-initial.sql). Tous les autres lecteurs divisent
    // — pages/biens.html, apps/yield/index.html, lib/marche/etude.js — et
    // api/channel-property.js l'ECRIT en centimes.
    // Sans cette division, la fiche affichait « 13 000 € » pour le plancher de
    // 130 € du bien, juste sous un prix de base juste : la ligne la plus
    // sensible du bloc (la garde anti-nuit-a-0) etait fausse exactement quand
    // elle etait renseignee. Releve en revue de 5c0d759.
    prix_plancher: bien.prix_minimum != null ? Math.round(Number(bien.prix_minimum)) / 100 : null,
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
// ⚠ LES FERMETURES DE L'HOTE COMPTENT (decision de Thierry, 20 octobre 2026).
// Le prochain evenement REEL est le plus proche parmi : occupation en cours,
// fermeture en cours, prochaine arrivee, prochaine fermeture. « Libre » ne se dit
// que si RIEN ne couvre et rien ne vient — sans quoi l'ecran annoncerait
// « Libre jusqu'au… » sur une periode que l'hote a fermee lui-meme.
//
// ⚠ DEUX CONVENTIONS DE BORNES, ET ELLES DIFFERENT. Une reservation libere le
// logement LE JOUR DU DEPART (`arrival <= jour < departure`, convention des
// nuitees de tout le depot) ; une fermeture a ses bornes INCLUSES — « une
// fermeture du 12 au 20 couvre neuf nuits » (migrations/2026-09-21-fermetures.sql).
// Les traiter pareil decalerait d'un jour, dans un sens ou dans l'autre.
//
// ⚠ SI LES DEUX COUVRENT LE MEME JOUR, L'OCCUPATION GAGNE. Une reservation sur
// une periode fermee est le symptome de l'incident stop_sell : c'est un fait plus
// fort qu'une intention, et l'hote doit le voir.
//
// ⚠ UN BLOCAGE proprietaire (`blocked`) reste hors du compte : `isActiveStatus`
// ne retient que `confirmed`. Ecart nomme aux constats.
// ⚠ `sejoursLus: false` — les cles partenaire sont illisibles, donc on ne SAIT
// rien des reservations. On peut quand meme affirmer une FERMETURE (elle est par
// UUID, elle ne depend d'aucune cle) ; mais s'il n'y en a pas, on rend `null`.
// Ma premiere version rendait `type: 'libre'` dans ce cas : c'etait precisement
// le mensonge commercial que cette fonction existe pour empecher — « Libre »
// affiche parce qu'on n'a pas pu lire, pas parce que c'est vrai.
function faitDate (lignes, fermetures, jour, defaultProvider = null, { sejoursLus = true } = {}) {
  let depart = null
  let prochaine = null
  for (const l of lignes || []) {
    const s = l.snapshot || {}
    if (!isActiveStatus(s, defaultProvider)) continue
    const a = s.arrival ? String(s.arrival).slice(0, 10) : null
    const d = s.departure ? String(s.departure).slice(0, 10) : null
    if (!a || !d) continue
    if (a <= jour && jour < d) {
      if (!depart || d < depart) depart = d
    } else if (a > jour) {
      if (!prochaine || a < prochaine) prochaine = a
    }
  }

  let fermeJusquAu = null
  let prochaineFermeture = null
  for (const f of fermetures || []) {
    const du = f.date_debut ? String(f.date_debut).slice(0, 10) : null
    const au = f.date_fin ? String(f.date_fin).slice(0, 10) : null
    if (!du || !au) continue
    if (du <= jour && jour <= au) {
      if (!fermeJusquAu || au > fermeJusquAu) fermeJusquAu = au
    } else if (du > jour) {
      if (!prochaineFermeture || du < prochaineFermeture.du) prochaineFermeture = { du, au }
    }
  }

  const faits = {
    occupe: depart != null,
    depart,
    prochaine_arrivee: prochaine,
    ferme: fermeJusquAu != null,
    fermeture_jusqu_au: fermeJusquAu,
    prochaine_fermeture: prochaineFermeture,
    sejours_lus: sejoursLus
  }

  // Sans les sejours : une fermeture reste affirmable, « libre » non.
  if (!sejoursLus) {
    if (fermeJusquAu != null) return { ...faits, type: 'ferme', du: null, au: fermeJusquAu }
    if (prochaineFermeture) return { ...faits, type: 'fermeture', du: prochaineFermeture.du, au: prochaineFermeture.au }
    return null
  }

  // `type`, `du`, `au` : ce que l'ecran a besoin de savoir pour choisir UNE
  // phrase. Les faits restent a cote, pour qu'il puisse en dire plus.
  if (depart != null) return { ...faits, type: 'occupe', du: null, au: depart }
  if (fermeJusquAu != null) return { ...faits, type: 'ferme', du: null, au: fermeJusquAu }
  const arrivee = prochaine
  const fermeture = prochaineFermeture ? prochaineFermeture.du : null
  if (arrivee && (!fermeture || arrivee <= fermeture)) {
    return { ...faits, type: 'arrivee', du: arrivee, au: null }
  }
  if (fermeture) {
    return { ...faits, type: 'fermeture', du: fermeture, au: prochaineFermeture.au }
  }
  return { ...faits, type: 'libre', du: null, au: null }
}

// Les fermetures a venir ou en cours, par bien.
//
// ⚠ PAR LE MODULE DE L'APP, PAS PAR UNE REGLE RECOPIEE. `fermeturesDesBiens`
// porte la convention des bornes, la tolerance « table absente » et le refus de
// rendre un vide sur panne — « un vide par erreur ouvrirait », dit son en-tete.
//
// ⚠ IL NE FILTRE PAS PAR COMPTE : c'est la RLS qui le fait pour un client, et
// nous sommes en service key. Le cloisonnement vient donc d'AMONT — on ne lui
// passe que des UUID deja lus sous `.eq('user_id', compte)`.
//
// La fenetre : du jour a deux ans. Au-dela, aucune fermeture ne change ce qu'on
// affiche — la fenetre la plus large du produit (YieldFlow) est de 400 jours.
const FENETRE_FERMETURES_JOURS = 730
async function lireFermetures (sb, uuids, jour) {
  const fin = new Date(`${jour}T00:00:00Z`)
  fin.setUTCDate(fin.getUTCDate() + FENETRE_FERMETURES_JOURS)
  const { fermeturesDesBiens } = require('../fermetures')
  return fermeturesDesBiens(sb, uuids, jour, fin.toISOString().slice(0, 10))
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
  // ⚠ `total_proprete`, PAS `total` : la fiche assemble ce compteur AVEC celui
  // de la note, qui porte toutes les periodes. Deux champs nommes `total` dans
  // le meme objet, c'est le dernier ecrit qui gagne — et personne ne saurait
  // lequel il lit.
  return { fenetre_jours: FENETRE_AVIS_JOURS, total_proprete: lignes.length, ...compteur }
}

// ─────────────────────────────────────────────────────────────────────────────
// Les avis de la LISTE — la note, et le nombre TOTAL d'avis du logement
// ─────────────────────────────────────────────────────────────────────────────
//
// Demande de Thierry du 20 octobre 2026 : sur la carte de la liste, les avis
// prennent la place du fait date. « TOTAL » qualifie la PERIODE — tous les avis
// du logement, depuis toujours — et c'est ce qui distingue cette lecture de
// celle de la fiche, bornee a 30 jours parce qu'elle compte des pouces de
// proprete. Aucune borne de date n'est posee ici, et un test le verifie.
//
// ⚠ TROIS NOMBRES, PAS UN. `total` compte les avis, `notes` ceux qui portent une
// note, `note_sur_5` la note de ces derniers. Les confondre se mesure : en
// production le 20 octobre 2026, La bulle a 336 avis visibles dont 332 notes —
// les quatre autres sont des DETECTIONS DANS LES MESSAGES, qui n'ont pas de
// note. Une moyenne divisee par 336 serait fausse, et un total de 332 cacherait
// quatre avis reels.
//
// ⚠ LA NOTE DESCEND DEJA SUR 5, ET ELLE N'EST ARRONDIE QU'UNE FOIS (decision de
// Thierry du 20 octobre 2026). La conversion vit dans `lib/avis/echelle.js` et
// nulle part ailleurs : l'ecran AFFICHE `note_sur_5`, il ne divise plus rien.
// La version d'avant descendait une moyenne sur 10 arrondie, que l'ecran
// divisait et arrondissait a nouveau — deux arrondis, donc 9,65 affiche 4,9 au
// lieu de 4,8.
//
// ⚠ Lecture par UUID, comme la fiche : `ota_reviews` porte les deux cles, et
// l'UUID ne depend d'aucune migration — un bien en bascule garde ses avis.
async function lireAvisParBien (sb, compte, uuids, alarme) {
  const lignes = await lirePagine(() => avisQuiComptent(
    sb.from('ota_reviews').select('id, property_id, ota, overall_score, is_hidden, content, content_public'), compte)
    .in('property_id', uuids), 'avis de la liste', 'id')

  // Les avis retenus, logement par logement. On compte ici, on calcule la note
  // apres : `noteSur5Des` doit voir TOUTES les notes d'un bien d'un coup pour
  // n'arrondir qu'une fois.
  const retenus = new Map()
  const out = new Map()
  for (const u of uuids) { out.set(String(u), { total: 0, notes: 0, note_sur_5: null }); retenus.set(String(u), []) }
  for (const l of lignes) {
    const cle = String(l.property_id)
    const compteur = out.get(cle)
    if (!compteur) continue
    // ⚠ LA MEME PREUVE QUE PARTOUT AILLEURS, et pas une copie : un objet
    // d'avis visible mais vide n'est pas un avis.
    if (!voyageurAEcrit({ is_hidden: l.is_hidden, overall_score: l.overall_score, content: l.content || l.content_public })) continue
    compteur.total++
    retenus.get(cle).push(l)
  }
  for (const [cle, compteur] of out) {
    // ⚠ `null`, PAS 0 : un logement dont aucun avis ne porte de note n'a pas une
    // note de zero. C'est la meme regle que partout dans ce module.
    const { note_sur_5, notes } = noteSur5Des(retenus.get(cle))
    compteur.notes = notes
    compteur.note_sur_5 = note_sur_5
  }
  // ⚠ UNE SOURCE HORS TABLE SONNE, elle ne se contente pas d'un `console.warn`
  // que personne ne lit. Ses notes ne comptent dans aucune moyenne, et l'ecran
  // se tait : sans alarme, un canal nouveau ferait disparaitre les notes d'un
  // portefeuille entier sans que rien ne le dise.
  await sonnerSourcesInconnues(alarme)
  return out
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

  // ⚠ TROIS MOTIFS POUR UN NOM MANQUANT (constat M8). `nom_lu: true` avec
  // `nom: null` se produisait aussi quand la ligne `profiles` a DISPARU — profil
  // supprime : la lecture reussit et rend zero ligne. L'ecran affichait alors une
  // ligne d'equipe sans personne dessus, ce que ce drapeau devait fermer.
  return liaisons
    .sort((a, b) => Number(a.rang) - Number(b.rang))
    .map(l => ({
      nom: nomDe.get(String(l.provider_id)) || null,
      nom_motif: personnes == null ? 'lecture_impossible'
        : !nomDe.has(String(l.provider_id)) ? 'profil_absent'
        : nomDe.get(String(l.provider_id)) == null ? 'nom_vide'
        : null,
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
// ⚠ LE BAREME SEULEMENT, AUCUN MONTANT (decision de Thierry, 20 octobre 2026).
// `communale_cents` & co ne sont PAS un bareme : ce sont les montants COLLECTES
// sur une reservation. Ils relevent de `facturation` et restent hors de cette
// fiche. Ce qui descend ici est le parametrage : la commune, qui collecte,
// l'origine (transmis par le canal ou calcule), et si c'est inclus dans le prix.
//
// ⚠ PAR UUID *ET* PAR CLE TEXTE, et c'est le constat R2 de la re-revue.
// `taxes_sejour.property_uuid` est NULLABLE, et le writer ne la remplit que si
// `uuidDuBien` resout — or il cherche `properties.provider_property_id = <cle de
// la reservation>`. Pendant une bascule, les reservations arrivent sous la cle
// CIBLE alors que `provider_property_id` porte encore l'origine : la colonne
// reste donc NULL. Lire par le seul UUID faisait repondre « on a lu, il n'y a
// rien » sur un bien dont le coeur connait la taxe — exactement le « je ne sais
// pas » confondu avec « il n'y a rien » que ce module interdit.
// Le correctif propre est dans le WRITER (resoudre aussi par
// `migration_target_property_id`) : c'est une dette, notee aux constats. Ici on
// interroge les deux cles, et l'UUID d'abord pour garder l'index.
//
// ⚠ TOUJOURS UN OBJET (constat M5). Rendre `[]` pour « aucune ligne » et un
// objet sinon obligeait l'ecran a un `Array.isArray` pour distinguer trois
// etats : `taxe.commune` valait `undefined` sans erreur. `connue: false` dit
// « lu, et il n'y a rien » sans changer de type.
async function lireTaxe (sb, compte, uuid, clesText = []) {
  const COLS = 'commune, collecteur, origine, inclus_dans_prix, updated_at, property_uuid'
  const lire = (filtrer) => filtrer(sb.from('taxes_sejour').select(COLS).eq('user_id', compte))
    .order('updated_at', { ascending: false }).limit(1)

  let { data, error } = await lire(q => q.eq('property_uuid', uuid))
  if (error) throw new Error(`taxe : ${error.message}`)
  // Rien par l'UUID : le bien peut etre en migration, avec `property_uuid` NULL.
  if (!(data || []).length && clesText.length) {
    const second = await lire(q => q.in('property_id', clesText))
    if (second.error) throw new Error(`taxe : ${second.error.message}`)
    data = second.data
  }
  const l = (data || [])[0]
  if (!l) return { connue: false }
  // ⚠ `origine: 'absent'` VEUT DIRE « il n'y avait pas de taxe de sejour dans
  // cette reservation » — ce n'est donc PAS un bareme (decision de Thierry,
  // 20 octobre 2026, apres la recette staging). Le rendre `connue: true` faisait
  // afficher un bloc « Taxe de sejour » avec un collecteur, aucune commune et
  // aucun montant : un bloc vide qui a l'air plein. Mesure du jour :
  // Loft Pilotable, `origine: 'absent'`, `commune: null`.
  if (String(l.origine || '') === 'absent') return { connue: false, motif: 'aucune_taxe_transmise' }
  return {
    connue: true,
    commune: l.commune || null,
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
// ⚠ `serrures` MANQUAIT, et c'est le constat de securite de la RE-revue du
// 20 octobre. Le plus genant : les deux branches `refuses.includes('serrures')`
// etaient deja ecrites plus bas — l'intention etait la, l'entree de cette table
// ne l'etait pas, donc les branches etaient MORTES. `property_locks_select` et
// `locks_select` font toutes deux `can_read(user_id, 'reglages', …)`, et
// api/serrures.js declare `locks: ['reglages', 'read']`.
//
// ⚠ `taxe` -> `reglages` ET PAS `facturation` (decision de Thierry, 20 octobre) :
// la fiche ne montre que le BAREME — commune, qui collecte, origine. Les MONTANTS
// collectes restent sous `facturation`, et hors de cette fiche : voir `lireTaxe`.
const DROITS_DES_BLOCS = {
  menage: 'prestataires',
  avis: 'avis',
  taxe: 'reglages',
  serrures: 'reglages'
}

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
      // ⚠ DEUX LECTURES, DEUX QUESTIONS, ET ELLES NE SE CONFONDENT PAS
      // (decision de Thierry du 21 octobre 2026).
      //   · la NOTE : la meme que sur la carte de la liste — toutes periodes,
      //     convertie sur 5 et arrondie une seule fois. « Les deux ecrans
      //     doivent dire la meme chose » : c'est pour ca qu'elle passe par la
      //     MEME fonction, et pas par un calcul propre a la fiche ;
      //   · les POUCES : la proprete seule, sur 30 jours, parce qu'une remarque
      //     de menage d'il y a six mois ne dit plus rien de l'etat du bien.
      const pouces = await lireAvis(sb, compte, bien.id, jour)
      const parBien = await lireAvisParBien(sb, compte, [String(bien.id)])
      const note = parBien.get(String(bien.id)) || { total: 0, notes: 0, note_sur_5: null }
      fiche.avis = { ...pouces, ...note, proprete_sur_jours: pouces.fenetre_jours }
    } catch (e) {
      console.error('[logement] avis illisibles :', e.message)
      fiche.avis = null
      indisponibles.push('avis')
    }
  }

  // ─── Les cles du bien, AVANT la taxe : elle en a besoin pour un bien en
  //     migration (constat R2), alors que les autres blocs UUID les ignorent.
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
  // ⚠ `cles_motif` A QUITTE LE CONTRAT le 21 octobre 2026 (decision de Thierry,
  // dette 80). Il etait descendu dans la reponse publique et lu par AUCUN
  // ecran : la spec §1 du lot interdit le code dormant, et une donnee que
  // personne ne consomme finit par etre gardee « au cas ou » par la prochaine
  // lecture. Le diagnostic qu'il portait reste utile, mais c'est une trace
  // SERVEUR, pas une information d'hote — elle part donc au journal, ou le
  // support la lit, et `tests/logement-lecture.test.js` garde son absence du
  // contrat.
  if (clesEnEchec) console.warn('[logement] cles du bien illisibles, blocs TEXT non lus :', String(bien.id))
  else if (!cles.length) console.info('[logement] bien sans cle partenaire, blocs TEXT vides :', String(bien.id))

  // Taxe : par UUID d'abord, et par cle TEXTE en second recours. Elle n'est donc
  // PAS emportee par des cles illisibles — on lui passe ce qu'on a, fut-ce rien.
  if (refuses.includes('taxe')) {
    fiche.taxe = null
  } else {
    try {
      fiche.taxe = await lireTaxe(sb, compte, bien.id, clesEnEchec ? [] : cles)
    } catch (e) {
      console.error('[logement] taxe illisible :', e.message)
      fiche.taxe = null
      indisponibles.push('taxe')
    }
  }

  // ⚠ SI LES CLES SONT ILLISIBLES, AUCUN BLOC TEXT N'EST LU. Un bloc vide
  // signifierait « il n'y a rien » ; ici on ne SAIT pas, et le bien pourrait
  // etre en migration. On refuse de deviner, et chaque bloc le dit.
  if (clesEnEchec || !cles.length) {
    for (const bloc of ['menage', 'serrures']) {
      if (refuses.includes(bloc)) { fiche[bloc] = null; continue }
      // Pas de cle du tout n'est pas une panne : un bien cree a la main et jamais
      // provisionne n'a simplement rien a montrer dans ces blocs.
      fiche[bloc] = clesEnEchec ? null : []
      if (clesEnEchec) indisponibles.push(bloc)
    }
    // ⚠ MAIS LE FAIT DATE RESTE PARTIELLEMENT LISIBLE : les fermetures sont par
    // UUID, donc independantes des cles partenaire. Un bien sans cle peut etre
    // FERME par son hote, et le taire afficherait « Libre » sur une periode
    // fermee — ce que la decision du 20 octobre interdit.
    try {
      const parBien = await lireFermetures(sb, [String(bien.id)], jour)
      fiche.fait_date = faitDate([], parBien[String(bien.id)] || [], jour, bien.provider,
        { sejoursLus: !clesEnEchec })
      // Sans les sejours, « occupe » n'est pas calculable : on le dit, et le bloc
      // se nomme meme s'il a pu affirmer une fermeture — l'ecran doit savoir
      // qu'une reservation pourrait s'y ajouter.
      if (clesEnEchec) indisponibles.push('fait_date')
    } catch (e) {
      console.error('[logement] fermetures illisibles :', e.message)
      fiche.fait_date = null
      indisponibles.push('fait_date')
    }
    fiche.indisponibles = indisponibles
    fiche.refuses = refuses
    return fiche
  }

  const blocs = [
    ['fait_date', async () => {
      const [sejours, parBien] = await Promise.all([
        lireSejours(sb, compte, cles, jour),
        lireFermetures(sb, [String(bien.id)], jour)
      ])
      return faitDate(sejours, parBien[String(bien.id)] || [], jour, bien.provider)
    }],
    ['menage',    () => lireMenage(sb, compte, cles)],
    ['serrures',  () => lireSerrures(sb, compte, cles)]
  ].filter(([nom]) => !refuses.includes(nom))
  // `fait_date` n'appartient a aucun domaine particulier (il vient des
  // reservations, qui sont la garde d'entree) : il n'est jamais refuse.
  for (const nom of ['menage', 'serrures']) {
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
// ⚠ ET CE JOUR EST ARRIVE : `droits` EST REVENU AVEC SA GARDE. Le commentaire
// d'avant disait « pas de droits ici, la liste ne porte aucun bloc d'un autre
// domaine que `reservations` » — c'etait vrai jusqu'au 20 octobre 2026, ou
// Thierry a demande les avis sur la carte. `ota_reviews` est gardee par
// `can_read(user_id, 'avis', …)`, et cet endpoint tourne en service key, qui
// contourne la RLS par conception : sans cette garde, un co-hote invite avec
// `avis: none` recevrait la note de chaque logement du portefeuille.
//
// ⚠ ET `refuses` NE PORTE QUE `avis` (constat M4, qui tient toujours). La liste
// ne lit ni menage, ni taxe, ni serrures : annoncer leur refus ferait croire a
// l'ecran qu'un bloc a ete cache alors qu'il n'a jamais ete demande.
async function lireListe (sb, { compte, refsPerimetre = null, maintenant = new Date(), droits = null }) {
  // Un seul bloc d'un autre domaine sur la liste, donc un seul refus possible.
  //
  // ⚠ ET LE DEFAUT ECHOUE FERME, contrairement a `blocsRefuses` (constat M3 de
  // la revue). La fiche assume un defaut OUVERT — « lecture interne, script » —
  // et c'etait sans consequence sur la liste tant qu'elle ne lisait aucune
  // table d'un autre domaine. Depuis qu'elle lit `ota_reviews`, un appelant qui
  // oublierait `droits` servirait les notes de tout un portefeuille EN SERVICE
  // KEY, donc sans RLS. Le voisinage immediat fait deja ce choix : perimetre
  // vide => ferme, aucune reference sure => ferme.
  const refuses = droits ? blocsRefuses(droits).filter(b => b === 'avis') : ['avis']
  const jour = jourParis(maintenant)

  // Perimetre vide : on echoue FERME, on n'elargit pas.
  if (Array.isArray(refsPerimetre) && refsPerimetre.length === 0) {
    return { biens: [], indisponibles: [], refuses }
  }

  // ⚠ UNE FABRIQUE, PAS UN BUILDER (constat M6) : `lirePagine` rejoue la requete
  // a chaque page, et PostgREST concatene les `order` sur un meme objet.
  let orFiltre = null
  if (Array.isArray(refsPerimetre)) {
    // ⚠ LE PIEGE UUID, QUI A DEJA COUTE QUATRE FOIS. `properties.id` est de type
    // uuid : y passer une reference partenaire numerique (« 209413 ») fait
    // echouer la requete ENTIERE en 22P02 — pas rendre zero ligne. Le membre
    // lisait « Erreur de chargement » et croyait a une panne. La branche `id` ne
    // recoit donc que des UUID, et n'est pas emise s'il n'y en a aucun. Les deux
    // motifs sont IMPORTES de la garde, jamais recopies.
    const sures = refsPerimetre.map(String).filter(r => REF_SURE_RE.test(r))
    if (!sures.length) return { biens: [], indisponibles: [], refuses }
    const uuids = sures.filter(r => UUID_RE.test(r))
    const filtres = [`provider_property_id.in.(${sures.join(',')})`]
    if (uuids.length) filtres.unshift(`id.in.(${uuids.join(',')})`)
    orFiltre = filtres.join(',')
  }
  const requeteBiens = () => {
    const base = sb.from('properties').select(COLONNES_BIEN).eq('user_id', compte)
    return orFiltre ? base.or(orFiltre) : base
  }

  // ⚠ UNE LISTE DE BIENS ILLISIBLE SE LEVE. Un 200 a liste vide est la pire des
  // reponses : l'ecran dit « Ajoutez votre premier logement » a un hote qui en a
  // quatre, et l'onboarding reconcilie contre du vide, ce qui CREE des biens en
  // double chez le canal. Lecon de la garde aveugle : c'est pour ca que `biens`
  // n'a pas de troisieme etat.
  let lignes
  try {
    // ⚠ DEUX ORDRES : le nom pour l'ECRAN, l'id pour que la pagination soit
    // deterministe. La version d'avant ne paginait que par `id`, donc servait la
    // liste dans un ordre aleatoire (constat R1).
    lignes = await lirePagine(requeteBiens, 'biens', ['name', 'id'])
  } catch (e) {
    e.panne = true
    throw e
  }
  // ⚠ `refuses` NE PORTE QUE `avis` (constat M4, toujours vrai pour les autres).
  // La liste ne lit ni menage, ni taxe, ni serrures : annoncer leur refus ici
  // ferait croire a l'ecran qu'un bloc a ete cache, alors qu'il n'a jamais ete
  // demande.
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

  // Les fermetures de tous les biens, par UUID : independantes des cles.
  let fermeturesParBien = null
  try {
    fermeturesParBien = await lireFermetures(sb, idsUuid, jour)
  } catch (e) {
    console.error('[logement] fermetures de la liste illisibles :', e.message)
    indisponibles.push('fait_date')
  }

  // Les avis de tous les biens, en UNE lecture paginee. ⚠ LE DROIT SE VERIFIE
  // AVANT LA LECTURE : une fois la donnee sortie de la base, il est trop tard
  // pour decider qu'on n'avait pas le droit de la lire.
  let avisParBien = null
  if (!refuses.includes('avis')) {
    try {
      avisParBien = await lireAvisParBien(sb, compte, idsUuid)
    } catch (e) {
      console.error('[logement] avis de la liste illisibles :', e.message)
      indisponibles.push('avis')
    }
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
    if (sejoursParCle && cles && fermeturesParBien) {
      fait = faitDate(cles.flatMap(c => sejoursParCle.get(String(c)) || []),
        fermeturesParBien[k] || [], jour, b.provider)
    }
    return {
      ...publier(b),
      canaux,
      canaux_vu_le: vuLe,
      canaux_echec: canauxParBien ? ((canaux || []).length > 0 && (horlogeEnPanne || echecVisibleParLHote(horlogeLigne))) : false,
      fait_date: fait,
      // ⚠ `null` SI ON N'A PAS PU LIRE OU SI ON N'A PAS LE DROIT, jamais un
      // compteur a zero : « Aucun avis » sur un logement qui en a 336 est le
      // meme mensonge que « Libre » sur un bien complet.
      // ⚠ `?? null` ET PAS UN COMPTEUR A ZERO (constat m5). La Map est amorcee
      // pour chaque uuid, donc ce repli ne se declenche pas — mais s'il se
      // declenchait, rendre « 0 avis » dirait « lu, et vide » la ou on ne sait
      // rien. C'est exactement ce que la ligne du dessus interdit.
      avis: avisParBien ? (avisParBien.get(k) ?? null) : null   // { total, notes, note_sur_5 }
    }
  })

  return { biens, indisponibles: Array.from(new Set(indisponibles)), refuses }
}

// ──────────────────────────────────────────────────────────────────────────────
// Ce que la suppression va effacer, en nombres
// ──────────────────────────────────────────────────────────────────────────────
//
// Demande de Thierry du 21 octobre 2026 : « la confirmation dit ce qui sera
// effacé, avec les nombres ». L'étape 2 l'avait inscrit comme dépendance de
// l'étape 3 ; le voici.
//
// ⚠ ON COMPTE AVEC LA CLÉ QUE LA PURGE UTILISE, ET AVEC AUCUNE AUTRE.
// `DELETE /api/channel-property` purge les tables enfant sur
// `prop.provider_property_id` SEUL — pas sur la clé CIBLE d'une migration, et
// sans écarter les clés migrées comme le fait `clesTextDuBien` pour l'affichage.
// Compter autrement annoncerait à l'hôte des lignes qui resteront, ou tairait
// celles qui partiront. Un chiffre de confirmation ne vaut que s'il décrit le
// geste réel.
//
// ⚠ ET UN BIEN SANS CLÉ PARTENAIRE N'EFFACE RIEN DE LIÉ : la purge entière est
// sous `if (providerId)`. On le DIT (`cle_absente`), au lieu d'afficher quatre
// zéros qui se liraient comme « on a regardé, il n'y a rien ».
//
// ⚠ UNE LECTURE RATÉE REND `null`, JAMAIS ZÉRO. C'est la règle de tout ce lot :
// « on n'a pas pu lire » n'est pas « il n'y en a pas », et ici la confusion
// ferait supprimer un bien en croyant ne rien perdre.
const COMPTES_DE_SUPPRESSION = [
  { nom: 'reservations', table: 'bookings_snapshot', avecCompte: true },
  { nom: 'messages', table: 'messages', avecCompte: true },
  { nom: 'menages', table: 'menage_events', avecCompte: true },
  // `access_codes` n'a pas de colonne `user_id` — la purge la filtre sur
  // `property_id` seul, et on compte pareil.
  { nom: 'codes', table: 'access_codes', avecCompte: false }
]

async function compterPourSuppression (sb, { compte, bien }) {
  const brute = bien && bien.provider_property_id
  const cle = brute != null && String(brute).trim() !== '' ? String(brute) : null
  const vide = { cle_absente: true, reservations: 0, messages: 0, menages: 0, codes: 0 }
  if (!cle) return vide

  const out = { cle_absente: false }
  for (const c of COMPTES_DE_SUPPRESSION) {
    try {
      let q = sb.from(c.table).select('*', { count: 'exact', head: true }).eq('property_id', cle)
      if (c.avecCompte) q = q.eq('user_id', compte)
      const { count, error } = await q
      if (error) throw new Error(error.message)
      out[c.nom] = Number.isFinite(Number(count)) ? Number(count) : null
    } catch (e) {
      console.error(`[logement] comptage ${c.table} illisible :`, e.message)
      out[c.nom] = null
    }
  }
  return out
}

module.exports = {
  lireFiche,
  lireListe,
  compterPourSuppression,
  // exportes pour les tests, et pour qu'une regle ne soit ecrite qu'une fois
  publier,
  faitDate,
  suppressionPossible,
  clesTextDuBien,
  blocsRefuses,
  jourParis,
  DROITS_DES_BLOCS,
  FENETRE_AVIS_JOURS,
  FENETRE_FERMETURES_JOURS,
  PAGE,
  MAX_PAGES
}
