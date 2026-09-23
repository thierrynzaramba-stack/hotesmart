// lib/yield/comparable.js — QUELLE NUIT DE L'AN DERNIER SE COMPARE A CELLE-CI.
// Lot 4.4 (passe 3) de l'etape 4. Spec : docs/specs/spec-yieldflow-v1.md §7.3.
// DOC : docs/kb/suggestion-yield.md (modif = MEME COMMIT)
//
// ⚠ LA DATE CALENDAIRE N'EST PAS LA BONNE REPONSE, ET LE DECALAGE DE 364 JOURS
// NON PLUS. Comparer le 1er octobre 2026 (jeudi) au 1er octobre 2025
// (mercredi) melange une nuit de semaine avec une autre. Reculer de 52 semaines
// corrige le jour de semaine — mais casse les rendez-vous du calendrier : la
// Toussaint ne tombe pas 364 jours apres la precedente, et les vacances
// d'hiver glissent.
//
// ⚠ LA CASCADE, ARBITREE PAR THIERRY (13 septembre 2026). Du plus precis au
// plus general, PREMIER ETAGE QUI TROUVE :
//
//   a) evenement a DATE FIXE        31/12 ↔ 31/12, 14/07 ↔ 14/07
//   b) position dans l'evenement MOBILE  samedi de la 1re semaine de Toussaint
//                                   ↔ samedi de la 1re semaine de Toussaint N-1
//   c) meme segment + meme jour de semaine + RANG DANS LE MOIS
//                                   2e vendredi hors vacances ↔ idem N-1
//   d) aucun comparable             « pas de comparable », JAMAIS un chiffre force
//
// ⚠ L'ETAGE d N'EST PAS UN ECHEC, C'EST UNE REPONSE. Un repli silencieux sur
// 52 semaines rendrait un chiffre credible et faux — un samedi de vacances
// compare a un samedi ordinaire. « Je ne sais pas » est un motif distinct de
// « non » : c'est la regle qui traverse tout ce chantier.
//
// ⚠ PAS DE SUR-INGENIERIE AU-DELA DE CES QUATRE ETAGES (consigne explicite).
// Si un cas exotique resiste, il ressort en d.
//
// ⚠ FONCTIONS PURES. Ni base, ni reseau, ni horloge : le contexte de
// segmentation arrive de l'appelant, et il doit COUVRIR la fenetre N-1.
//
// ⚠ LA NUIT COMPARABLE EST CHOISIE SUR SA COMPARABILITE, PAS SUR SON SUCCES.
// On ne cherche pas « une nuit qui s'est vendue » : ce serait retenir les
// bonnes annees et jeter les mauvaises, donc afficher un N-1 systematiquement
// flatteur. Si la nuit comparable n'a pas ete vendue, on le dit.

const { estJourISO } = require('./capacite')
const { segmenterJour, SEGMENTS, jourDeSemaine } = require('./reference')
const { joursFeriesDeLAnnee } = require('./jours-feries')
const { DATES: DATES_COMMERCIALES, occurrences } = require('./dates-commerciales')

// ⚠ LES DATES QUI SE COMPARENT DATE A DATE VIENNENT DE LEUR SOURCE — regle 13.
// Jusqu'au 23 septembre 2026, une liste recopiee ici (« 12-24 », « 12-31 »)
// ignorait la troisieme date commerciale du systeme : la Saint-Valentin 2027
// (un dimanche) cherchait « le 2e dimanche de fevrier » N-1, n'en trouvait
// aucun du meme segment, et rendait « pas de comparable » — alors que le
// 14 fevrier 2026 s'etait vendu 295 €, la nuit la plus chere de La bulle.
//
// La source est `dates-commerciales.js`, lue A TRAVERS LE CONTEXTE : une date
// que l'hote a desactivee n'y figure pas, et sa nuit se compare alors par sa
// nature, comme il l'a decide. La comparer date a date quand meme ferait
// remonter « 295 € l'an dernier » sur un dimanche qu'il dit ordinaire.

