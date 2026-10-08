// lib/avis/redaction.js
//
// L'IA REDIGE LE TEXTE. ELLE NE JUGE RIEN.
//
// Les notes sont un calcul deterministe (lib/avis/notes-evaluation.js). Ici on
// ne produit que des PHRASES : un texte public dans la langue du voyageur, et
// une note privee facultative en francais.
//
// ⚠ CE QUI SORT DU MODELE N'EST PAS CRU SUR PAROLE. Trois garde-fous de la
// spec (§3) sont verifies APRES coup, sur le texte rendu :
//   1. la note privee n'est jamais recopiee dans le texte public ;
//   2. le prenom de la prestataire n'apparait jamais ;
//   3. l'IA ne contredit pas les boutons — un sejour ou un niveau NEGATIF est
//      coche ne peut pas produire « impeccable ».
//
// Un texte qui viole un garde-fou n'est PAS rafistole en silence : on reessaie
// une fois avec la consigne durcie, puis on rend `null` avec un motif nomme.
// L'hote ecrit alors lui-meme. Mieux vaut un champ vide qu'un avis qui ment.
//
// Spec docs/specs/spec-evaluation-voyageur.md §5.

const { grilleDe, estNegatif } = require('./notes-evaluation')

const MODELE = 'claude-haiku-4-5-20251001'
const MAX_PUBLIC = 600
const MAX_PRIVE  = 400

// ⚠ LE CLIENT PARTAGE, PAS UN NOUVEAU. Celui de lib/cron-shared.js enveloppe
// messages.create pour signaler une panne de FACTURATION Anthropic — vecu du
// 8 septembre 2026, ou le credit epuise avait arrete toute l'IA du produit en
// silence. Un client fabrique ici contournerait cette alarme, et chercherait
// la cle sous un nom qui n'existe pas dans ce depot (c'est CLAUDE_API_KEY).
//
// Le require est PARESSEUX : cron-shared ouvre un client Supabase des son
// chargement, donc exige les variables d'environnement. Les tests injectent
// leur propre client et ne doivent pas avoir a fournir une base.
function clientParDefaut () {
  return require('../cron-shared').anthropic
}

// ⚠ Les mots qui affirment que tout s'est bien passe. Interdits des qu'un
// niveau negatif est coche. La liste est volontairement courte : on cherche le
// mensonge franc, pas la nuance. Accents retires par `aplatir()`.
const ELOGES = [
  'impeccable', 'irreprochable', 'exemplaire', 'parfait', 'parfaite',
  'sans aucun probleme', 'rien a signaler', 'aucun souci',
  'flawless', 'impeccably', 'nothing to report', 'no issues', 'perfect',
]

// ⚠ ET CETTE LISTE NE COUVRE QUE DEUX LANGUES. Le texte, lui, est ecrit dans
// la langue du voyageur. Un « Alles war einwandfrei » sur un sejour ou la
// proprete est cochee « sale » passait les trois garde-fous et partait chez
// Airbnb. Constat de review. On ne peut pas dresser la liste des eloges de
// toutes les langues ; on peut refuser de garantir ce qu'on ne sait pas lire.
const LANGUES_COUVERTES = new Set(['fr', 'en'])
const langueCouverte = (l) => LANGUES_COUVERTES.has(String(l || '').slice(0, 2).toLowerCase())

const aplatir = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim()

// Une phrase de la note privee recopiee telle quelle dans le public. On
// compare sur des tranches assez longues pour qu'une coincidence soit
// improbable : « merci pour tout » ne doit pas declencher l'alarme.
// ⚠ UN PLANCHER DE 40 CARACTERES DESARMAIT LA GARDE. Constat de review : « A
// fume dans le salon. » fait 21 caracteres, se recopiait mot pour mot dans le
// texte public, et passait. Or ce sont justement les notes courtes qui sont les
// plus seches, et les plus dommageables pour le voyageur.
//
// On compare donc par SUITES DE MOTS, pas par longueur de chaine : cinq mots
// consecutifs identiques ne sont pas une coincidence, tandis que « merci pour
// tout » (trois mots) reste une formule partagee. Les mots vides ne comptent
// pas comme du contenu : une suite entierement faite de liaisons ne declenche
// rien.
const MOTS_RECOPIE = 5
const MOTS_VIDES = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'et', 'a', 'au', 'aux',
  'en', 'pour', 'dans', 'sur', 'avec', 'sans', 'il', 'elle', 'ils', 'elles',
  'the', 'a', 'an', 'of', 'and', 'to', 'in', 'on', 'for', 'with', 'was', 'is',
])
const motsDe = (t) => aplatir(t).replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter(Boolean)

