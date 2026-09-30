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

const aplatir = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim()

// Une phrase de la note privee recopiee telle quelle dans le public. On
// compare sur des tranches assez longues pour qu'une coincidence soit
// improbable : « merci pour tout » ne doit pas declencher l'alarme.
const MIN_RECOPIE = 40
function recopieLaNotePrivee (publicTexte, prive) {
  const p = aplatir(prive)
  if (p.length < MIN_RECOPIE) return false
  const pub = aplatir(publicTexte)
  for (const morceau of p.split(/[.!?;]+/)) {
    const m = morceau.trim()
    if (m.length >= MIN_RECOPIE && pub.includes(m)) return true
  }
  return false
}

function citeLaPrestataire (texte, prenom) {
  const p = aplatir(prenom)
  // Un prenom de deux lettres ferait des faux positifs partout.
  if (p.length < 3) return false
  return new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(aplatir(texte))
}

function contreditLesBoutons (texte, negatif) {
  if (!negatif) return false
  const t = aplatir(texte)
  return ELOGES.some(mot => t.includes(mot))
}

// ─── Le prompt ──────────────────────────────────────────────────────────────
// ⚠ ON DONNE LES LIBELLES COCHES, PAS LES NOTES. Le modele n'a pas a savoir
// qu'un niveau vaut 3/5 : il redigerait autour du chiffre. Il decrit ce qui
// s'est passe, le calcul fait le reste.
function construirePrompt ({ coches, remarque, prenom, langue, config, negatif, durcir }) {
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
    mots.length ? `Vocabulaire que l'hote aime employer (facultatif, ne force rien) : ${mots.join(', ')}.` : '',
    config.signature ? `Signature a placer en fin de texte public : ${config.signature}` : '',
    '',
    'REGLES ABSOLUES :',
    "- Ne contredis JAMAIS ce qui est coche. Si un point est negatif, le texte public ne dit pas que tout s'est bien passe.",
    '- Ne cite aucun nom de personne autre que le prenom du voyageur.',
    '- Ne recopie pas la remarque libre dans le texte public : elle est privee.',
    `- Texte public : ${MAX_PUBLIC} caracteres maximum, quelques phrases.`,
    negatif
      ? "- Ce sejour comporte au moins un point negatif : dis-le, sobrement et sans agressivite. Pas de superlatif elogieux."
      : '',
    durcir
      ? "\n⚠ TON PRECEDENT TEXTE A ETE REFUSE : il violait une de ces regles. Recommence en les respectant a la lettre."
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

  for (const durcir of [false, true]) {
    let reponse
    try {
      reponse = await client.messages.create({
        model: MODELE,
        max_tokens: 700,
        messages: [{ role: 'user', content: construirePrompt({ coches, remarque, prenom, langue, config, negatif, durcir }) }],
      })
    } catch (err) {
      // Une panne du fournisseur n'est pas un refus : elle remonte nommee.
      return { public_text: null, private_note: null, negatif, motif: 'ia_indisponible', detail: err.message }
    }

    const texte = lireReponse(reponse?.content?.[0]?.text)
    if (!texte) continue

    if (contreditLesBoutons(texte.public_text, negatif)) continue
    if (prestataire && citeLaPrestataire(texte.public_text, prestataire)) continue
    if (texte.private_note && recopieLaNotePrivee(texte.public_text, texte.private_note)) continue
    if (remarque && recopieLaNotePrivee(texte.public_text, remarque)) continue

    return { ...texte, negatif, motif: null }
  }

  return {
    public_text: null,
    private_note: null,
    negatif,
    motif: 'ia_hors_gardes',
    detail: 'le texte propose violait un garde-fou apres une seconde tentative',
  }
}

module.exports = {
  redigerAvis,
  // Exportes pour les tests : ce sont les garde-fous, ils doivent etre
  // verifiables un par un.
  construirePrompt,
  lireReponse,
  contreditLesBoutons,
  citeLaPrestataire,
  recopieLaNotePrivee,
  MAX_PUBLIC,
  MODELE,
}
