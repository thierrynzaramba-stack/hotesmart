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

export const CIBLE_SUPABASE =
  (typeof location !== 'undefined' ? location.hostname : '')
    .toLowerCase()
    .includes('staging')
    ? 'staging'
    : 'prod'

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
