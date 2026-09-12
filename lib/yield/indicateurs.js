// lib/yield/indicateurs.js
// DOC : docs/kb/indicateurs-yield.md (modif = MEME COMMIT)
// Spec : docs/specs/spec-yieldflow-v1.md §6 (etape 3, lot 3.2)
//
// FONCTIONS PURES. Le module recoit des eclatements (lot 3.1) et une capacite
// (lot 2.1), et rend des indicateurs. Il ne lit rien, n'ecrit rien.
//
// ⚠ « CALCULABLE » NE VEUT PAS DIRE « DIVISIBLE ».
// C'est la regle qui traverse tout ce fichier. `joursOuverts` peut rendre
// `calculable: true` avec ZERO jour ouvert — Colomiers est dans ce cas, ferme
// volontairement a 100 %. Un taux d'occupation n'y vaut pas 0 % : IL N'EXISTE
// PAS. Diviser donnerait `NaN` ou `Infinity`, et un moteur de yield qui affiche
// 0 % d'occupation sur un bien ferme suggererait de brader.

const MOTIFS_NON_CALCULABLE = {
  CAPACITE: 'capacite_non_calculable',   // le bien n'a pas de memoire d'intention
  AUCUN_JOUR_OUVERT: 'aucun_jour_ouvert',
  AUCUNE_NUIT_TARIFEE: 'aucune_nuit_a_prix_connu',
  AUCUNE_DATE_FIABLE: 'aucune_date_de_vente_fiable',
  CAPACITE_PERSONNES: 'capacite_en_personnes_inconnue'
}

// ─── Cles de periode ────────────────────────────────────────────────────────
function clePeriode (jourISO, granularite) {
  const j = String(jourISO || '')
  if (granularite === 'jour') return j.slice(0, 10)
  if (granularite === 'mois') return j.slice(0, 7)
  if (granularite === 'annee') return j.slice(0, 4)
  throw new Error(`[indicateurs] granularite inconnue : ${granularite}`)
}

