// lib/stats-avis.js
// Calcul du ratio de proprete sur une periode. FONCTION PARTAGEE.
//
// ⚠ CETTE FONCTION EST APPELEE PAR DEUX ECRANS AUX DESTINATAIRES DIFFERENTS :
//   - /avis, cote hote — tous ses biens, ou un bien ;
//   - la fiche prestataire, plus tard — restreinte aux menages qu'elle a faits.
// Ne pas la dupliquer : deux chiffres calcules differemment pour la meme chose
// finiraient par se contredire, et c'est le chiffre montre a la prestataire qui
// perdrait sa credibilite.
//
// Elle ne fait QUE compter. Elle ne decide pas de ce qui est montre a qui : ce
// filtre-la appartient a l'appelant (docs/specs/spec-prestataires-menage.md §6).

const { filtresAttribution } = require('./attribution-prestataire')

const PERIODES = {
  '15j':      15,
  '30j':      30,
  '6mois':    183,
  'toujours': null
}

// La cle retenue : celle demandee si elle existe, sinon le defaut.
function periodeNormalisee (periode) {
  return Object.prototype.hasOwnProperty.call(PERIODES, periode) ? periode : '30j'
}

// Convertit une cle de periode en borne ISO, ou null pour « toujours ».
function borneDepuis (periode, maintenant = Date.now()) {
  const jours = PERIODES[periodeNormalisee(periode)]
  if (jours == null) return null
  return new Date(maintenant - jours * 24 * 3600 * 1000).toISOString()
}

/**
 * Ratio de proprete sur une periode.
 *
 * @param sb                  client Supabase (injectable pour les tests)
 * @param opts.userId         OBLIGATOIRE. Le compte proprietaire des lignes.
 *                            Le cron et les endpoints tournent en service key :
 *                            la RLS ne les protege pas, ce filtre est la seule
 *                            defense (REVIEW.md regle 1).
 * @param opts.periode        '15j' | '30j' | '6mois' | 'toujours'. Defaut '30j'.
 * @param opts.refs           null = tous les biens du compte ; tableau de
 *                            provider_property_id = perimetre restreint. Un
 *                            TABLEAU VIDE signifie « aucun bien » et rend des
 *                            compteurs a zero — jamais « tous ».
 * @param opts.menageEventIds null = tous ; tableau = restreint a ces menages.
 * @param opts.prestataireId  profiles.id. Restreint aux avis ATTRIBUABLES a
 *                            cette personne — menage precis quand il est connu,
 *                            periode declaree sinon (lib/attribution-prestataire).
 *                            Une prestataire sans menage NI periode voit ZERO,
 *                            jamais le ratio de l'hote : un avis non attribuable
 *                            reste non attribue, aucun forcage.
 * @param opts.maintenant     horloge injectable.
 *
 * @returns { total, positif, remarque, rien_signale, non_analyses, periode, depuis }
 *          `total` = avis ET signalements CONFIRMES de la periode. Une detection
 *          en attente de validation n'y figure pas : elle n'est pas un fait.
 */