function recopieLaNotePrivee (publicTexte, prive) {
  const mp = motsDe(prive)
  const pub = ' ' + motsDe(publicTexte).join(' ') + ' '
  // ⚠ LA LIMITE, DITE FRANCHEMENT : en dessous de cinq mots, on ne declenche
  // rien. « merci pour tout » se retrouve legitimement des deux cotes, et rien
  // ne le distingue mecaniquement d'une note privee de trois mots recopiee.
  // Le seuil descend de quarante caracteres a cinq mots — « A fume dans le
  // salon. » est desormais vu —, il ne disparait pas.
  if (mp.length < MOTS_RECOPIE) return false
  for (let i = 0; i + MOTS_RECOPIE <= mp.length; i++) {
    const suite = mp.slice(i, i + MOTS_RECOPIE)
    if (suite.every(m => MOTS_VIDES.has(m))) continue
    if (pub.includes(' ' + suite.join(' ') + ' ')) return true
  }
  return false
}

function citeLaPrestataire (texte, prenom) {
  const p = aplatir(prenom)
  // Un prenom de deux lettres ferait des faux positifs partout.
  if (p.length < 3) return false
  return new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(aplatir(texte))
}

// ─── Le vocabulaire (recette de Thierry du 7 octobre 2026, point H) ─────────
// Vecu, publie chez Airbnb : « Angela a été une excellente hôte », « Un hôte
// consciencieux… aux futurs propriétaires ». Le voyageur n'est JAMAIS « hôte »,
// et ceux qui liront l'avis sont des « futurs hôtes », jamais des
// « propriétaires ». Le genre du voyageur n'est connu nulle part (ni Airbnb ni
// Channex ne le donnent) : formulations NEUTRES, jamais deduites du prenom
// (decision de Thierry du 8 octobre 2026).
//
// ⚠ VERIFIE APRES COUP, comme les autres garde-fous : une consigne ne suffit
// pas, le modele l'a deja enfreinte. Francais et anglais seulement (les
// langues que l'on sait relire) ; ailleurs, la consigne seule.
//
// « hôte(s) » n'est admis que pour les LECTEURS de l'avis : precede de
// « futur(s) », « autre(s) », ou dans « tous les hôtes ».
const AVANT_HOTE_ADMIS = { fr: new Set(['futur', 'futurs', 'future', 'futures', 'autre', 'autres']), en: new Set(['future', 'other', 'fellow']) }
function appelleLeVoyageurHote (texte, langue) {
  const l = String(langue || '').slice(0, 2).toLowerCase()
  if (!AVANT_HOTE_ADMIS[l]) return false
  const mots = motsDe(texte)
  for (let i = 0; i < mots.length; i++) {
    if (!(l === 'fr' ? /^hotes?$/ : /^hosts?$/).test(mots[i])) continue
    const avant = mots[i - 1] || ''
    const avantAvant = mots[i - 2] || ''
    if (AVANT_HOTE_ADMIS[l].has(avant)) continue
    if (l === 'fr' && avant === 'les' && avantAvant === 'tous') continue
    if (l === 'en' && avant === 'all') continue
    return true
  }
  return false
}
function parleDeProprietaires (texte, langue) {
  const l = String(langue || '').slice(0, 2).toLowerCase()
  const t = aplatir(texte)
  if (l === 'fr') return /\bproprietaires?\b/.test(t)
  if (l === 'en') return /\b(owners?|landlords?)\b/.test(t)
  return false
}
function genreLeVoyageur (texte, langue) {
  const l = String(langue || '').slice(0, 2).toLowerCase()
  const t = aplatir(texte)
  if (l === 'fr') return /\b(voyageuse|voyageuses|il|elle|ils|elles)\b/.test(t) || /\b(le|la) recommande\b/.test(t)
  if (l === 'en') return /\b(he|she|him|his|her|hers|himself|herself)\b/.test(t)
  return false
}
// Les mots-cles de l'hote : au moins un, tel quel (point I). Verifie seulement
// quand le texte est en francais — la langue dans laquelle l'hote les saisit.
function sansMotCle (texte, langue, mots) {
  const l = String(langue || '').slice(0, 2).toLowerCase()
  const liste = (mots || []).map(m => aplatir(m)).filter(Boolean)
  if (l !== 'fr' || !liste.length) return false
  const t = aplatir(texte)
  return !liste.some(m => t.includes(m))
}

