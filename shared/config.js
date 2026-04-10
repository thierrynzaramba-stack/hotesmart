export const ENV = {
  supabaseUrl: 'https://cjmrizpdyhrcurmgyrhs.supabase.co',
  supabaseKey: 'sb_publishable_cCOixH5aKHWUq5OzNPX7qw_ub0RQ5rD'
}

const CONFIG = {
  appName: 'HôteSmart',
  version: '1.0.0',
  apps: [
    { id: 'agent-ai',       name: 'Agent AI voyageurs',    icon: '🤖', color: '#E1F5EE' },
    { id: 'messages-auto',  name: 'Messages automatiques', icon: '📅', color: '#E6F1FB' },
    { id: 'lmnp',           name: 'Déclaration LMNP',      icon: '🧾', color: '#FAEEDA' },
    { id: 'pilotage',       name: 'Pilotage & rentabilité', icon: '🎯', color: '#EEEDFE' },
    { id: 'livret',         name: "Livret d'accueil",      icon: '📖', color: '#FAECE7' },
    { id: 'menages',        name: 'Gestion ménages',       icon: '🧹', color: '#EAF3DE' },
    { id: 'reporting',      name: 'Reporting revenus',     icon: '📊', color: '#E6F1FB' },
    { id: 'sms', name: 'SMS', icon: '💬', color: '#E1F5EE' },
    { id: 'tarification',   name: 'Tarification dynamique',icon: '💰', color: '#FBF0FF' }
  ]
}

export default CONFIG