// ⚠ COMBIEN UN EVENEMENT PEUT GLISSER D'UNE ANNEE SUR L'AUTRE, au plus.
// Assez large pour suivre une saison qui se decale de deux mois ; assez etroit
// pour qu'une SECONDE occurrence de la meme annee ne soit jamais prise pour
// celle de l'an dernier.
const TOLERANCE_ANNEE = 75

const ETAGES = {
  DATE_FIXE: 'a',
  // ⚠ a-BIS : L'EVENEMENT DE L'HOTE PASSE AVANT TOUT LE RESTE.
  // Il sait, lui, que sa saison thermale de 2026 se compare a celle de 2025 —
  // aucune regle de calendrier ne peut le deviner. C'est l'appariement le plus
  // sur du moteur, parce qu'il vient de la connaissance du terrain.
  EVENEMENT_HOTE: 'a-bis',
  EVENEMENT_MOBILE: 'b',
  RANG_DANS_LE_MOIS: 'c',
  AUCUN: 'd'
}

// ⚠ LES RAISONS DU « PAS DE COMPARABLE » SONT DES CONSTANTES, PAS DES CHAINES
// SEMEES DANS LE CODE. L'ecran les affiche a l'hote : `tests/yield-motifs.js`
// DERIVE la liste d'ici et echoue si l'une n'a pas sa traduction (regle 13 —
// ne jamais recopier une liste de reference).
const RAISONS = {
  SEGMENT_INCONNU: 'segment_de_la_nuit_inconnu',
  FERIE_ABSENT: 'ferie_absent_de_l_an_dernier',
  PONT_ABSENT: 'pont_absent_de_l_an_dernier',
  PERIODE_INTROUVABLE: 'periode_de_vacances_introuvable',
  VACANCES_ABSENTES: 'vacances_absentes_de_l_an_dernier',
  JOUR_ABSENT_DES_VACANCES: 'jour_de_semaine_absent_des_vacances_n1',
  AUCUN_JOUR_CE_MOIS: 'aucun_jour_comparable_ce_mois_la',
  EVENEMENT_ABSENT: 'evenement_absent_de_l_an_dernier'
}

const ALIGNEMENTS = {
  EVENEMENT_HOTE: 'meme_evenement_de_l_hote',
  EVENEMENT_HOTE_POSITION: 'meme_position_dans_l_evenement_de_l_hote',
  FERIE_FIXE: 'meme_date_ferie_fixe',
  DATE_COMMERCIALE: 'meme_date_commerciale',
  SAMEDI_RATTACHE: 'meme_samedi_rattache',
  SAMEDI_VERS_LA_DATE: 'samedi_rattache_vers_la_date',
  POSITION_VACANCES: 'meme_position_dans_les_vacances',
  JOUR_DANS_VACANCES: 'meme_jour_de_semaine_dans_les_vacances',
  FERIE_MOBILE: 'meme_ferie_mobile',
  PONT: 'meme_pont',
  RANG_DANS_LE_MOIS: 'meme_rang_dans_le_mois',
  RANG_LE_PLUS_PROCHE: 'rang_le_plus_proche_dans_le_mois',
  AUCUN: 'pas_de_comparable'
}