// ⚠ MEDIANE, PAS MOYENNE (spec §6 : « delai de reservation »).
// Une seule reservation prise dix-huit mois a l'avance tire la moyenne de
// plusieurs semaines et fait croire a une clientele qui anticipe. La mediane
// dit le comportement du milieu, celui sur lequel on peut agir.
function mediane (valeurs) {
  const v = valeurs.filter(x => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

function joursEntre (a, b) {
  if (!a || !b) return null
  const d = (new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000
  return Number.isFinite(d) ? Math.round(d) : null
}

/**
 * Agrege des eclatements en indicateurs, par periode.
 *
 * @param eclatements  sorties de `eclater()` — celles qui ne comptent pas sont
 *                     ignorees ici : c'est `eclater` qui a deja tranche.
 * @param options.capacites  Map cle de periode -> resultat de `joursOuverts`.
 *                     Sans elle, TO et RevPAR sont « non calculables » — jamais
 *                     zero, jamais absents en silence.
 * @param options.capacitePersonnes  nombre de couchages du bien, pour
 *                     l'occupation en personnes. `null` si non selectionne.
 */
function calculerIndicateurs (eclatements, options = {}) {
  const { granularite = 'mois', capacites = null, capacitePersonnes = null } = options
  const parPeriode = new Map()

  const vide = (cle) => ({
    periode: cle,
    // ─── REALISE : ce qui s'est passe ───────────────────────────────────────
    ca: 0,
    nuitees: 0,
    nuits_a_prix_connu: 0,
    personnes_nuits: 0,
    nuits_sans_personnes: 0,
    // ─── REFERENCE : ce qui est « normal » ──────────────────────────────────
    // ⚠ Les nuits HORS REFERENCE sont comptees a part, jamais retirees du
    // realise. Le realise dit ce qui s'est passe ; la reference dit ce qui est
    // normal. Une fermeture pour travaux appartient au premier, pas au second.
    nuitees_hors_reference: 0,
    ca_hors_reference: 0,
    // ─── Delais, pour la mediane ────────────────────────────────────────────
    _delais: [],
    reservations: 0
  })

  for (const e of eclatements || []) {
    if (!e || !e.compte) continue
    const delai = e.date_vente_fiable && e.nuits.length
      ? joursEntre(e.date_vente, e.nuits[0].date)
      : null

    // Une reservation compte son delai UNE FOIS, dans la periode de sa
    // PREMIERE nuit : un sejour a cheval sur deux mois n'a qu'une date de vente.
    const clePremiere = e.nuits.length ? clePeriode(e.nuits[0].date, granularite) : null
    if (clePremiere) {
      if (!parPeriode.has(clePremiere)) parPeriode.set(clePremiere, vide(clePremiere))
      const p = parPeriode.get(clePremiere)
      p.reservations++
      if (delai != null && delai >= 0) p._delais.push(delai)
    }

    const personnes = (Number(e.personnes) > 0) ? Number(e.personnes) : null
    for (const n of e.nuits) {
      const cle = clePeriode(n.date, granularite)
      if (!parPeriode.has(cle)) parPeriode.set(cle, vide(cle))
      const p = parPeriode.get(cle)
      p.nuitees++
      if (n.prix != null && Number.isFinite(n.prix)) {
        p.ca += n.prix
        p.nuits_a_prix_connu++
        if (n.hors_reference) p.ca_hors_reference += n.prix
      }
      if (n.hors_reference) p.nuitees_hors_reference++
      if (personnes != null) p.personnes_nuits += personnes
      else p.nuits_sans_personnes++
    }
  }

  // ─── Derives ──────────────────────────────────────────────────────────────
  const out = []
  for (const p of [...parPeriode.values()].sort((a, b) => a.periode.localeCompare(b.periode))) {
    const cap = capacites ? (capacites.get ? capacites.get(p.periode) : capacites[p.periode]) : null
    const r = {
      periode: p.periode,
      reservations: p.reservations,
      ca: arrondi(p.ca),
      nuitees: p.nuitees,
      nuits_a_prix_connu: p.nuits_a_prix_connu,
      nuitees_hors_reference: p.nuitees_hors_reference,
      ca_hors_reference: arrondi(p.ca_hors_reference),
      jours_ouverts: null,
      taux_occupation: null,
      revpar: null,
      prix_moyen: null,
      taux_occupation_personnes: null,
      delai_median: mediane(p._delais),
      delais_utilises: p._delais.length,
      non_calculable: []
    }

    // ⚠ PRIX MOYEN : SUR LES NUITS A PRIX CONNU, JAMAIS SUR TOUTES.
    // 74 reservations Beds24 reelles ont `price = 0` : leurs nuits occupent le
    // logement et comptent au TO, mais les inclure au denominateur tirerait le
    // prix moyen vers le bas sans qu'aucun chiffre ne paraisse faux.
    if (p.nuits_a_prix_connu > 0) r.prix_moyen = arrondi(p.ca / p.nuits_a_prix_connu)
    else r.non_calculable.push(MOTIFS_NON_CALCULABLE.AUCUNE_NUIT_TARIFEE)

    if (!p._delais.length) r.non_calculable.push(MOTIFS_NON_CALCULABLE.AUCUNE_DATE_FIABLE)

    // ⚠ LE DENOMINATEUR VIENT DE LA MEMOIRE D'INTENTION (lot 2.1).
    if (!cap || cap.calculable !== true) {
      r.non_calculable.push(MOTIFS_NON_CALCULABLE.CAPACITE)
      if (cap && cap.raison) r.capacite_raison = cap.raison
    } else {
      r.jours_ouverts = cap.jours_ouverts
      // ⚠ LE DRAPEAU SUIT LA DONNEE, IL NE S'ARRETE PAS A LA CAPACITE.
      // Un TO calcule sur un denominateur ESTIME est un TO estime. Sans ce
      // report, l'etape 4 pourrait l'afficher comme mesure — et c'est
      // exactement ce que Thierry a exige d'empecher.
      if (cap.estimee) {
        r.capacite_estimee = true
        r.jours_estimes_ouverts = cap.jours_estimes_ouverts
        if (cap.jours_estimes_fermes_par_exception) {
          r.jours_estimes_fermes_par_exception = cap.jours_estimes_fermes_par_exception
        }
      }
      if (cap.jours_ouverts > 0) {
        r.taux_occupation = arrondi(p.nuitees / cap.jours_ouverts, 4)
        r.revpar = arrondi(p.ca / cap.jours_ouverts)
        if (Number(capacitePersonnes) > 0) {
          r.taux_occupation_personnes =
            arrondi(p.personnes_nuits / (cap.jours_ouverts * Number(capacitePersonnes)), 4)
        } else {
          r.non_calculable.push(MOTIFS_NON_CALCULABLE.CAPACITE_PERSONNES)
        }
      } else {
        // ⚠ CALCULABLE, MAIS PAS DIVISIBLE. Un bien ferme toute la periode n'a
        // pas un TO de 0 % : il n'en a pas. C'est le cas de Colomiers.
        r.non_calculable.push(MOTIFS_NON_CALCULABLE.AUCUN_JOUR_OUVERT)
      }
    }
    if (p.nuits_sans_personnes && r.taux_occupation_personnes != null) {
      r.personnes_partielles = p.nuits_sans_personnes
    }
    out.push(r)
  }
  return out
}

function arrondi (v, dec = 2) {
  if (v == null || !Number.isFinite(v)) return null
  const f = Math.pow(10, dec)
  return Math.round(v * f) / f
}

// ─── Comparaison N-1 ────────────────────────────────────────────────────────
// ⚠ ON SIGNALE « NON CALCULABLE », ON N'AFFICHE JAMAIS ZERO.
// Un bien qui n'existait pas l'an dernier n'a pas fait 0 € : il n'a pas de
// N-1. Afficher « -100 % » sur un logement ouvert en mars ferait croire a un
// effondrement, et le moteur suggererait de brader pour « rattraper ».
function periodePrecedente (cle) {
  if (/^\d{4}$/.test(cle)) return String(Number(cle) - 1)
  if (/^\d{4}-\d{2}$/.test(cle)) {
    const [a, m] = cle.split('-')
    return `${Number(a) - 1}-${m}`
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(cle)) {
    const [a, m, j] = cle.split('-')
    return `${Number(a) - 1}-${m}-${j}`
  }
  return null
}

const COMPARABLES = ['ca', 'nuitees', 'taux_occupation', 'revpar', 'prix_moyen',
  'taux_occupation_personnes', 'delai_median']

// Les seuls indicateurs qui dependent du DENOMINATEUR, donc de l'estimation.
// Le CA, les nuitees et le prix moyen sont MESURES quoi qu'il arrive : ils ne
// divisent pas par les jours ouverts.
const ESTIMABLES = ['taux_occupation', 'revpar', 'taux_occupation_personnes']

function comparerAN1 (indicateurs) {
  const parCle = new Map((indicateurs || []).map(i => [i.periode, i]))
  return (indicateurs || []).map(i => {
    const clePrec = periodePrecedente(i.periode)
    const prec = clePrec ? parCle.get(clePrec) : null
    const vs = { periode_n1: clePrec, disponible: !!prec }
    for (const champ of COMPARABLES) {
      const a = i[champ]
      const b = prec ? prec[champ] : null
      if (!prec || a == null || b == null) {
        // Ni 0, ni -100 % : on DIT qu'on ne sait pas.
        vs[champ] = { valeur: a ?? null, n1: b ?? null, ecart: null, variation: null,
          non_calculable: !prec ? 'periode_n1_absente' : (b == null ? 'n1_non_calculable' : 'valeur_non_calculable') }
        continue
      }
      const ecart = arrondi(a - b, 4)
      vs[champ] = { valeur: a, n1: b, ecart,
        variation: b === 0 ? null : arrondi((a - b) / Math.abs(b), 4) }
      // Une comparaison dont l'un des deux termes est estime est elle-meme
      // estimee : le drapeau ne doit pas se perdre en route.
      if (ESTIMABLES.includes(champ) && (i.capacite_estimee || prec.capacite_estimee)) {
        vs[champ].estimee = true
      }
    }
    return { ...i, vs_n1: vs }
  })
}

module.exports = {
  MOTIFS_NON_CALCULABLE,
  COMPARABLES,
  ESTIMABLES,
  clePeriode,
  mediane,
  joursEntre,
  calculerIndicateurs,
  periodePrecedente,
  comparerAN1
}
