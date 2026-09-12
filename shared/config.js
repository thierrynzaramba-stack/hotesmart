export const ENV = {
  supabaseUrl: 'https://cjmrizpdyhrcurmgyrhs.supabase.co',
  supabaseKey: 'sb_publishable_cCOixH5aKHWUq5OzNPX7qw_ub0RQ5rD'
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
    // `active: false` jusqu'au lot 4.2 : au lot 4.1 l'app n'a rien a montrer
    // a un hote, et une entree de menu qui ouvre une page vide se lit comme
    // une panne.
    { id: 'yield', name: 'Tarification dynamique', icon: '💰', color: '#FBF0FF', active: false },
    // Nom GRAVE (spec-moteur-reservation.md §3 ter) : un libelle qui dit ce que
    // ca fait, jamais un nom de marque. Ne pas rebaptiser.
    { id: 'reservation-directe', name: 'Réservation directe', icon: '🔗', color: '#E6F1FB', active: true }
  ]
}

export default CONFIG