async function ratioProprete (sb, opts = {}) {
  const { userId, periode = '30j', refs = null, menageEventIds = null,
          prestataireId = null, maintenant = Date.now(),
          // ⚠ FILTRES DEJA RESOLUS, pour ne pas les refaire. Un appelant qui
          // compte deux periodes les resolvait deux fois par requete, avec les
          // memes arguments et le meme resultat : des allers-retours base
          // identiques sur un endpoint ouvert sans session, qu'un porteur de
          // lien peut marteler. Le contrat est le `voies` de
          // `filtresAttribution`.
          voies: voiesFournies = null } = opts

  const vide = { total: 0, positif: 0, remarque: 0, rien_signale: 0,
                 non_analyses: 0, periode: periodeNormalisee(periode), depuis: null }
  if (!userId) return vide

  const depuis = borneDepuis(periode, maintenant)
  vide.depuis = depuis

  // Perimetre vide : aucun bien, donc rien a compter. Distinguer du null, qui
  // veut dire « tous les biens » — les confondre montrerait a un membre au
  // perimetre vide les chiffres de tout le compte.
  if (Array.isArray(refs) && refs.length === 0) return vide
  if (Array.isArray(menageEventIds) && menageEventIds.length === 0) return vide

  // ⚠ ATTRIBUTION A UNE PRESTATAIRE : ON COMPTE PAR FILTRES, PLUS PAR IDENTIFIANTS.
  //
  // La version precedente resolvait d'abord SES avis en une liste d'ids, puis
  // comptait dessus avec `.in('id', ids)`. La liste est bornee a `MAX_IDS = 150`
  // par la longueur d'URL — a raison — et cette borne decidait donc de la valeur
  // du compteur. Mesure du 14 septembre 2026 : Regina avait 577 avis
  // attribuables, le ratio en annoncait 150, marques « tronques », et l'en-tete
  // de sa PWA restait masquee. Le chiffre n'etait meme pas un sous-total : la
  // borne s'appliquait deux fois, sur des lignes qu'aucun `order` ne fixait.
  //
  // `filtresAttribution` rend les FILTRES, signes, et on somme leurs `count`.
  // Aucun identifiant ne transite : le compteur est exact quel qu'en soit le
  // nombre, et la borne ne concerne plus que la LISTE affichee — qui, elle, a le
  // droit d'etre paginee et le dit avec son propre drapeau.
  let voies = voiesFournies
  if (prestataireId && !voies) {
    const f = await filtresAttribution(sb, { userId, prestataireId })
    if (f.erreur) return { ...vide, erreur: true }
    // Aucune voie = cette personne n'a aucun avis attribuable. C'est ZERO, un
    // resultat — pas « tous », qui lui attribuerait le travail des autres.
    voies = f.voies
  }
  // Aucune voie = cette personne n'a aucun avis attribuable. ZERO, un resultat.
  if (prestataireId && voies && !voies.length) return vide

  // ⚠ COMPTAGE COTE BASE, pas en JS sur les lignes rapatriees.
  //
  // Une premiere version faisait `select(...)` puis comptait la reponse. Or
  // PostgREST applique `db-max-rows` (1000 par defaut) : au-dela, la reponse est
  // tronquee SANS erreur et sans indication. Le total etait alors faux, en
  // moins, et rien ne le disait — et comme aucun `order` n'etait pose, les
  // lignes retenues n'etaient meme pas les memes d'un appel a l'autre. Sur la
  // fiche prestataire, cela aurait montre a une femme de menage un ratio calcule
  // sur une fraction arbitraire de son travail.
  //
  // `head: true` ne transfere AUCUNE ligne : quatre comptages exacts coutent
  // moins que l'ancien rapatriement.
  const base = (select = 'id') => {
    let q = sb.from('ota_reviews')
      .select(select, { count: 'exact', head: true })
      .eq('user_id', userId)
      // Les CONFIRMES seuls. Une detection en attente n'est pas un fait : la
      // compter reviendrait a reprocher a la prestataire quelque chose que
      // l'hote n'a pas valide.
      .eq('statut', 'confirme')
      // ⚠ UN AVIS MASQUE PAR AIRBNB N'EST PAS UN AVIS RECU (recette de Thierry
      // du 7 octobre 2026). Double aveugle : le voyageur a depose son avis,
      // Airbnb le cache — ni texte ni note — tant que l'hote n'a pas evalue.
      // Compte, il gonflait le total (688 au lieu de 664) et entrait a 0/10
      // dans la moyenne. Il redevient compte quand Airbnb le revele.
      .eq('is_hidden', false)
    // ⚠ `received_at` est NULLABLE (un provider peut ne pas le fournir), et
    // `NULL >= x` vaut NULL : un avis sans date est donc exclu de toute periode
    // bornee, et n'apparait que sous « toujours ». C'est voulu — le dater
    // arbitrairement fausserait la periode — mais ce n'est pas un oubli.
    if (depuis) q = q.gte('received_at', depuis)
    if (Array.isArray(refs)) q = q.in('property_id_ref', refs)
    if (Array.isArray(menageEventIds)) q = q.in('menage_event_id', menageEventIds)
    return q
  }

  // Un verdict, tous les filtres, la somme signee.
  //
  // ⚠ LES VOIES SE SOMMENT AVEC LEUR SIGNE, et l'intersection est NEGATIVE :
  // un avis dont le menage est precisement le sien ET qui tombe dans une periode
  // declaree releve des deux voies. Le compter deux fois gonflerait son total —
  // et sur un ratio de proprete, gonfler le denominateur ADOUCIT ses remarques.
  // Un chiffre faux dans le sens flatteur reste un chiffre faux.
  const compter = async (verdict) => {
    if (!voies) {
      const r = await (verdict ? base().eq('ai_clean_verdict', verdict) : base())
      return r.error ? { error: r.error } : { n: r.count || 0 }
    }
    const rs = await Promise.all(voies.map(v => {
      let q = v.appliquer(base(v.select))
      if (verdict) q = q.eq('ai_clean_verdict', verdict)
      return q
    }))
    const ko = rs.find(r => r.error)
    if (ko) return { error: ko.error }
    return { n: rs.reduce((s, r, i) => s + voies[i].signe * (r.count || 0), 0) }
  }

  const [tot, pos, rem, rien] = await Promise.all([
    compter(null), compter('positif'), compter('remarque'), compter('rien_signale')
  ])

  const erreur = tot.error || pos.error || rem.error || rien.error
  if (erreur) {
    console.error('[stats-avis] comptage echec:', erreur.message)
    // ⚠ Une panne n'est pas « zero avis ». On le DIT plutot que de rendre des
    // compteurs a zero, qui se liraient comme un resultat.
    return { ...vide, erreur: true }
  }

  const out = {
    total:        tot.n || 0,
    positif:      pos.n || 0,
    remarque:     rem.n || 0,
    rien_signale: rien.n || 0,
    non_analyses: 0,
    // ⚠ La cle NORMALISEE, pas celle recue : quand une periode inconnue retombe
    // sur le defaut, rendre l'entree telle quelle ferait se contredire `periode`
    // et `depuis` dans le meme objet — et le front afficherait la chaine brute.
    periode: periodeNormalisee(periode),
    depuis
    // ⚠ PLUS DE DRAPEAU `tronque` SUR LE RATIO : il n'a plus de borne a atteindre.
    // Il en portait un parce qu'il heritait de celle de la LISTE d'identifiants,
    // qu'il n'utilise plus. Le laisser « au cas ou » aurait garde masquee
    // l'en-tete qu'on vient de rendre vraie. La liste, elle, garde le sien —
    // `listeTronquee`, cote api/menages-public.js : deux choses differentes,
    // deux drapeaux.
  }
  // Le reste : les avis pas encore analyses. Les ranger dans « rien signale »
  // ferait croire que la question a ete tranchee.
  out.non_analyses = Math.max(0, out.total - out.positif - out.remarque - out.rien_signale)
  return out
}