function decaler (iso, n) {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function joursEntre (debut, fin) {
  const out = []
  let j = debut
  // Garde-fou : une periode de plus de deux ans vient d'une donnee aberrante.
  for (let i = 0; j <= fin && i < 800; i++) { out.push(j); j = decaler(j, 1) }
  return out
}

/**
 * Un ferie est-il a DATE FIXE ? Question posee aux donnees, jamais a une liste
 * recopiee (regle 13 du depot) : on compare la date du meme libelle d'une annee
 * sur l'autre. « Toussaint » tombe le 1er novembre les deux fois -> fixe ;
 * « Lundi de Paques » se deplace -> mobile.
 */
function ferieADateFixe (iso, libelle) {
  const an = Number(iso.slice(0, 4))
  const precedent = joursFeriesDeLAnnee(an - 1)
  for (const [j, nom] of precedent) {
    if (nom === libelle) return { fixe: j.slice(5) === iso.slice(5), date: j }
  }
  return null
}

/** La periode de vacances qui contient ce jour, telle que le contexte la voit. */
function periodeDeVacances (iso, s, contexte) {
  const zone = s.segment === SEGMENTS.VACANCES_ZONE ? contexte.zoneBien : null
  const candidates = (contexte.vacances || []).filter(v => v && v.nom === s.libelle &&
    iso >= v.date_debut && iso <= v.date_fin && (!zone || v.zone === zone))
  return candidates[0] || null
}

/**
 * LA NUIT DE L'AN DERNIER A LAQUELLE CELLE-CI SE COMPARE.
 *
 * @param {string} date       la nuit visee ('2026-10-03')
 * @param {Object} options    { contexte } — sortie de `construireContexte`,
 *                            COUVRANT la fenetre N-1
 * @returns {Object} toujours un objet, jamais null pour une date valide :
 *   - date        la nuit comparable, ou `null` a l'etage d
 *   - etage       'a' | 'b' | 'c' | 'd'
 *   - alignement  la regle exacte qui a tranche
 *   - meme_jour / meme_segment  ce que l'appariement a tenu ou lache
 */
function nuitComparable (date, options = {}) {
  const { contexte = {} } = options
  if (!estJourISO(date)) return null
  const s = segmenterJour(date, contexte)
  if (!s || !s.segment) return aucun(date, RAISONS.SEGMENT_INCONNU)

  // ─── a-bis) L'EVENEMENT DE L'HOTE, AVANT TOUT LE RESTE ──────────────────
  // ⚠ SA CONNAISSANCE PASSE DEVANT NOS REGLES DE CALENDRIER. Si l'hote a
  // declare « Saison thermale » les deux annees, c'est son appariement qui
  // fait foi : ni le rang dans le mois ni la position dans des vacances ne
  // savent qu'une saison thermale existe.
  //
  // ⚠ ET S'IL NE L'A PAS DECLARE L'AN DERNIER, ON NE DESCEND PAS D'UN CRAN
  // SILENCIEUSEMENT. Comparer une nuit de saison thermale a un « 2e mardi de
  // mai hors vacances » rendrait un chiffre credible et faux : c'est « pas de
  // comparable », et l'ecran dira que l'evenement manque a l'an dernier.
  if (String(s.segment).startsWith('evenement:')) {
    const occurrences = (contexte.evenements || [])
      .filter(e => e && e.segment === s.segment)
    const ici = occurrences.find(e => date >= e.date_debut && date <= e.date_fin)
    // L'occurrence de l'an dernier : celle dont le debut precede d'environ un
    // an. On ne remonte pas plus loin — deux ans d'ecart n'est plus « N-1 ».
    // ⚠ « L'AN DERNIER », PAS « LA FOIS PRECEDENTE » — releve en review.
    // La premiere version ne filtrait que `date_debut < ici.date_debut` puis
    // prenait la plus recente : pour un evenement qui revient DEUX FOIS PAR AN
    // (une brocante de mars et une d'aout), la nuit d'aout 2026 s'appariait a
    // celle de mars 2026 — trois mois plus tot, dans la MEME annee — pendant
    // que l'occurrence d'aout 2025 existait et etait ignoree. L'ecran publiait
    // ce prix sous « le reel de l'an dernier ».
    // On exige donc une occurrence dont le debut precede d'ENVIRON un an.
    const vise = decaler(ici.date_debut, -365)
    const avant = occurrences
      .filter(e => e.date_debut < ici.date_debut)
      .filter(e => Math.abs(ecart(e.date_debut, vise)) <= TOLERANCE_ANNEE)
      .sort((a, b) => Math.abs(ecart(a.date_debut, vise)) - Math.abs(ecart(b.date_debut, vise)) ||
        a.date_debut.localeCompare(b.date_debut))[0]
    if (!ici || !avant) return aucun(date, RAISONS.EVENEMENT_ABSENT)
    // ⚠ LA POSITION DANS L'EVENEMENT, comme pour les vacances : le 3e samedi
    // de la saison thermale contre le 3e samedi de la saison thermale. Une
    // saison de trois mois comparee date a date opposerait son ouverture a son
    // creux de milieu de periode.
    const memeJour = j => jourDeSemaine(j) === s.jour_semaine
    const rangIci = joursEntre(ici.date_debut, date).filter(memeJour).length - 1
    const candidats = joursEntre(avant.date_debut, avant.date_fin).filter(memeJour)
    if (!candidats.length) return aucun(date, RAISONS.EVENEMENT_ABSENT)
    const t = rangIci < candidats.length ? candidats[rangIci] : candidats[candidats.length - 1]
    return decrire(date, t, contexte, ETAGES.EVENEMENT_HOTE,
      rangIci < candidats.length
        ? ALIGNEMENTS.EVENEMENT_HOTE_POSITION : ALIGNEMENTS.EVENEMENT_HOTE,
      s, { rang: rangIci + 1,
        rang_n1: rangIci < candidats.length ? rangIci + 1 : candidats.length })
  }

  // ─── a) EVENEMENT A DATE FIXE ───────────────────────────────────────────
  // Les dates commerciales actives : la date elle-meme se compare a la meme
  // date N-1 ; le samedi RATTACHE (Saint-Valentin tombee en semaine) au samedi
  // rattache N-1 — et s'il n'y en a pas eu (le 14 tombait un vendredi, un
  // samedi ou un dimanche), a la date elle-meme N-1, qui etait alors la nuit
  // fetee.
  const commerciale = s.origine === 'commercial'
    ? (contexte.evenements || []).find(e => e && e.origine === 'commercial' &&
      e.segment === s.segment && date >= e.date_debut && date <= e.date_fin)
    : null
  if (commerciale) {
    const an = Number(date.slice(0, 4)) - 1
    const def = DATES_COMMERCIALES.find(d => d.cle === commerciale.cle)
    const laDate = def
      ? `${an}-${String(def.mois).padStart(2, '0')}-${String(def.jour).padStart(2, '0')}` : null
    if (commerciale.principale !== false) {
      const t = `${an}-${date.slice(5)}`
      if (estJourISO(t)) {
        return decrire(date, t, contexte, ETAGES.DATE_FIXE, ALIGNEMENTS.DATE_COMMERCIALE, s)
      }
    } else if (def) {
      const rattache = occurrences(def, `${an}-01-01`, `${an}-12-31`).find(o => !o.principale)
      if (rattache) {
        return decrire(date, rattache.date, contexte, ETAGES.DATE_FIXE,
          ALIGNEMENTS.SAMEDI_RATTACHE, s)
      }
      if (estJourISO(laDate)) {
        return decrire(date, laDate, contexte, ETAGES.DATE_FIXE,
          ALIGNEMENTS.SAMEDI_VERS_LA_DATE, s)
      }
    }
  }
  if (s.segment === SEGMENTS.FERIE && s.libelle) {
    const f = ferieADateFixe(date, s.libelle)
    if (f && f.fixe) {
      return decrire(date, f.date, contexte, ETAGES.DATE_FIXE, ALIGNEMENTS.FERIE_FIXE, s)
    }
    // ─── b) FERIE MOBILE : le meme ferie, ou qu'il tombe ───────────────────
    // Paques peut se decaler de pres d'un mois d'une annee sur l'autre ; c'est
    // l'annuaire des feries qui donne la date, pas une recherche a l'aveugle.
    if (f && !f.fixe) {
      return decrire(date, f.date, contexte, ETAGES.EVENEMENT_MOBILE,
        ALIGNEMENTS.FERIE_MOBILE, s)
    }
    return aucun(date, RAISONS.FERIE_ABSENT)
  }

  // ─── b) PONT ────────────────────────────────────────────────────────────
  // Le libelle vaut « pont <ferie> » : le pont de l'Ascension se compare au
  // pont de l'Ascension, jamais a celui du 8 mai.
  if (s.segment === SEGMENTS.PONT && s.libelle) {
    const estPont = j => {
      const c = segmenterJour(j, contexte)
      return c && c.segment === SEGMENTS.PONT && c.libelle === s.libelle
    }
    // ⚠ LE MEME JOUR DE SEMAINE D'ABORD, LE PLUS PROCHE ENSUITE.
    // Un pont n'a pas de jour de semaine fixe : le 11 novembre 2026 est un
    // mercredi et produit quatre ponts (lundi, mardi, jeudi, vendredi), quand
    // celui de 2025 tombait un mardi et n'en produisait qu'un, le lundi. On
    // cherche donc le pont du meme ferie qui tombe le meme jour de semaine ;
    // s'il n'existe pas, un pont reste plus comparable a un pont qu'a un
    // vendredi ordinaire, et on prend le plus proche EN LE DISANT.
    const t = chercher(decaler(date, -364), 42, 7, estPont) ||
      chercher(decaler(date, -364), 40, 1, estPont)
    return t
      ? decrire(date, t, contexte, ETAGES.EVENEMENT_MOBILE, ALIGNEMENTS.PONT, s)
      : aucun(date, RAISONS.PONT_ABSENT)
  }

  // ─── b) POSITION DANS L'EVENEMENT MOBILE : LES VACANCES ─────────────────
  if (s.segment === SEGMENTS.VACANCES_ZONE || s.segment === SEGMENTS.VACANCES_AUTRE) {
    const p = periodeDeVacances(date, s, contexte)
    if (!p) return aucun(date, RAISONS.PERIODE_INTROUVABLE)
    // L'occurrence N-1 des MEMES vacances : celle dont le debut est le plus
    // proche d'un an en arriere. Les vacances d'hiver glissent de plusieurs
    // jours — c'est exactement le cas que cet etage existe pour traiter.
    const memes = (contexte.vacances || []).filter(v => v && v.nom === p.nom &&
      v.zone === p.zone && v.date_debut < p.date_debut)
    if (!memes.length) return aucun(date, RAISONS.VACANCES_ABSENTES)
    const vise = decaler(p.date_debut, -365)
    const n1 = memes.sort((a, b) =>
      Math.abs(ecart(a.date_debut, vise)) - Math.abs(ecart(b.date_debut, vise)))[0]
    // Trop loin d'un an : ce n'est plus l'occurrence precedente.
    if (Math.abs(ecart(n1.date_debut, vise)) > 60) {
      return aucun(date, RAISONS.VACANCES_ABSENTES)
    }
    // ⚠ LA POSITION, PAS LA DATE : le n-ieme <jour de semaine> DE l'evenement.
    // « Samedi de la 1re semaine de la Toussaint » se compare au samedi de la
    // 1re semaine de la Toussaint, meme si les vacances ont glisse de six
    // jours. Comparer les dates aurait apparie une premiere semaine a une
    // deuxieme, c'est-a-dire le plein a l'inter-semaine.
    const memeJour = j => jourDeSemaine(j) === s.jour_semaine
    const rangIci = joursEntre(p.date_debut, date).filter(memeJour).length - 1
    const candidats = joursEntre(n1.date_debut, n1.date_fin).filter(memeJour)
    if (!candidats.length) return aucun(date, RAISONS.JOUR_ABSENT_DES_VACANCES)
    if (rangIci < candidats.length) {
      return decrire(date, candidats[rangIci], contexte, ETAGES.EVENEMENT_MOBILE,
        ALIGNEMENTS.POSITION_VACANCES, s, { rang: rangIci + 1, rang_n1: rangIci + 1 })
    }
    // La position n'existe pas (vacances N-1 plus courtes) : meme jour de
    // semaine DANS l'evenement, le dernier — et on dit que le rang a cede.
    return decrire(date, candidats[candidats.length - 1], contexte,
      ETAGES.EVENEMENT_MOBILE, ALIGNEMENTS.JOUR_DANS_VACANCES, s,
      { rang: rangIci + 1, rang_n1: candidats.length })
  }

  // ─── c) MEME SEGMENT + MEME JOUR DE SEMAINE + RANG DANS LE MOIS ─────────
  // Le cas ordinaire : hors vacances. Le 2e vendredi hors vacances d'octobre
  // se compare au 2e vendredi hors vacances d'octobre N-1.
  const memeSegmentDuMois = (annee, mois) => {
    const debut = `${annee}-${String(mois).padStart(2, '0')}-01`
    const fin = new Date(Date.UTC(annee, mois, 0)).toISOString().slice(0, 10)
    return joursEntre(debut, fin).filter(j => {
      if (jourDeSemaine(j) !== s.jour_semaine) return false
      const c = segmenterJour(j, contexte)
      return c && c.segment === s.segment
    })
  }
  const an = Number(date.slice(0, 4))
  const mois = Number(date.slice(5, 7))
  const ici = memeSegmentDuMois(an, mois)
  const rang = ici.indexOf(date)
  const n1 = memeSegmentDuMois(an - 1, mois)
  if (rang < 0 || !n1.length) return aucun(date, RAISONS.AUCUN_JOUR_CE_MOIS)
  if (rang < n1.length) {
    return decrire(date, n1[rang], contexte, ETAGES.RANG_DANS_LE_MOIS,
      ALIGNEMENTS.RANG_DANS_LE_MOIS, s, { rang: rang + 1, rang_n1: rang + 1 })
  }
  // « Au plus proche si les comptes different » : le mois N-1 compte moins de
  // vendredis hors vacances que celui-ci. On prend le dernier, et on le dit.
  return decrire(date, n1[n1.length - 1], contexte, ETAGES.RANG_DANS_LE_MOIS,
    ALIGNEMENTS.RANG_LE_PLUS_PROCHE, s, { rang: rang + 1, rang_n1: n1.length })
}

function ecart (a, b) {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000)
}