// ⚠ DES TEXTES TROP UNIFORMES (point I) : sept textes publies sur neuf
// commencaient par « X a été un voyageur exemplaire ! Communication fluide… ».
// L'ouverture est tiree au sort parmi ces formes, et la plus usee est interdite.
const OUVERTURES = [
  'Commence par le séjour lui-même (par exemple « Séjour sans fausse note avec … »).',
  'Commence par le plaisir de l’accueil (par exemple « Un plaisir d’accueillir … »).',
  'Commence par le point le plus marquant parmi ceux cochés.',
  'Commence par une recommandation directe aux futurs hôtes.',
  'Commence par le prénom suivi d’une action concrète (par exemple « … a pris soin du logement »).',
]

function contreditLesBoutons (texte, negatif) {
  if (!negatif) return false
  const t = aplatir(texte)
  return ELOGES.some(mot => t.includes(mot))
}

// ─── Le prompt ──────────────────────────────────────────────────────────────
// ⚠ ON DONNE LES LIBELLES COCHES, PAS LES NOTES. Le modele n'a pas a savoir
// qu'un niveau vaut 3/5 : il redigerait autour du chiffre. Il decrit ce qui
// s'est passe, le calcul fait le reste.
// Ce que dit la consigne durcie, selon ce qui a ete refuse.
const RAISONS = {
  ia_contredit_les_boutons: 'il disait que tout s’était bien passé alors qu’un point négatif est coché',
  ia_cite_la_prestataire: 'il citait une autre personne que le voyageur',
  ia_recopie_le_prive: 'il recopiait la note privée',
  ia_appelle_hote: 'il appelait le voyageur « hôte » : le voyageur n’est jamais un hôte',
  ia_proprietaire: 'il parlait de « propriétaires » : on écrit « futurs hôtes »',
  ia_genre: 'il donnait un genre au voyageur (voyageuse, il, elle, le/la recommande) : écris de façon neutre',
  ia_sans_mots_cles: 'il n’employait aucun des mots que l’hôte aime employer',
}