// ─── La note moyenne, sur la MEME population que le ratio ────────────────────
// Recette du 7 octobre 2026 : la page faisait la moyenne des 500 premieres
// lignes qu'elle recevait, zeros des avis masques compris (9,0 affiche, 9,57
// reel). La moyenne se calcule ICI, sur TOUS les avis de la periode, comptes
// comme le ratio : confirmes, visibles, du perimetre. Paginee : une lecture
// non bornee serait tronquee a 1000 lignes sans erreur (db-max-rows).
const PAGE_NOTES = 1000

// ⚠ LA POPULATION DES NOTES, ET SA LECTURE, ECRITES UNE SEULE FOIS.
// `noteMoyenne` et `notesDuPerimetre` doivent compter exactement les memes
// lignes. Jusqu'au 20 octobre 2026 au soir, seuls les FILTRES etaient partages :
// la boucle de pagination, la branche d'erreur et surtout le
// `.order('id')` etaient recopies quatre lignes plus bas. Or aucun double de
// test du depot n'observe `order()` — tous rendent `chain` sans trier — donc
// retirer ce tri d'un cote, ou des deux, laissait les 5452 tests VERTS. Sans
// ORDER BY, PostgREST ne garantit aucun ordre : deux `range()` successifs
// peuvent se chevaucher ou sauter des lignes, et la moyenne porte alors sur
// autre chose qu'une partition. C'est le defaut exact que le bloc de
// `ratioProprete`, 40 lignes plus haut, raconte avoir vecu.
//
// ⚠ LE `select` EST UN ARGUMENT, il n'est pas pose par l'appelant APRES. Un
// `from(...).eq(...)` ne compile pas chez PostgREST : `from()` rend un
// QueryBuilder qui n'expose que select/insert/update/upsert/delete, et `eq`
// n'apparait qu'apres `select`. Ecrit dans l'autre ordre, le code levait un
// TypeError en production pendant que les doubles de test — dont la chaine
// accepte tout dans n'importe quel ordre — restaient verts.
function requeteDesNotes (sb, { userId, depuis, refs, select, compter = false }) {
  let q = sb.from('ota_reviews').select(select, compter ? { count: 'exact' } : undefined)
    .eq('user_id', userId)
    // Les memes que le ratio : confirmes, visibles. Un avis masque par Airbnb
    // n'est pas un avis recu, et entrait a 0/10 dans la moyenne.
    .eq('statut', 'confirme').eq('is_hidden', false)
    .not('overall_score', 'is', null)
  // `received_at` est NULLABLE : un avis sans date n'apparait que sous
  // « toujours ». Voulu, et explique plus haut.
  if (depuis) q = q.gte('received_at', depuis)
  if (Array.isArray(refs)) q = q.in('property_id_ref', refs)
  // ⚠ LE TRI EST DANS LA REQUETE PARTAGEE, pas chez l'appelant : c'est lui qui
  // fait de `range()` une pagination et non un tirage.
  return q.order('id', { ascending: true })
}

