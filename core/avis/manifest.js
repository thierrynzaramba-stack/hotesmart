// core/avis/manifest.js
// DOC : docs/kb/protocole-coeur.md (modif = MEME COMMIT)
//
// Le manifeste du domaine AVIS : ce que le coeur offre aux apps, par le bus
// (shared/hs-bus.js). Une app ne connait que ces noms d'actions ; le chemin
// des modules est une affaire du coeur.
//
// Lot 1 (protocole) : les quatre actions sont DECLAREES et toutes « a venir ».
// Le bus les rend « indisponible » jusqu'a ce que leur module existe (lots 3
// et 4) : une app peut deja ecrire son bouton, il restera masque.
export default {
  domaine: 'avis',
  version: 1,
  actions: {
    // La fenetre d'evaluation du voyageur, pour l'hote (droit avis: write).
    'avis.evaluer': {
      type: 'fenetre', droit: { domaine: 'avis', niveau: 'write' },
      module: '/core/avis/fenetre-evaluation.js', etat: 'a_venir',
      params: ['booking_uid'],
    },
    // L'etat de l'evaluation d'un sejour (droit avis: read).
    'avis.statut': {
      type: 'requete', droit: { domaine: 'avis', niveau: 'read' },
      module: '/core/avis/statut.js', etat: 'a_venir',
      params: ['booking_uid'],
    },
    // L'ecran de questions de la prestataire, identite par jeton (PWA).
    'avis.questions_prestataire': {
      type: 'fenetre', identite: 'jeton',
      module: '/core/avis/questions-prestataire.js', etat: 'a_venir',
      params: ['menage_event_id'],
    },
    // Les reglages d'une prestataire (perimetre, pouvoir), lus et ecrits par
    // l'app menage (droit avis: write).
    'avis.reglages_prestataire': {
      type: 'requete', droit: { domaine: 'avis', niveau: 'write' },
      module: '/core/avis/reglages-prestataire.js', etat: 'a_venir',
      params: ['profile_id'],
    },
  },
  evenements: {
    // Emis par le coeur quand une evaluation est publiee chez l'OTA.
    'avis.evaluation_publiee': { detail: ['booking_uid', 'published_at'] },
  },
}
