// shared/comparables-detail.js — LE DETAIL DE CHAQUE COMPARABLE, sous la
// courbe de la vue Annee (accueil, bloc Revenus).
// Spec : docs/specs/spec-revenus-comparables.md §7.
//
// Decisions de Thierry du 25 novembre 2026 : un tableau, une ligne par
// comparable et SON logement en premier (D1) ; les 12 derniers mois et les
// 3 prochains, en fenetre glissante (D2) ; le titre de l'annonce et un lien
// (D3).
//
// ⚠ DEUX FORMES, UN SEUL MODULE. L'ordinateur lit un tableau ; le telephone
// (≤ 560 px) lit une carte par logement, ses quinze mois en grille. C'est la
// regle des deux tableaux voisins (recette du 27 octobre 2026 : « un tableau
// qu'il faut faire glisser pour lire son total n'est pas lisible »), et la
// regle du depot : *une regle partagee par deux versions vit dans un module
// commun*. Les deux sortent de la MEME fonction `valeurs`, donc ne peuvent pas
// dire deux choses differentes du meme mois.
//
// ⚠ AUCUN TEXTE EN DUR, AUCUNE MISE EN FORME DE MONTANT ICI : la page les
// fournit (`t`, `montant`, `moisCourt`, `dateLongue`). Le module ne sait que
// quoi dire de chaque case.

// Un mois dont aucun montant n'est calculable : un total nul ET des sejours
// sans montant. ⚠ LA SEULE COPIE DE CETTE REGLE : la vue Annee l'importe d'ici
// (constat m4 de la review du 25 novembre 2026 — deux copies divergent).
// ⚠ « NON CALCULABLE » N'EST JAMAIS ZERO : un mois a 3 sejours dont 1 sans
// montant garde son total partiel — une verite incomplete, que la reserve dit.
export const refuseTout = (c) => !!c && Number(c.sans_montant || 0) > 0 && Number(c.total_cents || 0) === 0

const ID_ANNONCE = /^[0-9]{1,24}$/

// Ce que dit UNE case : un texte court, un titre (le motif, au survol), et
// deux drapeaux de mise en forme. ⚠ « NON CALCULABLE » N'EST JAMAIS 0 NI UN
// TIRET : il s'ecrit « n. c. » et porte son motif.
// ⚠ ET LE MOTIF A UNE FORME COURTE, VISIBLE (`court`) : un `title` ne
// s'affiche ni au toucher ni au clavier (constat M7 de la review). Au
// telephone, la carte l'ecrit sous la case ; a l'ordinateur, le survol suffit.
export function valeurCase (c, o) {
  const { t, montant } = o
  const nc = (motif, court) => ({ texte: t('revenue.detail_nc'), titre: motif, court: t(court), vide: true })
  if (!c || c.etat === 'absent') return nc(t('revenue.detail_motif_absent'), 'revenue.detail_court_absent')
  if (c.etat === 'nc') {
    return nc(c.motif ? `${t('revenue.detail_motif_nc')} (${c.motif})` : t('revenue.detail_motif_nc'), 'revenue.detail_court_nc')
  }
  if (c.etat === 'partiel') {
    return nc(t('revenue.detail_motif_partiel', { n: c.nuits_mesurees, total: c.jours }), 'revenue.detail_court_partiel')
  }
  // ⚠ ZERO EUR D'UN MOIS CLOS N'EST PAS « IL A GAGNE ZERO » : il n'etait pas
  // sur le marche. On le dit en mots, comme la bande l'ecarte du minimum.
  if (c.etat === 'inactif') return { texte: t('revenue.detail_inactif'), titre: t('revenue.detail_inactif_titre'), vide: true }
  if (c.etat === 'clos') return { texte: montant(c.montant_cents), titre: null }
  if (c.etat === 'futur') {
    const nuits = Number.isFinite(c.nuits_indisponibles) && Number.isFinite(c.nuits_mesurees)
      ? { n: c.nuits_indisponibles, total: c.nuits_mesurees } : null
    return {
      texte: montant(c.montant_cents),
      nuits: nuits ? t('revenue.detail_nuits', nuits) : null,
      titre: [nuits ? t('revenue.detail_nuits_titre', nuits) : null, c.motif || null]
        .filter(Boolean).join(' — ') || null
    }
  }
  return nc(t('revenue.detail_motif_absent'), 'revenue.detail_court_absent')
}