const arrondirNote = (somme, n) => (n ? Math.round((somme / n) * 10) / 10 : null)

// Plafond de la boucle. `cartesLister` borne la sienne a 5000 avis et le DIT
// (`liste_incomplete`) : une borne atteinte se dit, jamais en silence. Celle-ci
// est plus large — trois colonnes, et elle doit rendre un chiffre JUSTE, pas un
// extrait — mais elle existe : sans elle, la boucle n'avait aucune condition
// d'arret autre que la fin des donnees, sur le chemin critique de l'accueil.
const MAX_NOTES = 50000

// ─── Les notes, GLOBAL ET PAR BIEN, en une seule lecture ────────────────
//
// ⚠ POURQUOI ELLE EXISTE. `pages/aujourdhui` appelait `/api/avis?action=cartes`
// UNE FOIS POUR LE COMPTE PUIS UNE FOIS PAR BIEN, pour ne lire que
// `stats.moyenne` et `stats.notes`. Chaque appel assemblait les cartes deux
// fois, lisait jusqu'a 5000 avis et 2000 evaluations, leurs sejours et leurs
// menages — pour jeter tout cela et ne garder que deux nombres. Mesure de
// Thierry en production le 20 octobre 2026 : quatre appels, 10,7 s puis
// 3 x 4-5 s, environ 75 % des ~20 s de la page.
//
// Le groupe d'un avis est son `property_id_ref` BRUT, la colonne que le front
// interroge bien par bien (`provider_property_id`).
//
// ⚠ LE GLOBAL N'EST PAS LA SOMME DES BIENS AFFICHES, et ce n'est pas un
// defaut. `property_id_ref` est `text NOT NULL` SANS cle etrangere
// (migrations/2026-09-02-ota-reviews.sql:27) : un re-keying Beds24 -> Channex,
// un bien dont `provider_property_id` est repasse a NULL pendant une bascule,
// ou un bien supprime laissent des avis dont la reference ne designe plus aucun
// bien du compte. Ils comptent au global — ils comptaient deja dans l'appel
// global d'avant — et dans aucun groupe que l'ecran sache afficher.
// Le garde `property_id_ref == null` juste en dessous est une CEINTURE : la
// colonne est `not null`, zero ligne nulle en production au 20 octobre 2026.
//
// ⚠ ELLE REFUSE LES OPTIONS D'ATTRIBUTION, A VOIX HAUTE. `ratioProprete`, 170
// lignes plus haut, prend `prestataireId` / `menageEventIds` / `voies` et
// restreint aux avis attribuables a une prestataire. La fiche prestataire est
// le prochain consommateur annonce (spec-prestataires-menage.md §6) : ecrire
// `notesDuPerimetre(sb, { userId, periode, prestataireId })` a cote de
// `ratioProprete(sb, { userId, periode, prestataireId })` est le geste naturel,
// et il rendrait la moyenne de L'HOTE sur l'ecran d'une femme de menage, sans
// erreur ni test rouge. Un `throw` au premier appel coute une minute ; un
// chiffre faux sur cet ecran-la coute sa credibilite.
async function notesDuPerimetre (sb, opts = {}) {
  const { userId, periode = '30j', refs = null, maintenant = Date.now() } = opts
  for (const inconnue of ['prestataireId', 'menageEventIds', 'voies']) {
    if (opts[inconnue] != null) {
      throw new Error(`notesDuPerimetre: \`${inconnue}\` n'est pas honore. `
        + "Les notes ne savent pas s'attribuer a une prestataire (voir ratioProprete). "
        + 'Rendre la moyenne du compte ici serait rendre celle de l\'hote.')
    }
  }
  const vide = { global: { moyenne: null, notes: 0 }, par_bien: Object.create(null),
                 periode: periodeNormalisee(periode), depuis: borneDepuis(periode, maintenant) }
  if (!userId) return vide
  // Perimetre vide : zero, jamais « tous » — meme distinguo que `ratioProprete`.
  if (Array.isArray(refs) && refs.length === 0) return vide

  const depuis = vide.depuis
  const parRef = new Map()
  let somme = 0
  let n = 0
  let lues = 0
  let total = null
  let tronque = false
  for (let debut = 0; ; debut += PAGE_NOTES) {
    // ⚠ LE COMPTE EXACT EST DEMANDE AVEC LA PREMIERE PAGE, dans la MEME requete
    // (PostgREST le rend dans Content-Range). Il ne coute pas d'aller-retour, et
    // il est la seule facon de savoir si la lecture est COMPLETE : une page plus
    // courte que demandee veut dire « fin des donnees », mais aussi
    // « db-max-rows a rogne », et les deux sont indistinguables sans total.
    // Rogner en silence donnerait une moyenne sur une fraction, sans erreur.
    const q = requeteDesNotes(sb, { userId, depuis, refs,
      select: 'id, overall_score, property_id_ref', compter: debut === 0 })
    const { data, error, count } = await q.range(debut, debut + PAGE_NOTES - 1)
    if (error) {
      console.error('[stats-avis] notes echec:', error.message)
      return { ...vide, erreur: true }
    }
    if (debut === 0 && Number.isFinite(count)) total = count
    const page = data || []
    lues += page.length
    for (const l of page) {
      const v = Number(l.overall_score)
      if (!Number.isFinite(v)) continue
      somme += v; n++
      if (l.property_id_ref == null) continue
      const cle = String(l.property_id_ref)
      const c = parRef.get(cle) || { somme: 0, n: 0 }
      c.somme += v; c.n++
      parRef.set(cle, c)
    }
    if (page.length < PAGE_NOTES) break
    if (lues >= MAX_NOTES) { tronque = true; break }
  }
  // Une borne atteinte se DIT, jamais en silence.
  if (total != null && lues < total) tronque = true
  if (tronque) {
    console.error(`[stats-avis] notes INCOMPLETES : ${lues} ligne(s) lue(s)`
      + (total != null ? ` sur ${total}` : '') + ' — la moyenne porte sur une fraction')
  }

  // ⚠ `Object.create(null)`, PAS `{}`. Les cles viennent de
  // `property_id_ref`, une colonne TEXT alimentee par un provider : un
  // `__proto__` ecrirait le prototype au lieu de creer une cle, le bien
  // disparaitrait de la reponse sans erreur, et ni `Object.keys` ni
  // `JSON.stringify` ne le montreraient.
  const par_bien = Object.create(null)
  for (const [cle, c] of parRef) par_bien[cle] = { moyenne: arrondirNote(c.somme, c.n), notes: c.n }
  const out = { global: { moyenne: arrondirNote(somme, n), notes: n }, par_bien,
                periode: vide.periode, depuis }
  if (tronque) out.tronque = true
  return out
}

