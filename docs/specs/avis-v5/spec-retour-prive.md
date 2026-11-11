# Avis V5 — le retour privé du voyageur sur la page Avis

**Statut : décisions de Thierry du 11 novembre 2026 (08:39 à 08:50) ; code sur la
branche `avis-retour-prive`, partie de `main` à
`285bfae09a356deb5b83e0c3a7dcaff32cd1afd2`.**

**Dépendance (chef de file, 11 novembre 2026, 08:54)** : `avis-v5-resume`
(`3e8d897f32a3ef1aad892244388034bb8723e43c`) est mergée dans cette branche AVANT
toute modification d'`api/avis.js` et de `core/avis/cartes.js`, seuls fichiers
qu'elle tient aussi. **`avis-v5-resume` passe en `main` avant `avis-retour-prive`** ;
si sa tête bouge, la remerger. Fichiers partagés : `shared/ui.css` (bloc de la
page Avis seulement) et `shared/i18n/*.json` (ajouts de clés seulement).

## 1. Pourquoi

Le 11 novembre 2026, Thierry relève un avis de La bulle (séjour du 27 au
29 octobre) : **bon en public, mais le retour privé signale des problèmes et
justifie un 4 au lieu d'un 5**. Il ne l'a vu que chez Airbnb.

La page Avis n'affichait jamais le retour privé, et c'était voulu : `CHAMPS`
(`api/avis.js`) l'écartait « pour moindre exposition », avec la mention
« l'ajouter un jour est une décision à prendre ». Seul l'extrait de propreté en
remontait. Tout autre reproche fait en privé — bruit, chauffage, équipement,
accueil — restait invisible dans HôteSmart.

## 2. Décisions

- **Q1 = B** : le retour privé est lisible par le titulaire **et par les membres
  qui ont le droit `avis`**, sur leur périmètre de biens. Aucun droit nouveau.
- **Q2 = A** : le texte privé s'affiche sur la carte de l'avis, **sous le texte
  public**, avec la mention « Retour privé » ; et la carte porte la marque
  « Retour privé » dans son en-tête, pour qu'on la repère en parcourant la liste
  sans la lire. **Aucune IA en plus** : l'avis ne passe pas dans « À traiter ».
- **Le compteur de la prestataire ne compte que la propreté** (inchangé). Elle
  reçoit l'extrait de propreté — marqué « retour privé » quand il vient de là —
  et son pouce, selon le classement qui lit déjà le public ET le privé. Un
  reproche privé qui ne parle pas de propreté ne lui est jamais attribué : elle
  ne répond que du ménage.

## 3. Ce qui change

- `api/avis.js` : `content_private` entre dans `CHAMPS`. Il sort sous le droit
  `avis`, comme le texte public — pas sous `reservations` : c'est le contenu de
  l'avis, pas l'identité du voyageur ni ses dates.
- `lib/avis/cartes.js` : chaque avis de carte porte `texte_prive`, `null` pour un
  avis masqué (Airbnb ne montre rien tant que l'avis est caché, et la carte n'en
  montre que la présence).
- `core/avis/cartes.js` : sous le texte public, un bloc « Retour privé » avec une
  ligne qui dit qu'il n'est pas publié ; le texte se replie au-delà de
  220 caractères, comme le public. Dans l'en-tête de la carte, la marque
  « Retour privé ».
- Textes en fr, en, es.

## 4. Inventaire (règle « la forme ne supprime jamais le fond »)

Rien n'est retiré. L'extrait de propreté, la note, le classement, notre avis et
le bouton « Évaluer » restent où ils sont. La PWA de la prestataire et le
planning de garde ne changent pas : ils montrent l'extrait, jamais le retour
privé entier.

## 5. Ce qui ne passe PAS par ce lot

- **L'avis du 27 au 29 octobre n'est pas encore à jour dans HôteSmart** : il y
  est toujours masqué. Airbnb ne l'a rendu visible qu'après la publication
  automatique de notre évaluation (11 novembre, 00:20). La lecture quotidienne
  des avis Airbnb le rapportera avec son texte privé ; ce lot n'y change rien.
- Repérer automatiquement une critique dans le retour privé (Q2 = B, écartée).

## 6. Performance (huit points)

1. Un endpoint d'écran : inchangé (`/api/ecran/avis`).
2. Donnée non urgente : sans objet — le texte d'un avis est une donnée, pas un
   chiffre calculé.
3. Cache navigateur : sans objet — les cartes ne sont pas mises en cache, seuls
   les compteurs le sont ; le retour privé n'entre donc dans aucun stockage du
   navigateur.
4. `private, no-store` : inchangé.
5. Fichiers statiques : sans objet (clés ajoutées aux fichiers i18n existants).
6. Lectures : aucune nouvelle ; une colonne de plus dans la lecture existante.
7. Budget : `tests/budget-ecran.test.js` inchangé.
8. Mesure : appels et requêtes inchangés par construction (une colonne de plus,
   aucune requête) ; les octets augmentent de la longueur des retours privés
   servis. Mesure APRÈS en production après le merge.

## 7. Tests attendus

- la carte porte `texte_prive` ; `null` pour un avis masqué ; `null` pour un
  avis Booking ou une saisie manuelle ;
- un membre `avis: read` le reçoit sur ses biens, et pas sur les autres ;
- le rendu : bloc « Retour privé » sous le public, texte échappé, replié
  au-delà de 220 caractères ; marque dans l'en-tête de la carte seulement s'il
  y a un retour privé ; rien pour un avis masqué ;
- la PWA de la prestataire ne reçoit toujours pas le retour privé entier.

## 8. Contre-épreuve (mutations du code du lot)

Sept mutations ; cinq rougissent du premier coup. Les deux qui survivaient :
- **retirer `content_private` de la lecture** restait vert, parce que le double
  de `tests/avis-cartes-endpoint.test.js` renvoie la ligne entière quelle que
  soit la sélection. Fermé : le test exige la colonne dans la lecture réelle ;
  la mutation rougit depuis ;
- **retirer la garde « masqué » de `blocRetourPrive`** reste vert, et c'est
  attendu : `blocSonAvis` sort AVANT pour un avis masqué. La garde est une
  seconde ligne ; la marque d'en-tête, elle, est testée sur l'avis masqué.
