// api/ecran/avis-recents.js — LA SUITE du bloc « Derniers avis » de l'accueil.
//
// ⚠ POURQUOI UN ENDPOINT A PART, ET PAS UN PARAMETRE DE L'APPEL D'ECRAN.
// `api/ecran/aujourdhui.js` part a l'OUVERTURE, et le budget de cet ecran est
// de DEUX appels au chargement (spec-aujourdhui-v5 §5 bis) — un test les
// compte. Les trois PREMIERS avis viennent donc de cet appel-la, comme avant ;
// celui-ci ne sert que les suivants, au DEFILEMENT, et un hote qui ne defile
// pas ne le paie jamais.
//
// ⚠ ET IL S'ARRETE AUX 30 JOURS, comme le bloc l'annonce. Decision de Thierry
// du 29 octobre 2026, option 3 : « 30 jours, puis un lien vers /avis ». Mesure
// en production le meme jour : 16 avis avec texte sur 30 jours (5 pages de 3)
// contre 645 au total. Paginer jusqu'au premier avis aurait fait de l'accueil
// un second /avis — 215 pages — et rendu FAUX le compte de son propre en-tete
// (« N avis sur 30 jours »).
//
// ⚠ LECTURE SEULE, ET RIEN D'AUTRE (spec §3) : ce bloc ne porte aucune action,
// ni repondre ni evaluer. Le geste vit sur /avis.

const { createClient } = require('@supabase/supabase-js')
const { contexteDEcran, UUID_RE } = require('../../lib/require-permission')
const { refsDuPerimetre, peutLire } = require('../../lib/permissions')
const { derniersAvis } = require('../../lib/stats-avis')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// La taille d'une page, et c'est celle de l'affichage : trois cartes, comme la
// grille de l'ordinateur (`repeat(3, …)`). Dure, et non pilotee par le client :
// un `?par=500` ferait de cet endpoint une extraction.
const PAR_PAGE = 3

