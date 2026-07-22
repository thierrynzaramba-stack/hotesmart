// lib/rate-sync.js
// POINT DE VERITE UNIQUE de la regle : "HoteSmart peut-il pousser des TARIFS vers le canal ?"
//
// Un bien ne pousse ses tarifs que s'il est en mode 'managed' (l'hote a explicitement
// choisi "HoteSmart gere mes prix"). Le defaut 'keep' est protecteur : aucun tarif ne
// part, l'hote garde la main sur ses prix cote plateforme.
//
// REGLE : tout chemin qui ecrit de l'ARI TARIFAIRE vers le canal (rate/rates, POST
// /restrictions, PUT /rate_plans, remap de rate_plan, runFullSync) DOIT passer par
// canPushRates() avant d'ecrire. En cas de refus, renvoyer RATE_PUSH_BLOCKED (jamais
// un 500 muet) pour que le front distingue "refuse car mode keep" d'une vraie panne.
//
// HORS REGLE : la DISPONIBILITE (POST /availability) n'est JAMAIS soumise a canPushRates.
// Elle se synchronise toujours (anti-surbooking = non negociable), quel que soit le mode.

// Un bien peut-il pousser ses tarifs ? (source unique — ne pas dupliquer la comparaison)
function canPushRates(property) {
  return !!property && property.rate_sync_mode === 'managed'
}

// Reponse standard de refus, identique sur tous les chemins gates (meme contrat que la
// Garde 0 de /api/calendar.js). Les endpoints l'etalent : { ...RATE_PUSH_BLOCKED }.
const RATE_PUSH_BLOCKED = {
  reason: 'mode_keep',
  message: 'Publication refusee : ce bien est en mode "Je garde mes prix". Activez "HoteSmart gere mes prix" pour publier vos tarifs vers les plateformes.'
}

module.exports = { canPushRates, RATE_PUSH_BLOCKED }
