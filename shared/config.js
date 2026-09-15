// ─── Cible Supabase : resolue au chargement, par hostname ────────────────────
// Les deux projets Vercel servent la MEME branche et le MEME fichier : rien
// dans le code ne distingue prod de staging, seul le domaine qui le sert.
//
// ⚠ CONTRAINTE DE DEPLOIEMENT : le domaine du projet staging DOIT contenir
// "staging". C'est le seul signal disponible cote navigateur — vercel.json ne
// declare aucun build (buildCommand: ""), donc aucune variable d'environnement
// n'est injectable dans un fichier statique. Un domaine staging qui ne porte
// pas ce mot ferait ecrire le navigateur dans la base de PRODUCTION, en
// silence et sans rien casser d'apparent.
//
// Le defaut est la PROD, volontairement : les previews du projet de production
// et localhost gardent le comportement actuel. Aucune regression.
//
// La cle publishable n'est PAS un secret : elle part dans le HTML de chaque
// visiteur. C'est la RLS (28/28 actives) qui protege, jamais sa
// confidentialite. La service_role, elle, ne vit que cote serveur.

const CIBLES_SUPABASE = {
  prod: {
    supabaseUrl: 'https://cjmrizpdyhrcurmgyrhs.supabase.co',
    supabaseKey: 'sb_publishable_cCOixH5aKHWUq5OzNPX7qw_ub0RQ5rD'
  },
  staging: {
    supabaseUrl: 'https://ortyofzzdsthlhqmzsnq.supabase.co',
    supabaseKey: 'sb_publishable_zgxGBvd2yPd1fbYVJasJeA_vXSiCv-5'
  }
}

// Motifs ANCRES, jamais un simple « contient staging ». Les previews du projet
// de PRODUCTION portent le nom de branche dans leur hostname
// (hotesmart-git-<branche>-<equipe>.vercel.app) : une branche nommee
// staging-quelque-chose y produirait un hostname contenant "staging", donc un
// front sur la base staging pendant que les fonctions /api restent sur la
// prod. Etat mixte, silencieux, et illisible depuis l'ecran.
const HOTES_STAGING = [
  /^hotesmart-staging[-.]/,  // projet Vercel staging, ses previews comprises
  /^staging\./              // domaine propre eventuel : staging.hotesmart.fr
]

const HOTE = (typeof location !== 'undefined' ? location.hostname : '').toLowerCase()

export const CIBLE_SUPABASE =
  HOTES_STAGING.some(m => m.test(HOTE)) ? 'staging' : 'prod'

// ⚠ LE SILENCE EST LE VRAI DANGER. Un hostname qui PARLE de staging sans
// matcher les motifs ancres retombe sur la PROD — le navigateur d'un
// deploiement de recette ecrit alors dans la base de production, sans que rien
// ne le dise. On ne CHANGE PAS la cible pour autant (deviner serait pire),
// mais on le dit fort : le repli sur la prod reste le comportement sur, il
// cesse d'etre muet.
//
// ⚠ CE QUE CETTE GARDE N'ATTRAPE PAS, ET IL FAUT LE SAVOIR. Elle teste
// `includes('staging')` : elle ne voit donc QUE les hostnames ou le mot
// survit. Deux des trois formes dangereuses connues lui echappent, parce que
// le mot n'y est plus :
//   - un label DNS tronque par Vercel au-dela de 63 caracteres — et
//     `hotesmart-staging-git-<branche>-<equipe>` depasse des une branche un
//     peu longue : « hotesmart-stag-... » ne contient plus « staging » ;
//   - un domaine propre hors motifs (recette.hotesmart.fr).
// Contre ces deux-la, la seule defense reste le nom de domaine : il DOIT
// commencer par `hotesmart-staging` ou `staging.` (docs/STAGING.md §2).
// Reste attrape : le nom de projet suffixe (hotesmart-staging2), qui est le
// cas le plus probable puisqu'il survient tout seul si le nom est deja pris.
if (CIBLE_SUPABASE === 'prod' && HOTE.includes('staging')) {
  console.error(
    '[config] ATTENTION : hostname staging non reconnu, cible = PROD',
    '| hostname =', HOTE,
    '| motifs attendus = hotesmart-staging[-.] ou staging.'
  )
}

export const ENV = CIBLES_SUPABASE[CIBLE_SUPABASE]

// Trace la cible, jamais la cle : un ecran qui ment sur sa base est le pire
// des cas (REVIEW.md, passe 1 de la revue UI).
if (typeof console !== 'undefined') {
  console.info('[config] base Supabase =', CIBLE_SUPABASE)
}

const CONFIG = {
  appName: 'HôteSmart',
  version: '1.0.0',
  apps: [
    { id: 'agent-ai',     name: 'GuestFlow AI',          icon: '🤖', color: '#E1F5EE', active: true  },
    { id: 'menages',      name: 'Gestion ménages',        icon: '🧹', color: '#EAF3DE', active: true  },
    { id: 'livret',       name: "Livret d'accueil",       icon: '📖', color: '#FAECE7', active: false },
    { id: 'reporting',    name: 'Reporting revenus',      icon: '📊', color: '#E6F1FB', active: false },
    { id: 'lmnp',         name: 'Déclaration LMNP',       icon: '🧾', color: '#FAEEDA', active: false },
    { id: 'pilotage',     name: 'Pilotage & rentabilité', icon: '🎯', color: '#EEEDFE', active: false },
    // ⚠ L'ID EST `yield` — celui du chantier (`lib/yield/`, `/api/yield`,
    // `apps/yield/`). Le LIBELLE, lui, dit ce que l'app FAIT : regle gravee
    // (spec-moteur-reservation.md §3 ter), « jamais un nom de marque ».
    // ACTIVE au lot 4.2 : l'ecran de restitution est rendu et valide sur
    // pieces (La bulle, 12 septembre 2026). L'app est en LECTURE SEULE — la
    // saisie des exceptions vient au lot 4.3, l'application d'un prix au 4.6.
    { id: 'yield', name: 'Tarification dynamique', icon: '💰', color: '#FBF0FF', active: true },
    // Nom GRAVE (spec-moteur-reservation.md §3 ter) : un libelle qui dit ce que
    // ca fait, jamais un nom de marque. Ne pas rebaptiser.
    { id: 'reservation-directe', name: 'Réservation directe', icon: '🔗', color: '#E6F1FB', active: true }
  ]
}

export default CONFIG
