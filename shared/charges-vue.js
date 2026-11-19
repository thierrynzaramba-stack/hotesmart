// shared/charges-vue.js — L'ÉCRAN `/charges`, UNE SEULE VUE (lot 3 du compte de charges).
// Spec : docs/specs/spec-compte-de-charges.md §13.2, §13.3, §13.9.
//
// ⚠ UNE VUE POUR LES DEUX ÉCRANS (règle « le mobile suit l'ordinateur ») : la
// mise en page change par la feuille de style, jamais par une seconde copie
// de ce module. Au téléphone, la fiche s'ouvre en plein écran et les totaux
// passent sous « À traiter ».
//
// ⚠ AUCUN APPEL RÉSEAU ÉCRIT ICI. La page injecte `charger` (l'appel d'écran),
// `agir` (les gestes) et `deposer` (l'envoi du fichier au stockage) : c'est
// elle qui porte l'inventaire de ses endpoints (tests/budget-ecran.test.js).
//
// ⚠ AUCUN TEXTE EN DUR, AUCUN HEXA, AUCUNE ICÔNE DESSINÉE : les textes passent
// par `t`, les couleurs par les jetons de shared/theme.css.
//
// ⚠ UN MONTANT ABSENT N'EST JAMAIS 0 : il s'affiche « non lu », et le total dit
// combien de factures n'ont pas de montant (règle du résumé, spec §8).

// Les types que le serveur accepte (lib/charges/regles.js, TYPES) : la même
// borne ici évite d'envoyer ce qui sera refusé — elle ne remplace pas la garde
// du serveur.
// Le tableau d'amortissement d'un crédit (§14.20) : un PDF, 2 Mo au plus — la
// borne du serveur (`CREDIT_PDF_MAX`, lib/charges.js).
export const CREDIT_PDF_MAX = 2 * 1024 * 1024

export const TYPES_ACCEPTES = {
  'application/pdf': 10 * 1024 * 1024,
  'image/jpeg': 7 * 1024 * 1024,
  'image/png': 7 * 1024 * 1024,
  'image/heic': 10 * 1024 * 1024,
  'image/heif': 10 * 1024 * 1024
}

// ⚠ TOUTE IMAGE QUE L'APPAREIL SAIT LIRE EST ACCEPTÉE, puis convertie en JPEG
// avant l'envoi (Thierry, 19 novembre 2026 : des factures reçues par SMS ne
// passaient pas). La conversion se fait ICI, par le navigateur, quand il sait
// lire l'image. ⚠ SAUF LE HEIC que le navigateur ne sait pas lire (Chrome,
// sur Android comme sur PC) : il part TEL QUEL, et c'est notre serveur qui le
// convertit en JPEG à la confirmation (§14.19, lib/charges/heic.js). L'IA ne
// reçoit donc toujours que du PDF, du JPEG ou du PNG. Un autre format que
// l'appareil ne sait pas lire est refusé en le disant. Un fichier sans type
// (certains sélecteurs Android) se reconnaît à son extension.
const EXTENSIONS_IMAGE = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff'
}
export function typeDuFichier (f) {
  const t = (f && f.type) || ''
  if (t === 'application/pdf' || /^image\//.test(t)) return t
  const n = (f && f.name) || ''
  if (/\.pdf$/i.test(n)) return 'application/pdf'
  const ext = (n.match(/\.([a-z0-9]+)$/i) || [])[1]
  return (ext && EXTENSIONS_IMAGE[ext.toLowerCase()]) || t
}
const estHeic = (type) => /^image\/hei[cf](-sequence)?$/.test(type)

// Le format d'un fichier lu dans son CONTENU (ses premiers octets), quand son
// type et son extension se taisent ou mentent : un HEIC enregistré en « .jpg »
// par une messagerie, un fichier sans nom ni type (review du lot photos,
// constat 1). Rend '' si rien n'est reconnu.
export function formatDuContenu (o) {
  const asc = (a, b) => String.fromCharCode(...o.slice(a, b))
  if (asc(0, 4) === '%PDF') return 'application/pdf'
  if (o[0] === 0xFF && o[1] === 0xD8 && o[2] === 0xFF) return 'image/jpeg'
  if (o[0] === 0x89 && asc(1, 4) === 'PNG') return 'image/png'
  if (asc(0, 4) === 'GIF8') return 'image/gif'
  if (asc(0, 4) === 'RIFF' && asc(8, 12) === 'WEBP') return 'image/webp'
  if (asc(4, 8) === 'ftyp') {
    const marque = asc(8, 12)
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(marque)) return 'image/heic'
    if (marque === 'avif') return 'image/avif'
  }
  return ''
}
// `Lecteur` : le FileReader de la page, pour les navigateurs (et le banc de
// tests) dont les morceaux de fichier n'ont pas `arrayBuffer`.
async function premiersOctets (f, Lecteur, n = 16) {
  const part = f.slice(0, n)
  if (typeof part.arrayBuffer === 'function') return new Uint8Array(await part.arrayBuffer())
  return new Uint8Array(await new Promise((ok, ko) => {
    const r = new Lecteur()
    r.onload = () => ok(r.result)
    r.onerror = () => ko(r.error)
    r.readAsArrayBuffer(part)
  }))
}
async function formatLu (f, Lecteur) {
  try { return formatDuContenu(await premiersOctets(f, Lecteur)) } catch (e) { return '' }
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c])

/**
 * L'état d'une facture tel que l'écran le nomme. Un doublon non tranché passe
 * avant tout : c'est lui qui demande un geste.
 */
export function etatDe (c) {
  if (!c) return null
  if (c.signal === 'doublon' && !c.signal_tranche) return 'doublon'
  if (c.statut === 'a_lire') {
    if (c.motif === 'panne_ia') return 'panne'
    if (c.motif === 'plafond_ia') return 'plafond'
    return 'a_lire'
  }
  if (['a_verifier', 'validee', 'illisible', 'sans_facture'].includes(c.statut)) return c.statut
  return null
}

/**
 * Un montant saisi en euros → des centimes. `null` pour un champ vide (le
 * montant est absent, ce n'est pas 0), `undefined` pour une saisie invalide.
 * Accepte « 12 », « 12,5 », « 1 234,56 », « 12.50 » ; jamais de calcul en
 * virgule flottante.
 */
export function enCentimes (texte) {
  const brut = String(texte == null ? '' : texte).replace(/[\s  ]/g, '').replace(',', '.')
  if (brut === '') return null
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(brut)
  if (!m) return undefined
  return Number(m[1]) * 100 + Number((m[2] || '0').padEnd(2, '0'))
}

/** Des centimes → le texte d'un champ de saisie (« 12,50 », ou « 12.50 » en anglais). */
export function enSaisie (cents, langue = 'fr') {
  if (cents == null || !Number.isInteger(cents)) return ''
  const sep = String(langue).startsWith('en') ? '.' : ','
  return `${Math.floor(cents / 100)}${sep}${String(cents % 100).padStart(2, '0')}`
}