// La case du LOGEMENT de l'hote : ses chiffres de la courbe, mois par mois.
// ⚠ UN MOIS SANS LIGNE N'EST PAS « 0 € » : aucun sejour n'y a ete verse, et
// on le dit en mots (decision de Thierry du 27 octobre : l'endpoint ne comble
// pas les trous, c'est l'ecran qui dit ce qu'ils veulent dire).
export function valeurLogement (logement, mois, o) {
  const { t, montant } = o
  if (logement === null || logement === undefined) {
    return { texte: t('revenue.detail_nc'), titre: t('revenue.detail_motif_logement'), court: t('revenue.detail_court_logement'), vide: true }
  }
  const c = logement[mois]
  if (!c) return { texte: t('revenue.detail_aucun'), titre: t('revenue.detail_aucun_titre'), vide: true }
  if (refuseTout(c)) {
    return { texte: t('revenue.detail_nc'), titre: t('revenue.detail_motif_refus'), court: t('revenue.detail_court_refus'), vide: true }
  }
  // ⚠ UN CHIFFRE INCOMPLET SE DIT, comme dans l'ⓘ du total de la vue Annee
  // (constat m3 de la review) : des sejours sans montant le SOUS-estiment, des
  // montants bruts le SUR-estiment (la commission n'a pas ete transmise). La
  // reserve est VISIBLE dans les deux formes — elle est rare, et elle change
  // la lecture du chiffre.
  const sans = Number(c.sans_montant || 0)
  const bruts = Number(c.bruts || 0)
  const reserves = [
    sans > 0 ? t('revenue.detail_titre_sans_montant', { n: sans }) : null,
    bruts > 0 ? t('revenue.detail_titre_bruts', { n: bruts }) : null
  ].filter(Boolean)
  return {
    texte: montant(Number(c.total_cents || 0)),
    titre: reserves.join(' — ') || null,
    reserve: reserves.length ? t(sans > 0 ? 'revenue.detail_court_incomplet' : 'revenue.detail_court_brut') : null
  }
}

// Le nom d'un comparable, avec le lien vers son annonce. ⚠ L'IDENTIFIANT EST
// REVERIFIE ICI : il vient du serveur, qui le contraint deja par la base, mais
// une URL se construit seulement depuis ce qu'on a verifie soi-meme.
function nomComparable (c, o) {
  const { t, esc } = o
  const nom = c.nom ? String(c.nom) : t('revenue.detail_sans_titre')
  const lien = ID_ANNONCE.test(String(c.listing_id))
    ? `<a class="link" href="https://www.airbnb.fr/rooms/${encodeURIComponent(String(c.listing_id))}"`
      + ` target="_blank" rel="noopener noreferrer"`
      + ` aria-label="${esc(t('revenue.detail_ouvrir_annonce', { nom }))}">${esc(nom)}</a>`
    : esc(nom)
  // ⚠ SEULEMENT SI ON LE SAIT : `retenu === null` veut dire « liste des retenus
  // illisible », et l'ecran ne l'affirme pas (constat M3 de la review).
  const plus = c.retenu === false ? ` <span class="caption muted">${esc(t('revenue.detail_plus_retenu'))}</span>` : ''
  return lien + plus
}

const attrTitre = (titre, esc) => (titre ? ` title="${esc(titre)}"` : '')

// Le contenu de la case, pour les deux formes. ⚠ LE TELEPHONE ECRIT LE MOTIF
// COURT sous la case (`court`) : il n'a ni survol ni `title`.
function contenu (v, esc, telephone = false) {
  const texte = v.vide
    ? `<abbr${attrTitre(v.titre, esc)}>${esc(v.texte)}</abbr>`
    : esc(v.texte)
  const sous = v.nuits || v.reserve || (telephone && v.court) || null
  return texte + (sous ? `<span class="rev-cmp__nuits">${esc(sous)}</span>` : '')
}

/**
 * Le detail entier, en HTML.
 *
 * @param detail  la reponse `detail` de `/api/ecran/revenus-annee?detail=comparables`,
 *                `undefined` pendant la lecture, `null` si elle a echoue
 * @param o.t, o.esc, o.montant(cents), o.moisCourt('YYYY-MM'), o.moisLong('YYYY-MM'),
 *        o.dateLongue('YYYY-MM-DD'), o.nomLogement, o.idIb
 */