// ⚠ UNE SEULE LECTURE, DEUX VUES. `noteMoyenne` etait, au caractere pres, le
// `global` de `notesDuPerimetre` : meme requete, meme boucle, meme branche
// d'erreur, recopiees quatre lignes plus bas. Deux copies divergent — c'est la
// regle du depot — et la divergence aurait ete invisible : deux chiffres
// plausibles pour la meme chose, sur le meme ecran.
//
// ⚠ CONSEQUENCE A DIRE EN FACE : la parite entre les deux n'est plus une
// mesure, elle est STRUCTURELLE. Un test qui les compare l'une a l'autre ne
// prouve donc rien — si l'extraction avait perdu `.eq('is_hidden', false)`, les
// deux cotes auraient sur-compte a l'identique. Ce qui prouve quelque chose :
// les chiffres ecrits EN CLAIR dans tests/stats-avis.test.js, et
// `scripts/verifier-parite-notes.js`, qui compare au `noteMoyenne` d'AVANT le
// lot, extrait par `git archive`.
async function noteMoyenne (sb, opts = {}) {
  const r = await notesDuPerimetre(sb, opts)
  const out = { moyenne: r.global.moyenne, notes: r.global.notes }
  if (r.erreur) out.erreur = true
  if (r.tronque) out.tronque = true
  return out
}

module.exports = { ratioProprete, noteMoyenne, notesDuPerimetre, borneDepuis, periodeNormalisee, PERIODES }