// Les types de document (lot 7a) : la MÊME liste que lib/charges/regles.js
// (TYPES_DOCUMENT), comparée par tests/charges-page.test.js.
export const TYPES_DOCUMENT = ['facture', 'regularisation', 'avoir', 'echeancier', 'avis_impot']

/**
 * La période saisie, contrôlée comme le serveur (`periodeSaisie`) : les deux
 * bornes ou aucune, dans l'ordre, trois ans (1 097 jours) au plus — la borne
 * du serveur, `PERIODE_MAX_JOURS` (lib/charges/regles.js). Le code du refus, ou
 * `null`. Le serveur reste la garde : ceci évite seulement un aller-retour.
 */
export function controlePeriode (debut, fin) {
  if (!debut && !fin) return null
  const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''))
  if (!ok(debut) || !ok(fin) || debut > fin) return 'periode_invalide'
  const jours = Math.round((Date.parse(fin + 'T00:00:00Z') - Date.parse(debut + 'T00:00:00Z')) / 86400000) + 1
  return jours > 3 * 365 + 2 ? 'periode_trop_longue' : null
}

/** La racine d'un groupe de doublons : la première facture, ou elle-même. */
const racineDe = (c) => c.groupe_doublon || c.id

/**
 * @param racine  l'élément qui contient la page (les zones `data-bind`)
 * @param deps.charger(qs)        → la réponse de l'appel d'écran
 * @param deps.agir(corps)        → la réponse d'un geste (`POST /api/charges`)
 * @param deps.deposer(url, blob) → l'envoi du fichier à l'URL signée
 * @param deps.reduireImage(f)    → un JPEG réduit (shared/photo-bien-client.js)
 * @param deps.ouvrirOnglet()     → un onglet ouvert AU CLIC (sinon bloqué)
 * @param deps.confirmer(texte)   → vrai si l'hôte confirme
 * @param deps.t, deps.langue
 */