/**
 * Cherche autour d'une date, du plus proche au plus lointain.
 * ⚠ LE PLUS PROCHE D'ABORD, ET A EGALITE LE PASSE. Sans ordre stable, deux
 * candidats symetriques rendraient une reponse differente d'un appel a l'autre
 * — et un moteur de prix se doit d'etre 100 % deterministe.
 */
function chercher (centre, rayon, pas, predicat) {
  if (estJourISO(centre) && predicat(centre)) return centre
  for (let d = pas; d <= rayon; d += pas) {
    for (const signe of [-1, 1]) {
      const j = decaler(centre, signe * d)
      if (estJourISO(j) && predicat(j)) return j
    }
  }
  return null
}

function aucun (date, raison) {
  return {
    date: null, etage: ETAGES.AUCUN, alignement: ALIGNEMENTS.AUCUN,
    raison, jour_semaine: null, meme_jour: false, meme_segment: false,
    segment: null, libelle: null, ecart_jours: null, rang: null, rang_n1: null
  }
}

function decrire (date, cible, contexte, etage, alignement, s, extra = {}) {
  const c = segmenterJour(cible, contexte)
  return {
    date: cible,
    etage,
    alignement,
    jour_semaine: jourDeSemaine(cible),
    meme_jour: jourDeSemaine(cible) === jourDeSemaine(date),
    meme_segment: !!(c && s && c.segment === s.segment),
    segment: c ? c.segment : null,
    libelle: c ? (c.libelle || null) : null,
    // L'ecart au decalage nominal de 52 semaines : il dit d'un coup d'oeil
    // combien l'evenement a glisse.
    ecart_jours: ecart(cible, decaler(date, -364)),
    rang: extra.rang ?? null,
    rang_n1: extra.rang_n1 ?? null
  }
}

module.exports = {
  ETAGES,
  ALIGNEMENTS,
  RAISONS,
  ferieADateFixe,
  nuitComparable
}