function construirePrompt ({ coches, remarque, prenom, langue, config, negatif, durcir, ouverture = OUVERTURES[0] }) {
  const lignes = coches.map(c => `- ${c.critere} : ${c.niveau}`).join('\n')
  const mots = (config.keywords || []).filter(Boolean)
  const ton = config.tone === 'sobre' ? 'sobre et factuel' : 'chaleureux mais sans exces'

  return [
    "Tu rediges l'avis d'un hote sur un VOYAGEUR qui vient de quitter son logement.",
    "Cet avis sera lu par les futurs hotes du voyageur. Il parle du voyageur, jamais du logement.",
    '',
    'Ce que l\'hote a coche :',
    lignes || '- (rien de particulier)',
    remarque ? `\nRemarque libre de l'hote : ${remarque}` : '',
    '',
    `Prenom du voyageur : ${prenom || 'inconnu'}`,
    `Langue du texte public : ${langue || 'en'}. Ecris DANS CETTE LANGUE, meme si cette consigne est en francais.`,
    `Ton : ${ton}.`,
    mots.length ? `Mots et expressions que l'hote aime employer : ${mots.join(', ')}. Emploie AU MOINS UN d'entre eux, tel quel, la ou il vient naturellement.` : '',
    config.signature ? `Signature a placer en fin de texte public : ${config.signature}` : '',
    '',
    'REGLES ABSOLUES :',
    "- Ne contredis JAMAIS ce qui est coche. Si un point est negatif, le texte public ne dit pas que tout s'est bien passe.",
    "- Ne parle QUE des points coches ci-dessus. N'affirme rien qui n'y figure pas : pas de vaisselle, de poubelles, d'horaires, de communication, de bruit… s'ils ne sont pas coches.",
    '- Ne cite aucun nom de personne autre que le prenom du voyageur.',
    '- Ne recopie pas la remarque libre dans le texte public : elle est privee.',
    "- Le voyageur n'est JAMAIS un « hote » (ni host). Le mot « hotes » ne designe que les futurs hotes qui liront l'avis. N'emploie jamais « proprietaire(s) » (ni owner, ni landlord).",
    "- Tu ne connais pas le genre du voyageur : ecris de facon NEUTRE. Jamais « voyageuse », jamais il/elle, jamais « le/la recommande », aucun adjectif accorde au voyageur (« exemplaire » oui, « parfait/parfaite » non). En anglais : ni he/she/him/her, utilise le prenom. Tournures possibles : « un plaisir d'accueillir [prenom] », « sejour sans fausse note avec [prenom] », « [prenom] a pris soin du logement », « nous recommandons [prenom] ».",
    `- Texte public : 2 a 3 phrases courtes, ${MAX_PUBLIC} caracteres maximum.`,
    `- Ne commence PAS par « ${prenom || 'Le voyageur'} a été » ni par « … est un(e) voyageur(se) ». ${ouverture}`,
    negatif
      ? "- Ce sejour comporte au moins un point negatif : dis-le, sobrement et sans agressivite. Pas de superlatif elogieux."
      : '',
    durcir
      ? `\n⚠ TON PRECEDENT TEXTE A ETE REFUSE : ${RAISONS[durcir] || 'il violait une de ces regles'}. Recommence en respectant les regles a la lettre.`
      : '',
    '',
    'Reponds en JSON strict, sans rien autour :',
    '{"public": "le texte public", "prive": "note privee en francais, ou une chaine vide"}',
  ].filter(l => l !== '').join('\n')
}

function lireReponse (brut) {
  if (!brut) return null
  // Le modele encadre parfois son JSON de ```json … ```.
  const sansCloture = String(brut).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const debut = sansCloture.indexOf('{')
  const fin = sansCloture.lastIndexOf('}')
  if (debut < 0 || fin <= debut) return null
  let objet
  try { objet = JSON.parse(sansCloture.slice(debut, fin + 1)) } catch { return null }
  const pub = String(objet.public || '').trim()
  if (!pub) return null
  const prive = String(objet.prive || '').trim()
  return {
    public_text: pub.slice(0, MAX_PUBLIC),
    private_note: prive ? prive.slice(0, MAX_PRIVE) : null,
  }
}