export function monter (racine, deps) {
  const Lecteur = ((racine && racine.ownerDocument && racine.ownerDocument.defaultView) || globalThis).FileReader
  const doc = racine.ownerDocument || racine
  const t = deps.t
  const langue = deps.langue || 'fr'
  const $ = (s) => racine.querySelector(s)
  const connu = (k) => { const v = t(k); return v && v !== k ? v : null }

  const fmtMontant = new Intl.NumberFormat(langue, { style: 'currency', currency: 'EUR' })
  const montant = (c) => (c == null ? esc(t('charges.non_lu')) : esc(fmtMontant.format(c / 100)))
  const dateLocale = (j) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(j || ''))
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
  }
  const jourLisible = (j) => {
    const d = dateLocale(j)
    return d ? new Intl.DateTimeFormat(langue, { day: 'numeric', month: 'short', year: 'numeric' }).format(d) : ''
  }
  const moisLisible = (cle) => {
    const d = dateLocale(String(cle || '') + '-01')
    return d ? new Intl.DateTimeFormat(langue, { month: 'long', year: 'numeric' }).format(d) : ''
  }
  const instantLisible = (iso) => {
    const d = iso ? new Date(iso) : null
    return d && !isNaN(d) ? new Intl.DateTimeFormat(langue, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d) : ''
  }

  const periodeLisible = (c) => (c && c.periode_debut && c.periode_fin
    ? t('charges.periode_courte', { debut: jourLisible(c.periode_debut), fin: jourLisible(c.periode_fin) })
    : '')

  const etat = {
    entite: 'toutes', periode: '',
    aTraiter: { lignes: [], nombre: 0 }, liste: [], suite: null,
    entites: [], biens: [], biensArchives: [], categories: [], totaux: null,
    fiche: null, occupe: false, envoiEnCours: false, ficheEnCours: false,
    credits: null, creditForm: false, creditEnCours: false, creditRetour: null
  }

  // ─── Les noms ────────────────────────────────────────────────────────────
  const nomCategorie = (cle) => (cle ? (connu('charges.cat_' + cle) || cle) : t('charges.sans_categorie'))
  function nomBien (id) {
    if (!id) return ''
    const actif = (etat.biens || []).find(b => String(b.id) === String(id))
    if (actif) return actif.nom
    const archive = (etat.biensArchives || []).find(b => String(b.id) === String(id))
    return archive ? `${archive.nom} · ${t('charges.archive')}` : ''
  }
  const nomEntite = (e) => (e.archivee ? `${e.nom} · ${t('charges.archivee')}` : e.nom)

  // Toutes les factures connues de l'écran, une seule fois chacune.
  function connues () {
    const vues = new Map()
    for (const c of [...(etat.aTraiter.lignes || []), ...(etat.liste || [])]) vues.set(String(c.id), c)
    return vues
  }

  // ─── Le message d'un refus ───────────────────────────────────────────────
  function messageErreur (e) {
    const code = e && (e.code || e.message)
    const precis = code ? connu('charges.refus_' + code) : null
    if (precis) return precis
    if (e && e.status === 403) return t('charges.acces_refuse')
    if (!e || !e.status || e.status >= 500) return t('charges.erreur_serveur')
    return t('charges.refus')
  }

  // ─── Une ligne de facture (À traiter et liste) ───────────────────────────
  const ACTION_DE = { a_verifier: 'charges.ouvrir', a_lire: 'charges.saisir_main', panne: 'charges.saisir_main', plafond: 'charges.saisir_main', illisible: 'charges.saisir_main', doublon: 'charges.verifier' }
  function ligne (c, avecAction) {
    const e = etatDe(c)
    const infos = [
      c.type_document && c.type_document !== 'facture' ? (connu('charges.type_' + c.type_document) || '') : '',
      periodeLisible(c),
      c.categorie ? nomCategorie(c.categorie) : '', nomBien(c.bien_id)
    ].filter(Boolean).join(' · ')
    const action = avecAction && e && ACTION_DE[e] ? `<span class="chg-ligne__action">${esc(t(ACTION_DE[e]))}</span>` : ''
    return `<li><button type="button" class="chg-ligne" data-ouvrir="${esc(c.id)}">`
      + `<span class="chg-ligne__jour">${esc(jourLisible(c.jour))}</span>`
      + `<span class="chg-ligne__qui"><b>${esc(c.fournisseur_nom || t('charges.fournisseur_inconnu'))}</b>`
      + (infos ? `<span class="chg-ligne__infos">${esc(infos)}</span>` : '') + '</span>'
      + `<span class="chg-ligne__ttc">${montant(c.montant_ttc_cents)}</span>`
      + (e ? `<span class="chg-etat chg-etat--${esc(e)}">${esc(t('charges.etat_' + e))}</span>` : '<span></span>')
      + action + '</button></li>'
  }

  // ─── À traiter ───────────────────────────────────────────────────────────
  function peindreATraiter () {
    const z = $('[data-bind="a-traiter"]')
    const { lignes, nombre } = etat.aTraiter
    const tete = `<div class="chg-bloc__tete"><h2 class="chg-h2">${esc(t('charges.a_traiter'))}</h2>`
      + (nombre ? `<span class="chg-compte">${esc(nombre)}</span>` : '') + '</div>'
    if (!lignes.length) { z.innerHTML = tete + `<p class="muted">${esc(t('charges.a_traiter_vide'))}</p>`; return }
    const reste = nombre - lignes.length
    z.innerHTML = tete + `<ul class="chg-lignes">${lignes.map(c => ligne(c, true)).join('')}</ul>`
      + (reste > 0 ? `<p class="muted small">${esc(t('charges.a_traiter_plus', { n: reste }))}</p>` : '')
  }

  // ─── Les totaux ──────────────────────────────────────────────────────────
  function selecteurs () {
    const ents = `<option value="toutes"${etat.entite === 'toutes' ? ' selected' : ''}>${esc(t('charges.toutes_entites'))}</option>`
      + etat.entites.map(e => `<option value="${esc(e.id)}"${String(e.id) === etat.entite ? ' selected' : ''}>${esc(nomEntite(e))}</option>`).join('')
    const tot = etat.totaux
    const pers = tot ? (tot.proposees || []).map(p => `<option value="${esc(p)}"${p === tot.periode ? ' selected' : ''}>${esc(t('charges.periode_' + p))}</option>`).join('') : ''
    return '<div class="chg-choix">'
      + `<select class="chg-select" data-choix="entite" aria-label="${esc(t('charges.entite_aria'))}">${ents}</select>`
      + (pers ? `<select class="chg-select" data-choix="periode" aria-label="${esc(t('charges.periode_aria'))}">${pers}</select>` : '')
      + '</div>'
  }

  // ⚠ DEUX LECTURES (Q34, lot 7a) : « Étalé » (la charge du jour, une facture
  // à période répartie au prorata) et « À la date » (la facture entière à son
  // jour). Sans aucune facture dans une lecture, son montant est 0 — une
  // absence vraie, pas un montant non lu ; avec des factures mais aucun
  // montant lu, il reste « non lu ».
  // ⚠ Un indicateur ABSENT (des totaux d'avant le lot 7a) ne vaut pas 0 : on
  // ne sait pas, donc « non lu » (review du lot 7a, constat 8).
  const parLecture = (somme, nb) => (nb == null ? montant(somme) : Number(nb) > 0 ? montant(somme) : esc(fmtMontant.format(0)))
  const deuxLectures = (etale, nbEtale, date, nbDate) =>
    `<span class="chg-lecture"><small>${esc(t('charges.etale'))}</small><b>${parLecture(etale, nbEtale)}</b></span>`
    + `<span class="chg-lecture chg-lecture--date"><small>${esc(t('charges.a_la_date'))}</small><b>${parLecture(date, nbDate)}</b></span>`

  function repartition (titre, toutes, nom, apres = () => '') {
    // ⚠ UNE LIGNE SANS FACTURE COMPTÉE, NI À SA DATE NI ÉTALÉE, NE S'AFFICHE
    // PAS : son montant n'est pas « non lu », il est écarté (un doublon non
    // tranché, une facture en lecture). Il est déjà dit par « N à vérifier » /
    // « N à trancher ».
    const lignes = (toutes || []).filter(r => Number(r.nb_factures) > 0 || Number(r.nb_etale) > 0)
    if (!lignes.length) return ''
    return `<section class="chg-rep"><h3 class="chg-h3">${esc(titre)}</h3><ul>`
      + lignes.map(r => `<li><span class="chg-rep__nom">${esc(nom(r.cle))}</span>${deuxLectures(r.ttc_etale, r.nb_etale, r.ttc, r.nb_factures)}</li>` + apres(r)).join('')
      + '</ul></section>'
  }

  // ⚠ LA LIGNE « CRÉDIT » D'UN MOIS (§14.20, demande de Thierry : « avoir une
  // vue sur les décaissements mensuels ») : la mensualité ENTIÈRE qui sort du
  // compte, capital compris. Le capital n'est pas une charge — il n'entre dans
  // aucun total — ; il se lit ici, à côté, sans rien y ajouter.
  // ⚠ « PAYÉE » SEULEMENT SI ELLE EST ÉCHUE (review du lot, bloquant B1) : le
  // 19 novembre, l'échéance du 22 est « à venir ». Le jour vient du serveur
  // (Paris) ; à défaut, celui de l'appareil.
  const jourDeLAppareil = () => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  function decaissesParMois () {
    const m = new Map()
    const aujourdhui = (etat.credits && etat.credits.aujourdhui) || jourDeLAppareil()
    for (const e of (etat.credits && etat.credits.echeances) || []) {
      const k = String(e.date_echeance || '').slice(0, 7)
      const x = m.get(k) || { payee: { echeance: 0, capital: 0, n: 0 }, avenir: { echeance: 0, capital: 0, n: 0 } }
      const cote = String(e.date_echeance) <= aujourdhui ? x.payee : x.avenir
      cote.echeance += Number(e.echeance_cents) || 0
      cote.capital += Number(e.capital_cents) || 0
      cote.n++
      m.set(k, x)
    }
    return m
  }
  const ligneCreditDuMois = (parMois) => (r) => {
    const c = parMois.get(String(r.cle || '').slice(0, 7))
    if (!c) return ''
    const ligne = (cle, x) => (x.n
      ? `<li class="chg-rep__credit"><span class="chg-rep__nom">${esc(t(cle))}</span>`
        + `<span class="chg-credit-mois"><b>${montant(x.echeance)}</b><small>${esc(t('charges.dont_capital', { montant: fmtMontant.format(x.capital / 100) }))}</small></span></li>`
      : '')
    return ligne('charges.credit_decaisse', c.payee) + ligne('charges.credit_a_venir', c.avenir)
  }

  function peindreTotaux () {
    const z = $('[data-bind="totaux"]')
    const tot = etat.totaux
    let corps
    if (!tot) {
      corps = `<p class="muted">${esc(t('charges.totaux_indispo'))}</p>`
    } else {
      const bornes = `<p class="chg-mentions">${esc(t('charges.du_au', { debut: jourLisible(tot.debut), fin: jourLisible(tot.fin) }))}</p>`
      const s = tot.total || {}
      // ⚠ « ESTIMATION », ET LES TROIS RAISONS DE LA SPEC (§6, Q4) : une
      // facture en lecture, à vérifier ou illisible ; un signal non tranché
      // (un doublon compte une fois tant que l'hôte n'a pas tranché) ; un
      // montant absent dans une colonne. Même sans facture comptée : des
      // factures en attente sont dans le périmètre.
      // ⚠ ET LA LECTURE ÉTALÉE A SES PROPRES RAISONS (review du lot 7a,
      // constat 1) : une facture à vérifier datée HORS de la période peut
      // s'y étaler. Ses indicateurs viennent du résumé, jour par jour.
      const etaleIncertain = Boolean(s.nb_etale_nv || s.nb_etale_signal || s.nb_etale_sans_ht || s.nb_etale_sans_tva || s.nb_etale_sans_ttc)
      const estimation = Boolean(s.nb_non_verifiees || s.nb_signaux || s.nb_sans_ttc || s.nb_sans_ht || s.nb_sans_tva || etaleIncertain)
      const mentions = [
        estimation ? t('charges.estimation_mot') : '',
        s.nb_non_verifiees ? t('charges.n_a_verifier', { n: s.nb_non_verifiees }) : '',
        s.nb_signaux ? t('charges.n_a_trancher', { n: s.nb_signaux }) : '',
        tot.calcule_le ? t('charges.calcule_le', { date: instantLisible(tot.calcule_le) }) : ''
      ].filter(Boolean).join(' · ')
      const ligneMentions = mentions ? `<p class="chg-mentions${estimation ? ' chg-mentions--estimation' : ''}">${esc(mentions)}</p>` : ''
      if (!s.nb_factures && !s.nb_etale) {
        corps = bornes + `<p class="muted">${esc(t('charges.totaux_vide'))}</p>` + ligneMentions
      } else {
        // « N sans montant lu » compte les DOCUMENTS de la période ; un montant
        // manquant qui ne s'y trouve que par l'étalement se dit sans nombre.
        const sans = (n, etale) => (n
          ? `<span class="chg-chiffre__sans">${esc(t('charges.sans_montant', { n }))}</span>`
          : etale ? `<span class="chg-chiffre__sans">${esc(t('charges.montant_etale_non_lu'))}</span>` : '')
        corps = bornes
          + '<div class="chg-chiffres">'
          + `<div class="chg-chiffre chg-chiffre--fort"><span>${esc(t('charges.ttc'))}</span><div class="chg-lectures">${deuxLectures(s.ttc_etale, s.nb_etale, s.ttc, s.nb_factures)}</div>${sans(s.nb_sans_ttc, s.nb_etale_sans_ttc)}</div>`
          + `<div class="chg-chiffre"><span>${esc(t('charges.ht'))}</span><div class="chg-lectures">${deuxLectures(s.ht_etale, s.nb_etale, s.ht, s.nb_factures)}</div>${sans(s.nb_sans_ht, s.nb_etale_sans_ht)}</div>`
          + `<div class="chg-chiffre"><span>${esc(t('charges.tva'))}</span><div class="chg-lectures">${deuxLectures(s.tva_etale, s.nb_etale, s.tva, s.nb_factures)}</div>${sans(s.nb_sans_tva, s.nb_etale_sans_tva)}</div>`
          + '</div>'
          + ligneMentions
          + '<div class="chg-reps">'
          + repartition(t('charges.par_mois'), tot.par_mois, moisLisible, ligneCreditDuMois(decaissesParMois()))
          + repartition(t('charges.par_categorie'), tot.par_categorie, nomCategorie)
          + repartition(t('charges.par_bien'), tot.par_bien, (id) => (id ? (nomBien(id) || t('charges.sans_bien')) : t('charges.sans_bien')))
          + '</div>'
      }
    }
    z.innerHTML = `<div class="chg-bloc__tete"><h2 class="chg-h2">${esc(t('charges.totaux'))}</h2></div>` + selecteurs() + corps
  }

  // ─── Toutes les factures ─────────────────────────────────────────────────
  function peindreListe () {
    const z = $('[data-bind="liste"]')
    const tete = `<div class="chg-bloc__tete"><h2 class="chg-h2">${esc(t('charges.toutes'))}</h2></div>`
    z.innerHTML = tete + (etat.liste.length
      ? `<ul class="chg-lignes chg-lignes--liste">${etat.liste.map(c => ligne(c, false)).join('')}</ul>`
      : `<p class="muted">${esc(t('charges.liste_vide'))}</p>`)
      + (etat.suite ? `<button type="button" class="btn btn--secondary chg-plus" data-geste="plus">${esc(t('charges.afficher_plus'))}</button>` : '')
  }

  // ─── Les crédits (§14.20) ────────────────────────────────────────────────
  function formulaireCredit () {
    const actives = entitesActives()
    const choisie = actives.length === 1 ? String(actives[0].id) : ''
    return '<form class="chg-form chg-credit-form" data-bind="credit-form" novalidate>'
      + `<p class="chg-note">${esc(t('charges.credit_aide'))}</p>`
      + champ('credit_fichier', t('charges.credit_tableau'), '<input type="file" accept="application/pdf,.pdf" data-credit-champ="fichier">')
      + champ('credit_preteur', t('charges.credit_preteur'), '<input type="text" maxlength="120" autocomplete="off" data-credit-champ="preteur">')
      + champ('credit_entite', t('charges.champ_entite'), `<select data-credit-champ="entite"><option value="">${esc(t('charges.choisir'))}</option>`
        + actives.map(x => `<option value="${esc(x.id)}"${String(x.id) === choisie ? ' selected' : ''}>${esc(nomEntite(x))}</option>`).join('') + '</select>')
      + champ('credit_bien', t('charges.champ_bien'), `<select data-credit-champ="bien">${optionsBiensCredit(choisie)}</select>`, true)
      + '<div class="chg-alerte__gestes">'
      + `<button type="button" class="btn btn--primary" data-geste="credit-importer">${esc(t('charges.credit_importer'))}</button>`
      + `<button type="button" class="btn btn--secondary" data-geste="credit-annuler">${esc(t('charges.annuler'))}</button>`
      + '</div></form>'
  }
  // Sans logement choisi, le crédit vaut pour toute l'entité (les logements
  // qu'il finance ensemble, comme une facture qui couvre deux logements).
  const optionsBiensCredit = (entiteId) => optionsBiens(entiteId, null)
    .replace(`>${esc(t('charges.aucun_bien'))}<`, `>${esc(t('charges.credit_tous_biens'))}<`)

  function peindreCredits () {
    const z = $('[data-bind="credits"]')
    if (!z) return
    const tete = `<div class="chg-bloc__tete"><h2 class="chg-h2">${esc(t('charges.credits'))}</h2>`
      + (etat.creditForm ? '' : `<button type="button" class="btn btn--secondary" data-geste="credit-ajouter">${esc(t('charges.credit_ajouter'))}</button>`)
      + '</div>'
    const cr = etat.credits
    let corps
    if (!cr) corps = `<p class="muted">${esc(t('charges.credits_indispo'))}</p>`
    else if (!cr.liste.length) corps = etat.creditForm ? '' : `<p class="muted">${esc(t('charges.credits_vide'))}</p>`
    else {
      corps = '<ul class="chg-credits">' + cr.liste.map(c => {
        const ent = etat.entites.find(e => String(e.id) === String(c.entite_juridique_id))
        const ou = [ent ? nomEntite(ent) : '', c.bien_id ? nomBien(c.bien_id) : t('charges.credit_tous_biens')].filter(Boolean).join(' · ')
        return '<li class="chg-credit"><span class="chg-credit__qui">'
          + `<b>${esc(c.preteur)}</b><span class="chg-ligne__infos">${esc(ou)}</span>`
          + `<span class="chg-ligne__infos">${esc(t('charges.credit_echeances', { n: c.nb_echeances, debut: jourLisible(c.premiere_echeance), fin: jourLisible(c.derniere_echeance) }))}</span></span>`
          + `<button type="button" class="btn btn--secondary chg-danger" data-geste="credit-supprimer" data-credit="${esc(c.id)}">${esc(t('charges.supprimer'))}</button></li>`
      }).join('') + '</ul>'
    }
    const retour = etat.creditRetour
    z.innerHTML = tete + (etat.creditForm ? formulaireCredit() : '')
      + `<p class="${retour && retour.erreur ? 'chg-erreur' : 'chg-note'}" data-bind="credit-retour" role="status">${esc(retour ? retour.texte : '')}</p>`
      + corps
  }

  function retourCredit (texte, erreur = false) {
    etat.creditRetour = texte ? { texte, erreur } : null
    const p = $('[data-bind="credit-retour"]')
    if (p) { p.textContent = texte || ''; p.className = erreur ? 'chg-erreur' : 'chg-note' }
  }

  // Le PDF part en base64 dans le corps du geste (2 Mo au plus) : un tableau
  // d'amortissement pèse quelques centaines de Ko.
  const enBase64 = (f) => new Promise((ok, ko) => {
    const r = new Lecteur()
    r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ''))
    r.onerror = () => ko(r.error || new Error('lecture'))
    r.readAsDataURL(f)
  })

  async function importerCredit () {
    if (etat.creditEnCours) return
    const champCredit = (k) => $(`[data-credit-champ="${k}"]`)
    const f = champCredit('fichier') && champCredit('fichier').files && champCredit('fichier').files[0]
    const preteur = (champCredit('preteur').value || '').trim()
    const entite = champCredit('entite').value
    const bien = champCredit('bien').value
    if (!f) { retourCredit(t('charges.credit_fichier_requis'), true); return }
    if (typeDuFichier(f) !== 'application/pdf') { retourCredit(t('charges.credit_pdf_seul'), true); return }
    if (f.size > CREDIT_PDF_MAX) { retourCredit(t('charges.credit_trop_gros'), true); return }
    if (!preteur) { retourCredit(t('charges.refus_preteur_requis'), true); return }
    if (!entite) { retourCredit(t('charges.credit_entite_requise'), true); return }
    etat.creditEnCours = true
    const bouton = $('[data-geste="credit-importer"]')
    if (bouton) bouton.disabled = true
    retourCredit(t('charges.credit_lecture'))
    try {
      const fichier = await enBase64(f)
      const r = await deps.agir({ action: 'credit_importer', fichier, preteur, entite_id: entite, bien_id: bien || null })
      etat.creditForm = false
      const c = (r && r.credit) || {}
      etat.creditRetour = { texte: t('charges.credit_importe', { n: c.nb_echeances, charges: r.charges, debut: jourLisible(c.premiere_echeance), fin: jourLisible(c.derniere_echeance) }), erreur: false }
      await recharger()
    } catch (e) {
      // ⚠ UNE LIGNE QUI NE SE PROUVE PAS SE NOMME par sa date : l'hôte la
      // retrouve dans son tableau.
      // Les refus communs aux factures parlent de factures : ceux d'un crédit
      // ont leurs mots (review du lot, mineur 5).
      const propres = { type_refuse: 'charges.credit_pdf_seul', trop_gros: 'charges.credit_trop_gros', entite_requise: 'charges.credit_entite_requise' }
      retourCredit(e && e.code === 'ligne_incoherente' && e.detail
        ? t('charges.refus_ligne_incoherente', { date: jourLisible(e.detail) })
        : e && propres[e.code] ? t(propres[e.code]) : messageErreur(e), true)
    } finally {
      etat.creditEnCours = false
      const b = $('[data-geste="credit-importer"]')
      if (b) b.disabled = false
    }
  }

  async function supprimerCredit (id) {
    if (!id || !deps.confirmer(t('charges.credit_confirmer_suppression'))) return
    try {
      await deps.agir({ action: 'credit_supprimer', id })
      etat.creditRetour = { texte: t('charges.credit_supprime'), erreur: false }
      await recharger()
    } catch (e) {
      retourCredit(messageErreur(e), true)
    }
  }

  function peindre () { peindreATraiter(); peindreTotaux(); peindreCredits(); peindreListe() }

  // ─── Les lectures ────────────────────────────────────────────────────────
  function appliquer (d) {
    etat.aTraiter = (d && d.a_traiter) || { lignes: [], nombre: 0 }
    etat.liste = (d && d.liste && d.liste.lignes) || []
    etat.suite = (d && d.liste && d.liste.suite) || null
    etat.entites = (d && d.entites) || []
    etat.biens = (d && d.biens) || []
    etat.biensArchives = (d && d.biens_archives) || []
    etat.categories = (d && d.categories) || []
    etat.totaux = (d && d.totaux) || null
    etat.credits = (d && d.credits) || null
    if (etat.totaux && etat.totaux.periode) etat.periode = etat.totaux.periode
  }

  async function recharger () {
    const p = new URLSearchParams()
    p.set('entite', etat.entite)
    if (etat.periode) p.set('periode', etat.periode)
    let d
    try {
      d = await deps.charger(p.toString())
    } catch (e) {
      // Une entité disparue (archivée puis supprimée, autre onglet) : on
      // revient à « Toutes » au lieu de laisser l'écran en échec.
      if (e && e.status === 404 && etat.entite !== 'toutes') {
        etat.entite = 'toutes'; etat.periode = ''
        return recharger()
      }
      const z = $('[data-bind="a-traiter"]')
      z.innerHTML = `<p class="chg-erreur">${esc(e && e.status === 403 ? t('charges.acces_refuse') : t('charges.erreur_serveur'))}</p>`
      return false
    }
    appliquer(d)
    peindre()
    return true
  }

  async function afficherPlus (bouton) {
    if (!etat.suite || etat.occupe) return
    etat.occupe = true
    bouton.disabled = true
    try {
      const d = await deps.charger('curseur=' + encodeURIComponent(etat.suite))
      etat.liste = etat.liste.concat((d && d.liste && d.liste.lignes) || [])
      etat.suite = (d && d.liste && d.liste.suite) || null
    } catch (e) {
      bouton.disabled = false
      etat.occupe = false
      bouton.insertAdjacentHTML('afterend', `<p class="chg-erreur">${esc(messageErreur(e))}</p>`)
      return
    }
    etat.occupe = false
    peindreListe()
  }

  // ─── La fiche ────────────────────────────────────────────────────────────
  const dialogue = () => $('[data-bind="fiche"]')
  function ouvrirDialogue (dlg) {
    if (typeof dlg.showModal === 'function') { try { dlg.showModal(); return } catch { /* déjà ouverte */ } }
    dlg.setAttribute('open', '')
  }
  function fermerDialogue (dlg) {
    if (typeof dlg.close === 'function') { try { dlg.close(); return } catch { /* déjà fermée */ } }
    dlg.removeAttribute('open')
  }

  const entitesActives = () => etat.entites.filter(e => !e.archivee)

  function optionsBiens (entiteId, actuel) {
    const proposes = (etat.biens || []).filter(b => entiteId && String(b.entite_id) === String(entiteId))
    // Le logement que la facture porte déjà reste proposé, même archivé ou
    // passé à une autre entité : une facture validée garde son rattachement.
    const garde = actuel && !proposes.some(b => String(b.id) === String(actuel))
      ? [{ id: actuel, nom: nomBien(actuel) || actuel }] : []
    return `<option value="">${esc(t('charges.aucun_bien'))}</option>`
      + [...proposes, ...garde].map(b => `<option value="${esc(b.id)}"${String(b.id) === String(actuel || '') ? ' selected' : ''}>${esc(b.nom)}</option>`).join('')
  }

  function champ (cle, libelle, controle, facultatif) {
    return `<label class="chg-champ"><span>${esc(libelle)}${facultatif ? ` <span class="muted">${esc(t('charges.facultatif'))}</span>` : ''}</span>${controle}</label>`
  }

  // Ce que le type change au calcul, dit sous son champ (lot 7a).
  function aideType (type, c) {
    if (type === 'regularisation') {
      const solde = c ? (c.solde_lu ?? (c.lecture_ia && c.lecture_ia.solde_ttc_cents)) : null
      return t('charges.aide_regularisation') + (Number.isInteger(solde) ? ' ' + t('charges.solde_lu', { montant: fmtMontant.format(solde / 100) }) : '')
    }
    if (type === 'avoir') return t('charges.aide_avoir')
    if (type === 'echeancier') return t('charges.aide_echeancier')
    if (type === 'avis_impot') return t('charges.aide_avis_impot')
    return ''
  }

  // ⚠ UN IMPÔT N'A PAS DE TVA (décision de Thierry, recette du 17 novembre
  // 2026) : ses cases HT et TVA se retirent et l'aide dit « sans objet ». Le
  // serveur pose HT = TTC et TVA = 0 quoi qu'on envoie : ce masquage est un
  // confort, la règle vit dans `montantsDuType` et dans `charges_impot_ck`.
  function adapterMontants (type) {
    const impot = type === 'avis_impot'
    const [ht, tva] = ['montant_ht_cents', 'montant_tva_cents'].map(k => dialogue().querySelector(`[data-champ="${k}"]`))
    if (!ht || !tva) return
    // ⚠ EN QUITTANT « Avis d'impôt », HT = TTC et TVA = 0 ne sont pas des
    // montants LUS : c'est la règle de l'impôt qui les a posés (review du
    // correctif, constat A). Gardés, une facture que l'IA aurait classée en
    // impôt repartirait avec une TVA à 0 que personne n'a lue — et sans
    // « Estimation ». Ils redeviennent « non lu ».
    if (!impot && ht.closest('label').hidden) {
      const ttc = dialogue().querySelector('[data-champ="montant_ttc_cents"]')
      if (ttc && enCentimes(tva.value) === 0 && enCentimes(ht.value) === enCentimes(ttc.value)) { ht.value = ''; tva.value = '' }
    }
    ht.closest('label').hidden = impot
    tva.closest('label').hidden = impot
  }

  function peindreFiche (c) {
    const e = etatDe(c)
    const ota = c.origine === 'ota'
    // Une échéance de crédit vient de son tableau : elle se lit, elle ne se
    // corrige pas ici (§14.20).
    const credit = c.origine === 'credit'
    const fige = ota || credit ? ' disabled' : ''
    const actives = entitesActives()
    // L'entité de la facture : celle qu'elle porte (même archivée), sinon la
    // seule entité active s'il n'y en a qu'une.
    const entiteChoisie = c.entite_juridique_id || (actives.length === 1 ? actives[0].id : '')
    const proposables = [...actives]
    const portee = etat.entites.find(x => String(x.id) === String(c.entite_juridique_id || ''))
    if (portee && portee.archivee) proposables.push(portee)
    const sansEntite = !actives.length && !(c.statut === 'validee' && c.entite_juridique_id)

    const autres = [...connues().values()].filter(x => racineDe(x) === racineDe(c) && x.id !== c.id)
    const blocDoublon = e === 'doublon'
      ? `<div class="chg-alerte"><p>${esc(t('charges.doublon_aide'))}</p><div class="chg-alerte__gestes">`
        + `<button type="button" class="btn btn--secondary" data-geste="trancher">${esc(t('charges.garder_les_deux'))}</button>`
        + (autres.length ? `<button type="button" class="btn btn--secondary" data-ouvrir="${esc(autres[0].id)}">${esc(t('charges.voir_autre'))}</button>` : '')
        + '</div></div>'
      : ''
    const note = (e === 'panne' || e === 'plafond' || e === 'a_lire') ? t('charges.lecture_attente')
      : e === 'illisible' ? t('charges.illisible_aide')
        : ota ? t('charges.commission_aide') : credit ? t('charges.credit_fiche_aide') : ''
    const verifiee = c.statut === 'validee' && c.valide_le ? `<p class="chg-verifiee">${esc(t('charges.validee_le', { date: jourLisible(c.valide_le) }))}</p>` : ''
    // ⚠ UN AVOIR SE SAISIT TEL QU'IMPRIMÉ (Q26) : le champ montre le montant
    // sans signe, et c'est le serveur qui le rend négatif.
    const montantChamp = (cle, libelle) => champ(cle, libelle,
      `<input type="text" inputmode="decimal" autocomplete="off" data-champ="${cle}" value="${esc(enSaisie(Number.isInteger(c[cle]) ? Math.abs(c[cle]) : c[cle], langue))}"${fige}>`)
    const type = c.type_document || 'facture'

    dialogue().innerHTML = '<div class="chg-fiche__tete">'
      + `<h2 class="chg-h2" id="chg-fiche-titre">${esc(t('charges.fiche_titre'))}</h2>`
      + (e ? `<span class="chg-etat chg-etat--${esc(e)}">${esc(t('charges.etat_' + e))}</span>` : '')
      + `<button type="button" class="btn btn--secondary btn--icon" data-geste="fermer" aria-label="${esc(t('charges.fermer'))}"><svg class="icon" aria-hidden="true"><use href="/shared/icons.svg#i-close"/></svg></button>`
      + '</div><div class="chg-fiche__corps">'
      + blocDoublon
      + (note ? `<p class="chg-note">${esc(note)}</p>` : '')
      + verifiee
      + '<form class="chg-form" data-bind="fiche-form" novalidate>'
      + champ('fournisseur_nom', t('charges.champ_fournisseur'), `<input type="text" maxlength="200" data-champ="fournisseur_nom" value="${esc(c.fournisseur_nom || '')}"${fige}>`)
      + champ('fournisseur_siret', t('charges.champ_siret'), `<input type="text" inputmode="numeric" maxlength="20" data-champ="fournisseur_siret" value="${esc(c.fournisseur_siret || '')}"${fige}>`, true)
      + champ('numero_facture', t('charges.champ_numero'), `<input type="text" maxlength="100" data-champ="numero_facture" value="${esc(c.numero_facture || '')}"${fige}>`, true)
      + champ('date_facture', t('charges.champ_date'), `<input type="date" data-champ="date_facture" value="${esc(c.date_facture || '')}"${fige}>`)
      + champ('type_document', t('charges.champ_type'), `<select data-champ="type_document"${fige}>`
        + TYPES_DOCUMENT.map(k => `<option value="${k}"${k === type ? ' selected' : ''}>${esc(t('charges.type_' + k))}</option>`).join('') + '</select>')
      + `<fieldset class="chg-periode"><legend>${esc(t('charges.champ_periode'))} <span class="muted">${esc(t('charges.facultatif'))}</span></legend>`
      + '<div class="chg-periode__dates">'
      + champ('periode_debut', t('charges.periode_du'), `<input type="date" data-champ="periode_debut" value="${esc(c.periode_debut || '')}"${fige}>`)
      + champ('periode_fin', t('charges.periode_au'), `<input type="date" data-champ="periode_fin" value="${esc(c.periode_fin || '')}"${fige}>`)
      + '</div></fieldset>'
      + `<p class="chg-note" data-bind="aide-type">${esc(aideType(type, c))}</p>`
      + '<div class="chg-montants">'
      + montantChamp('montant_ht_cents', t('charges.champ_ht'))
      + montantChamp('montant_tva_cents', t('charges.champ_tva'))
      + montantChamp('montant_ttc_cents', t('charges.champ_ttc'))
      + '</div>'
      + champ('categorie', t('charges.champ_categorie'), `<select data-champ="categorie"${fige}><option value="">${esc(t('charges.choisir'))}</option>`
        + [...etat.categories, ...(c.categorie && !etat.categories.includes(c.categorie) ? [c.categorie] : [])]
          .map(k => `<option value="${esc(k)}"${k === c.categorie ? ' selected' : ''}>${esc(nomCategorie(k))}</option>`).join('') + '</select>')
      + (sansEntite ? '' : champ('entite_juridique_id', t('charges.champ_entite'), `<select data-champ="entite_juridique_id"${fige}><option value="">${esc(t('charges.choisir'))}</option>`
        + proposables.map(x => `<option value="${esc(x.id)}"${String(x.id) === String(entiteChoisie) ? ' selected' : ''}>${esc(nomEntite(x))}</option>`).join('') + '</select>'))
      + (sansEntite ? '' : champ('bien_id', t('charges.champ_bien'), `<select data-champ="bien_id"${fige}>${optionsBiens(entiteChoisie, c.bien_id)}</select>`, true))
      + '</form>'
      + (sansEntite ? `<div class="chg-alerte"><p>${esc(t('charges.sans_entite'))}</p><a class="btn btn--secondary" href="/logements">${esc(t('charges.vers_logements'))}</a></div>` : '')
      + '<p class="chg-erreur" data-bind="fiche-retour" role="status"></p>'
      + '</div><div class="chg-fiche__pied">'
      + (ota || credit || c.statut === 'sans_facture' ? '' : `<button type="button" class="btn btn--secondary" data-geste="voir">${esc(t('charges.voir'))}</button>`)
      + (credit ? '' : `<button type="button" class="btn btn--secondary chg-danger" data-geste="supprimer">${esc(t('charges.supprimer'))}</button>`)
      + (ota || credit || sansEntite ? '' : `<button type="button" class="btn btn--primary" data-geste="valider">${esc(t('charges.valider'))}</button>`)
      + '</div>'
    // Entrée dans un champ ne doit ni fermer la fenêtre ni rien envoyer.
    dialogue().querySelector('[data-bind="fiche-form"]').addEventListener('submit', (ev) => ev.preventDefault())
    adapterMontants(type)
  }

  function ouvrirFiche (id) {
    const c = connues().get(String(id))
    if (!c) return
    etat.fiche = c
    peindreFiche(c)
    const dlg = dialogue()
    if (!dlg.open && !dlg.hasAttribute('open')) ouvrirDialogue(dlg)
  }

  const retourFiche = (texte) => { const r = dialogue().querySelector('[data-bind="fiche-retour"]'); if (r) r.textContent = texte || '' }

  /** Les champs saisis, au contrat de `valider` — ou le code du premier refus. */
  function lireChamps () {
    const v = (cle) => { const el = dialogue().querySelector(`[data-champ="${cle}"]`); return el ? el.value : '' }
    const champs = {
      fournisseur_nom: v('fournisseur_nom').trim() || null,
      fournisseur_siret: v('fournisseur_siret').trim() || null,
      numero_facture: v('numero_facture').trim() || null,
      date_facture: v('date_facture') || null,
      categorie: v('categorie'),
      entite_juridique_id: v('entite_juridique_id'),
      bien_id: v('bien_id') || null,
      type_document: v('type_document') || 'facture',
      periode_debut: v('periode_debut') || null,
      periode_fin: v('periode_fin') || null
    }
    const p = controlePeriode(champs.periode_debut, champs.periode_fin)
    if (p) return { refus: p }
    // Un avis d'impôt ne lit que son TTC : ses cases HT et TVA sont retirées.
    const impot = champs.type_document === 'avis_impot'
    for (const k of impot ? ['montant_ttc_cents'] : ['montant_ht_cents', 'montant_tva_cents', 'montant_ttc_cents']) {
      const c = enCentimes(v(k))
      if (c === undefined) return { refus: 'montant_invalide' }
      champs[k] = c
    }
    if (impot) { champs.montant_ht_cents = champs.montant_ttc_cents; champs.montant_tva_cents = 0 }
    if (!champs.categorie) return { refus: 'categorie_invalide' }
    if (!champs.entite_juridique_id) return { refus: 'entite_requise' }
    return { champs }
  }

  // Un geste de la fiche : un à la fois, l'erreur reste dans la fiche.
  async function gesteFiche (fn) {
    if (etat.ficheEnCours) return
    etat.ficheEnCours = true
    const boutons = [...dialogue().querySelectorAll('[data-geste]')]
    boutons.forEach(b => { b.disabled = true })
    try {
      await fn()
    } catch (e) {
      retourFiche(messageErreur(e))
    } finally {
      etat.ficheEnCours = false
      boutons.forEach(b => { b.disabled = false })
    }
  }

  const fermerFiche = () => { etat.fiche = null; fermerDialogue(dialogue()) }

  function valider () {
    return gesteFiche(async () => {
      const c = etat.fiche
      const l = lireChamps()
      if (l.refus) { retourFiche(t('charges.refus_' + l.refus)); return }
      await deps.agir({ action: 'valider', id: c.id, champs: l.champs })
      fermerFiche()
      await recharger()
    })
  }

  function trancher () {
    return gesteFiche(async () => {
      await deps.agir({ action: 'trancher', id: etat.fiche.id })
      fermerFiche()
      await recharger()
    })
  }

  function supprimer () {
    if (!deps.confirmer(t('charges.confirmer_suppression'))) return
    return gesteFiche(async () => {
      await deps.agir({ action: 'supprimer', id: etat.fiche.id })
      fermerFiche()
      await recharger()
    })
  }

  // ⚠ L'ONGLET S'OUVRE AU CLIC, AVANT LA RÉPONSE : ouvert après un `await`, le
  // navigateur le bloquerait comme une fenêtre surgissante. Il reçoit ensuite
  // l'adresse de 60 s, ou se referme si le serveur refuse.
  function voir () {
    const onglet = deps.ouvrirOnglet()
    return gesteFiche(async () => {
      try {
        const r = await deps.agir({ action: 'consulter', id: etat.fiche.id })
        if (onglet) { try { onglet.opener = null } catch { /* autre origine */ } onglet.location.href = r.url }
      } catch (e) {
        if (onglet) { try { onglet.close() } catch { /* déjà fermé */ } }
        throw e
      }
    })
  }

  // ─── L'ajout d'une facture : un seul bouton (Q32) ────────────────────────
  const statutEnvoi = (texte, erreur) => {
    const z = $('[data-bind="envoi"]')
    z.textContent = texte || ''
    z.classList.toggle('chg-erreur', Boolean(erreur))
  }

  async function envoyer (fichier) {
    if (etat.envoiEnCours || !fichier) return
    let type = typeDuFichier(fichier)
    // Un fichier SANS type, ou au type générique, que son nom ne fait pas
    // reconnaître : son contenu tranche. Un type précis (texte, tableur…)
    // n'est pas contredit.
    if (!type || type === 'application/octet-stream') type = (await formatLu(fichier, Lecteur)) || type
    const image = /^image\//.test(type)
    if (type !== 'application/pdf' && !image) { statutEnvoi(t('charges.refus_type_refuse'), true); return }
    etat.envoiEnCours = true
    const bouton = $('[data-action="ajouter"]')
    if (bouton) bouton.disabled = true
    try {
      let corps = fichier
      // Une photo se réduit AVANT l'envoi (shared/photo-bien-client.js) : moins
      // lourde à envoyer en 4G, et moins chère à lire.
      if (image) {
        let brut = null
        try {
          // ⚠ Le type reconnu (extension ou contenu) est donné au fichier, parce
          // que `preparerJpeg` refuse tout fichier dont le TYPE n'est pas
          // `image/…` (shared/photo-bien-client.js). Le navigateur, lui,
          // reconnaît l'image à son contenu : ce retypage sert la garde.
          corps = await deps.reduireImage(fichier.type === type ? fichier : fichier.slice(0, fichier.size, type))
        } catch (e) {
          // Le message de FORMAT ne vaut que pour un refus de format
          // (`code: 'type'`) ; toute autre panne de conversion (mémoire,
          // canvas) est un refus ordinaire (review, constat 3). Un HEIC se
          // reconnaît aussi à son contenu, même nommé « .jpg ».
          let refus = 'charges.refus'
          if (e && e.code === 'taille') refus = 'charges.refus_trop_gros'
          else if (e && e.code === 'type') {
            const heic = estHeic(type) ? type : await formatLu(fichier, Lecteur)
            // ⚠ UN HEIC QUE CE NAVIGATEUR NE SAIT PAS LIRE PART TEL QUEL : le
            // serveur le convertit en JPEG à la confirmation (§14.19).
            if (estHeic(heic)) brut = heic.replace('-sequence', '')
            else refus = 'charges.refus_image_illisible'
          }
          if (!brut) { statutEnvoi(t(refus), true); return }
        }
        if (brut) {
          type = brut
          corps = fichier.type === type ? fichier : fichier.slice(0, fichier.size, type)
        } else type = 'image/jpeg'
      } else if (corps.type !== type) {
        // ⚠ UN PDF SANS TYPE (certains sélecteurs Android et Windows) : le
        // fichier repartirait en `application/octet-stream`, que le bucket
        // refuse. On lui donne le type qu'on annonce à `envoi`.
        corps = fichier.slice(0, fichier.size, type)
      }
      if (corps.size > TYPES_ACCEPTES[type]) { statutEnvoi(t('charges.refus_trop_gros'), true); return }
      statutEnvoi(t('charges.envoi_en_cours'))
      const o = await deps.agir({ action: 'envoi', type, octets: corps.size, origine: type === 'application/pdf' ? 'fichier' : 'photo' })
      await deps.deposer(o.url, corps)
      statutEnvoi(t('charges.lecture_en_cours'))
      const r = await deps.agir({ action: 'confirmer', id: o.id })
      statutEnvoi('')
      await recharger()
      if (r && r.charge && r.charge.id) {
        // La facture qu'on vient d'envoyer s'ouvre, lue ou non : elle est en
        // tête de « À traiter » et de la liste, donc connue de l'écran.
        if (!connues().has(String(r.charge.id))) etat.aTraiter.lignes = [r.charge, ...etat.aTraiter.lignes]
        ouvrirFiche(r.charge.id)
      }
    } catch (e) {
      statutEnvoi(messageErreur(e), true)
    } finally {
      etat.envoiEnCours = false
      if (bouton) bouton.disabled = false
    }
  }

  // ─── Les écouteurs : un seul, délégué ────────────────────────────────────
  racine.addEventListener('click', (ev) => {
    const el = ev.target.closest && ev.target.closest('[data-ouvrir],[data-geste],[data-action]')
    if (!el) return
    if (el.dataset.ouvrir) { ouvrirFiche(el.dataset.ouvrir); return }
    const g = el.dataset.geste || el.dataset.action
    if (g === 'ajouter') $('[data-bind="fichier"]').click()
    else if (g === 'plus') afficherPlus(el)
    else if (g === 'fermer') fermerFiche()
    else if (g === 'valider') valider()
    else if (g === 'trancher') trancher()
    else if (g === 'supprimer') supprimer()
    else if (g === 'voir') voir()
    else if (g === 'credit-ajouter') { etat.creditForm = true; etat.creditRetour = null; peindreCredits() }
    else if (g === 'credit-annuler') { etat.creditForm = false; etat.creditRetour = null; peindreCredits() }
    else if (g === 'credit-importer') importerCredit()
    else if (g === 'credit-supprimer') supprimerCredit(el.dataset.credit)
  })
  racine.addEventListener('change', (ev) => {
    const el = ev.target
    if (el.dataset && el.dataset.choix === 'entite') { etat.entite = el.value; etat.periode = ''; recharger(); return }
    if (el.dataset && el.dataset.choix === 'periode') { etat.periode = el.value; recharger(); return }
    if (el.dataset && el.dataset.creditChamp === 'entite') {
      const b = $('[data-credit-champ="bien"]')
      if (b) b.innerHTML = optionsBiensCredit(el.value)
      return
    }
    if (el.dataset && el.dataset.champ === 'type_document') {
      const aide = dialogue().querySelector('[data-bind="aide-type"]')
      if (aide) aide.textContent = aideType(el.value, etat.fiche)
      adapterMontants(el.value)
      return
    }
    if (el.dataset && el.dataset.champ === 'entite_juridique_id') {
      const b = dialogue().querySelector('[data-champ="bien_id"]')
      if (b) b.innerHTML = optionsBiens(el.value, etat.fiche && String(etat.fiche.entite_juridique_id || '') === el.value ? etat.fiche.bien_id : null)
      return
    }
    if (el.dataset && el.dataset.bind === 'fichier') {
      const f = el.files && el.files[0]
      el.value = ''
      envoyer(f)
    }
  })
  dialogue().addEventListener('close', () => { etat.fiche = null })

  return { recharger, etat, ouvrirFiche, doc }
}