module.exports = async (req, res) => {
  const t0 = Date.now()
  // L'en-tete prive avant tout, y compris avant un refus de methode (dette 90).
  const garde = await contexteDEcran(req, res)
  if (!garde.ok) return
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Méthode non autorisée' })
  }
  const { accountUserId: compte, contexte } = garde

  // ⚠ GARDE SERVEUR DU DROIT, AVANT TOUTE LECTURE. L'accueil retire le bloc du
  // DOM sans le droit `avis` — c'est un confort d'interface ; celui-ci protege.
  if (!peutLire(contexte, 'avis')) {
    return res.status(403).json({ error: 'Droit « avis » requis' })
  }

  // ⚠ LE PERIMETRE A TROIS ETATS, et une erreur d'une ligne est une fuite
  // inter-comptes : `null` = aucune borne (titulaire) ; `[]` = ce membre ne
  // voit RIEN ; une liste = ses biens. Un `if (refs)` laisserait le perimetre
  // vide SANS filtre, donc tout le compte visible.
  const refs = refsDuPerimetre(contexte)
  const perimetreVide = Array.isArray(refs) && refs.length === 0
  // ⚠ CE REFUS EST DOUBLE PAR `lib/stats-avis.js`, qui porte la MEME garde
  // (`if (Array.isArray(refs) && refs.length === 0) return []`) — et AUCUN
  // test ne les distingue : mesure par mutation, retirer cette ligne laisse la
  // suite verte, parce que la librairie rend `[]` sans toucher a la base. On la
  // garde pour deux raisons nommees : elle economise l'aller-retour, et elle
  // dit l'intention a l'endroit ou le lecteur cherche le perimetre. Ce qu'elle
  // n'est PAS : la seule barriere.
  if (perimetreVide) return rendre(res, t0, 0, { avis: [], fin: true })

  // Le curseur : la derniere carte deja affichee. Les deux moities ou rien —
  // un curseur a demi lu paginerait sur une seule cle et sauterait des lignes.
  const q = req.query || {}
  const depuis = String(q.depuis || '').trim()
  const apresId = String(q.apres_id || '').trim()
  const veutUneSuite = depuis !== '' || apresId !== ''
  if (veutUneSuite && (depuis === '' || apresId === '')) {
    return res.status(400).json({ error: 'Curseur incomplet' })
  }
  // ⚠ LA DATE EST VALIDEE SUR SA **FORME**, PAS SUR `Date.parse`. Mesure de la
  // review du 29 octobre 2026 : `Date.parse('Oct 26 2026 (",or(id.gte.0)")')`
  // rend une date FINIE — le parseur de secours de V8 traite les parentheses
  // comme un commentaire et tolere les caracteres epars. Et c'est la chaine
  // BRUTE du client qui entrait ensuite dans le filtre PostgREST. Ce qui
  // sauvait, c'etait la malformation du filtre obtenu (400), pas cette garde.
  // On exige donc une forme ISO 8601, et on passe au filtre la date
  // NORMALISEE — jamais la chaine recue.
  const ISO_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?$/
  let pivot = null
  if (veutUneSuite) {
    if (!ISO_RE.test(depuis) || !Number.isFinite(Date.parse(depuis))) {
      return res.status(400).json({ error: 'Curseur invalide' })
    }
    pivot = new Date(depuis).toISOString()
  }
  // ⚠ ET L'IDENTIFIANT EST UN UUID. `ota_reviews.id` est de type `uuid`
  // (migration du 2 septembre 2026) : une chaine libre y part en base et rend
  // une erreur Postgres 22P02, que l'endpoint traduit en « indisponible » —
  // donc une suite qui s'arrete, sur une entree du client. C'est le piege que
  // `api/ecran/aujourdhui.js` documente sur vingt-cinq lignes (« LE PIEGE UUID,
  // POUR LA TROISIEME FOIS »), et `UUID_RE` etait importe ici sans etre appele.
  if (veutUneSuite && !UUID_RE.test(apresId)) {
    return res.status(400).json({ error: 'Curseur invalide' })
  }

  // ⚠ UNE SEULE REQUETE, ET ELLE DEMANDE UNE LIGNE DE PLUS QUE LA PAGE. C'est
  // cette ligne-la qui dit « il y en a encore », au lieu de le deviner en
  // comparant le compte rendu a la taille demandee — qui confond « page
  // pleine » et « derniere page exactement pleine », et ferait afficher un
  // chargement de plus, vide, a chaque fois que le total est un multiple de 3.
  const out = await derniersAvis(supabase, {
    userId: compte,
    periode: '30j',
    limite: PAR_PAGE + 1,
    refs: refs === null ? null : refs.map(String),
    // ⚠ LE NOM DU VOYAGEUR SUIT `reservations`, PAS `avis` : le CONTENU de
    // l'avis suit `avis`, ce qu'il dit du SEJOUR suit `reservations`. Meme
    // partage que l'appel d'ecran et que `api/avis.js`.
    avecNom: peutLire(contexte, 'reservations'),
    // ⚠ PAS D'`echelle` ICI, ET C'EST VOLONTAIRE : l'appel d'ecran ne lui en
    // passe pas non plus. `noteSurCinqDe` retombe alors sur `ECHELLE_PAR_CANAL`
    // et rend `null` pour une source inconnue (dette 76) — « je ne sais pas »,
    // que la carte affiche sans note plutot que de supposer /10.
    // ⚠ MA PREMIERE VERSION IMPORTAIT DE `lib/avis/echelle.js` UNE FONCTION
    // QUI N'EXISTE PAS. `node -c` l'a laissee passer — il verifie la syntaxe,
    // jamais la resolution —, et le defaut n'aurait sonne qu'au premier
    // defilement d'un hote. C'est le piege que l'en-tete de
    // `revenus-annee.js` nomme deja ; la preuve se fait en CHARGEANT le
    // module, pas en le compilant.
    // ⚠ ET LA PREMIERE VERSION DE CE COMMENTAIRE CITAIT LES NOMS REELS DES
    // EXPORTS DU MODULE : `tests/avis-echelle.test.js` decouvre ses lecteurs
    // par `grep` sur ces noms-la, donc ce fichier entrait dans sa liste et le
    // garde-fou exigeait de lui qu'il transmette `ota` — qu'il ne lit jamais.
    // Un garde-fou cle sur du TEXTE compte une mention en commentaire ; on ne
    // le contourne pas, on arrete de se nommer dans sa liste.
    // La date NORMALISEE, jamais la chaine recue.
    apres: veutUneSuite ? { recu_le: pivot, id: apresId } : null,
    // ⚠ LE COMPTE BRUT, ET C'EST LUI QUI DIT « IL Y EN A ENCORE ». Le filtre de
    // texte de la lib s'applique APRES la `limit` : deduire la fin du nombre de
    // lignes RENDUES faisait conclure a la fin des qu'un seul avis etait perdu
    // au filtre (un texte reduit a des espaces). Mesure de la review du
    // 29 octobre : 4 lignes dont une vide rendaient « fin », et la suite
    // s'arretait en plein milieu des 30 jours.
    avecBrut: true
  })
  if (out && out.erreur) {
    return res.status(200).json({ avis: null, fin: true, indisponible: true })
  }
  const lus = (out && Array.isArray(out.avis)) ? out.avis : []
  const brut = (out && Number.isFinite(out.brut)) ? out.brut : lus.length
  return rendre(res, t0, 1, {
    avis: lus.slice(0, PAR_PAGE),
    fin: brut <= PAR_PAGE
  })
}

function rendre (res, t0, requetes, charge) {
  res.setHeader('Server-Timing',
    `total;dur=${Date.now() - t0};desc="${requetes} req (ordre de grandeur)"`)
  return res.status(200).json(charge)
}