export function detailComparablesHtml (detail, o) {
  const { t, esc } = o
  const ligneEtat = (cle) => `<p class="caption muted" role="status">${esc(t(cle))}</p>`
  // ⚠ TROIS ETATS, ET AUCUN NE SE TAIT : « je lis », « je n'ai pas pu lire »
  // et « il n'y a rien » ne se confondent pas. Une lecture ratee n'est pas une
  // absence de comparables (meme regle que la bande).
  if (detail === undefined) return ligneEtat('revenue.computing')
  if (!detail || !Array.isArray(detail.mois) || !detail.mois.length || detail.comparables === null) {
    return ligneEtat('revenue.detail_echec')
  }
  if (!Array.isArray(detail.comparables) || !detail.comparables.length) return ligneEtat('revenue.detail_vide')

  const mois = detail.mois
  const courant = String(detail.mois_courant || '')
  // Les mois en cours et a venir : l'« occupe » chez les comparables, le
  // « deja reserve » chez l'hote. Une marque de forme, pas seulement de couleur.
  const classeMois = (m) => [m >= courant ? 'rev-cmp--avenir' : '', m === courant ? 'rev-cmp--courant' : '']
    .filter(Boolean).join(' ')

  const lignes = [
    {
      nom: `${esc(String(o.nomLogement || ''))} <span class="caption muted">${esc(t('revenue.detail_vous'))}</span>`,
      cases: mois.map(m => valeurLogement(detail.logement, m, o)),
      moi: true
    },
    ...detail.comparables.map(c => ({
      nom: nomComparable(c, o),
      cases: mois.map(m => valeurCase(c.mois && c.mois[m], o)),
      moi: false
    }))
  ]

  // ─── L'en-tete et son ⓘ ───────────────────────────────────────────────
  // ⚠ PAS DE TEXTE EN CLAIR SOUS LE TABLEAU (demande de Thierry du
  // 29 octobre 2026 : « plus de texte en clair sous les blocs ») : ce que dit
  // chaque case, et la DATE DU RELEVE, vivent dans l'ⓘ. Un chiffre sans son
  // age est un chiffre dont personne ne sait la fraicheur.
  const periode = t('revenue.detail_periode', { de: o.moisLong(mois[0]), a: o.moisLong(mois[mois.length - 1]) })
  const r = detail.releves
  const date = r && r.de
    ? (r.de === r.a
        ? t('revenue.detail_releve', { date: o.dateLongue(r.a) })
        : t('revenue.detail_releves', { de: o.dateLongue(r.de), a: o.dateLongue(r.a) }))
    : ''
  const ib = [t('revenue.detail_ib'), date].filter(Boolean).join('\n')
  const idIb = o.idIb || 'ib-detail-cmp-txt'
  const tete = `<div class="rev-cmp__tete">`
    + `<h3 class="caption">${esc(t('revenue.detail_titre'))} · ${esc(periode)}</h3>`
    + `<span class="ibulle"><button type="button" class="ibulle__btn" aria-expanded="false" data-ibulle`
    + ` aria-controls="${esc(idIb)}" aria-label="${esc(t('revenue.detail_ib_ouvrir'))}">`
    + `<svg class="icon" aria-hidden="true"><use href="/shared/icons.svg#i-help"></use></svg>`
    + `</button><span class="ibulle__txt" role="note" id="${esc(idIb)}">${esc(ib)}</span></span>`
    + `</div>`

  // ─── L'ordinateur : un tableau ────────────────────────────────────────
  // ⚠ LA COLONNE DES NOMS RESTE FIXE au defilement horizontal : quinze mois
  // ne tiennent pas, et une ligne qu'on fait glisser doit garder son nom.
  const tableau = `<div class="rev-tbl-wrap rev-cmp-tbl"><table class="rev-tbl rev-tbl--cmp">`
    + `<thead><tr><th scope="col" class="rev-cmp__nom">${esc(t('revenue.detail_col_logement'))}</th>`
    + mois.map(m => `<th scope="col" class="rev-tbl__num ${classeMois(m)}">${esc(o.moisCourt(m))}</th>`).join('')
    + `</tr></thead><tbody>`
    + lignes.map(l => `<tr${l.moi ? ' class="rev-cmp__moi"' : ''}>`
      + `<th scope="row" class="rev-cmp__nom">${l.nom}</th>`
      + l.cases.map((v, i) => `<td class="rev-tbl__num ${classeMois(mois[i])}"${v.vide ? '' : attrTitre(v.titre, esc)}>`
        + `${contenu(v, esc)}</td>`).join('')
      + `</tr>`).join('')
    + `</tbody></table></div>`

  // ─── Le telephone : une carte par logement ────────────────────────────
  const cartes = `<ul class="rev-liste rev-cmp-liste">`
    + lignes.map(l => `<li class="rev-carte${l.moi ? ' rev-cmp__moi' : ''}">`
      + `<div class="rev-carte__tete"><span class="rev-carte__bien">${l.nom}</span></div>`
      + `<dl class="rev-cmp-grille">`
      + l.cases.map((v, i) => `<div class="${classeMois(mois[i])}">`
        + `<dt>${esc(o.moisCourt(mois[i]))}</dt><dd${v.vide ? '' : attrTitre(v.titre, esc)}>${contenu(v, esc, true)}</dd></div>`).join('')
      + `</dl></li>`).join('')
    + `</ul>`

  return tete + tableau + cartes
}
