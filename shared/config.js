export const ENV = {
  supabaseUrl: 'https://cjmrizpdyhrcurmgyrhs.supabase.co',
  supabaseKey: 'sb_publishable_cCOixH5aKHWUq5OzNPX7qw_ub0RQ5rD'
}

const CONFIG = {
  appName: 'HôteSmart',
  version: '1.0.0',
  apps: [
    { id: 'agent-ai', name: 'GuestFlow AI',      icon: '🤖', color: '#E1F5EE', active: true  },
    { id: 'menages',  name: 'Gestion ménages',   icon: '🧹', color: '#EAF3DE', active: true  },
    { id: 'serrures', name: 'Serrures',           icon: '🔐', color: '#EEEDFE', active: true  },
    { id: 'livret',   name: "Livret d'accueil",  icon: '📖', color: '#FAECE7', active: false },
    { id: 'reporting',name: 'Reporting revenus',  icon: '📊', color: '#E6F1FB', active: false },
    { id: 'lmnp',     name: 'Déclaration LMNP',  icon: '🧾', color: '#FAEEDA', active: false },
    { id: 'pilotage', name: 'Pilotage & rentabilité', icon: '🎯', color: '#EEEDFE', active: false },
    { id: 'tarification', name: 'Tarification dynamique', icon: '💰', color: '#FBF0FF', active: false }
  ]
}

export default CONFIG