// ─── Le point d'entree ──────────────────────────────────────────────────────
// Rend { public_text, private_note, negatif, motif }.
// `motif` est nul quand tout va bien, et nomme l'echec sinon — auquel cas
// public_text est nul et l'hote redige lui-meme. Jamais d'exception pour un
// refus de garde-fou : c'est une reponse, pas une panne.
async function redigerAvis ({
  reponses = {},
  remarque = null,
  prenom = null,
  langue = 'en',
  prestataire = null,
  config = {},
  grille = null,
  duBien = [],
  duCompte = [],
} = {}, deps = {}) {
  const client = deps.anthropic || clientParDefaut()
  const g = grille || grilleDe({ duBien, duCompte })

  // ⚠ Le drapeau negatif vient du CALCUL, jamais du modele.
  //
  // Et si le calcul ne peut PAS trancher — une reponse manque, une reponse ne
  // correspond a aucun niveau — on ne devine pas. On ne redige pas non plus :
  // un formulaire incomplet ne doit pas consommer un appel au modele, et un
  // « negatif par prudence » ferait un texte severe sur un sejour qui ne l'est
  // peut-etre pas. Le motif est nomme, l'ecran saura quoi dire.
  let negatif
  try {
    negatif = estNegatif(reponses, g)
  } catch (err) {
    return { public_text: null, private_note: null, negatif: null, motif: 'reponses_hors_grille', detail: err.message }
  }

  // Les libelles coches, dans l'ordre de la grille.
  const coches = []
  for (const c of g.criteres) {
    const choisi = reponses[c.cle]
    if (choisi === undefined || choisi === null) continue
    const niv = (c.niveaux || []).find(n => n.cle === choisi)
    if (niv) coches.push({ critere: c.libelle || c.cle, niveau: niv.libelle || niv.cle })
  }

  // ⚠ ON NE PROMET PAS CE QU'ON NE SAIT PAS LIRE. Sur un sejour negatif dont le
  // texte doit etre ecrit dans une langue que la liste d'eloges ne couvre pas,
  // le garde-fou « l'IA ne contredit pas les boutons » serait DECORATIF. On
  // refuse plutot que de laisser croire qu'il a joue : l'hote redige lui-meme.
  if (negatif && !langueCouverte(langue)) {
    return {
      public_text: null, private_note: null, negatif,
      motif: 'langue_non_verifiable',
      detail: `un avis negatif en « ${langue} » ne peut pas etre relu automatiquement : la verification ne couvre que ${[...LANGUES_COUVERTES].join(' et ')}`,
    }
  }

  let dernier = null
  // L'ouverture, tiree au sort (injectable pour les tests).
  const hasard = typeof deps.hasard === 'function' ? deps.hasard : Math.random
  const ouverture = OUVERTURES[Math.min(OUVERTURES.length - 1, Math.floor(hasard() * OUVERTURES.length))]
  const motsCles = (config.keywords || []).filter(Boolean)
  for (const essai of [0, 1]) {
    const durcir = essai === 0 ? false : (dernier || true)
    let reponse
    try {
      reponse = await client.messages.create({
        model: MODELE,
        max_tokens: 700,
        messages: [{ role: 'user', content: construirePrompt({ coches, remarque, prenom, langue, config, negatif, durcir, ouverture }) }],
      })
    } catch (err) {
      // Une panne du fournisseur n'est pas un refus : elle remonte nommee.
      return { public_text: null, private_note: null, negatif, motif: 'ia_indisponible', detail: err.message }
    }

    const texte = lireReponse(reponse?.content?.[0]?.text)
    // ⚠ DEUX ECHECS DIFFERENTS, DEUX MOTIFS. Un JSON illisible et un garde-fou
    // viole tombaient dans le meme `continue`, et l'ecran affirmait « garde-fou
    // viole » sur deux reponses de charabia. Constat de review.
    if (!texte) { dernier = 'ia_illisible'; continue }

    if (contreditLesBoutons(texte.public_text, negatif)) { dernier = 'ia_contredit_les_boutons'; continue }
    if (prestataire && citeLaPrestataire(texte.public_text, prestataire)) { dernier = 'ia_cite_la_prestataire'; continue }
    if (texte.private_note && recopieLaNotePrivee(texte.public_text, texte.private_note)) { dernier = 'ia_recopie_le_prive'; continue }
    if (remarque && recopieLaNotePrivee(texte.public_text, remarque)) { dernier = 'ia_recopie_le_prive'; continue }
    if (appelleLeVoyageurHote(texte.public_text, langue)) { dernier = 'ia_appelle_hote'; continue }
    if (parleDeProprietaires(texte.public_text, langue)) { dernier = 'ia_proprietaire'; continue }
    if (genreLeVoyageur(texte.public_text, langue)) { dernier = 'ia_genre'; continue }
    // Les mots-cles : une seconde chance, jamais un refus — un texte juste sans
    // le mot prefere de l'hote vaut mieux qu'un champ vide.
    if (essai === 0 && sansMotCle(texte.public_text, langue, motsCles)) { dernier = 'ia_sans_mots_cles'; continue }

    return { ...texte, negatif, motif: null }
  }

  return {
    public_text: null,
    private_note: null,
    negatif,
    motif: dernier || 'ia_hors_gardes',
    detail: 'deux tentatives, aucune ne tient : l hote redige lui-meme',
  }
}

module.exports = {
  redigerAvis,
  // Exportes pour les tests : ce sont les garde-fous, ils doivent etre
  // verifiables un par un.
  construirePrompt,
  lireReponse,
  appelleLeVoyageurHote,
  parleDeProprietaires,
  genreLeVoyageur,
  sansMotCle,
  OUVERTURES,
  contreditLesBoutons,
  citeLaPrestataire,
  recopieLaNotePrivee,
  MAX_PUBLIC,
  MODELE,
}
