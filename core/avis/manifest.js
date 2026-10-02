// core/avis/manifest.js
// DOC : docs/kb/protocole-coeur.md (modif = MEME COMMIT)
//
// Le manifeste du domaine AVIS : ce que le coeur offre aux apps, par le bus
// (shared/hs-bus.js). Une app ne connait que ces noms d'actions ; le chemin
// des modules est une affaire du coeur.
//
// Lot 1 (protocole) : les quatre actions ont ete DECLAREES, toutes « a venir ».
// Lot 4 (30 septembre 2026) : `avis.evaluer` et `avis.statut` sont LIVREES, leur
// « a venir » est leve.
// Lot 5 (2 octobre 2026) : `avis.reglages_prestataire` (fiche prestataire) et
// `avis.questions_prestataire` (PWA, apres « Menage fait ») sont LIVREES.
//
// ⚠ NE PAS LEVER UN « a venir » AVANT QUE LE MODULE EXISTE. Le bus importe le
// chemin declare : un module absent le fait repondre « indisponible », donc
// l'app masque son bouton sans dire pourquoi. Un `etat` leve trop tot ne casse
// rien de visible, et c'est precisement le probleme.
export default {
  domaine: 'avis',
  version: 1,
  actions: {
    // La fenetre d'evaluation du voyageur, pour l'hote (droit avis: write).
    'avis.evaluer': {
      type: 'fenetre', droit: { domaine: 'avis', niveau: 'write' },
      module: '/core/avis/fenetre-evaluation.js',
      params: ['booking_uid'],
    },
    // L'etat de l'evaluation d'un sejour (droit avis: read).
    'avis.statut': {
      type: 'requete', droit: { domaine: 'avis', niveau: 'read' },
      module: '/core/avis/statut.js',
      params: ['booking_uid'],
    },
    // L'ecran de questions de la prestataire, identite par jeton (PWA).
    // ⚠ PARAMETRES CHANGES AU LOT 5 (2 octobre 2026) : la PWA ne connait pas
    // `menage_event_id` au moment de « Menage fait » ; elle connait le triplet
    // du menage, le meme que `markDone`. Contrat : docs/kb/protocole-coeur.md.
    'avis.questions_prestataire': {
      type: 'fenetre', identite: 'jeton',
      module: '/core/avis/questions-prestataire.js',
      params: ['property_id', 'booking_id', 'departure_date'],
    },
    // Les reglages d'une prestataire (perimetre, pouvoir), lus et ecrits par
    // l'app menage (droit avis: write).
    'avis.reglages_prestataire': {
      type: 'requete', droit: { domaine: 'avis', niveau: 'write' },
      module: '/core/avis/reglages-prestataire.js',
      params: ['profile_id'],
    },
  },
  evenements: {
    // Emis par le coeur quand une evaluation est publiee chez l'OTA.
    'avis.evaluation_publiee': { detail: ['booking_uid', 'published_at'] },
  },
}
