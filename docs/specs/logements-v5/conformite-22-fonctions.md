# §9 — Tableau de conformité : les 22 fonctions de l'inventaire

**À lire avant tout code**, comme la spec l'exige. Source du fond :
`docs/specs/inventaire-biens.md`. Source de la forme :
`docs/specs/logements-v5/spec-logements-v5.md`.

**Statuts** : *conservée* (même place, même geste) · *déplacée* (le geste reste,
l'endroit change) · *transformée* (le geste change de forme) · *retirée*.

## Sur la liste

| # | Fonction | Aujourd'hui | Demain | Statut |
|---|---|---|---|---|
| 1 | Voir ses biens | liste, carte par bien | liste V5, 4 colonnes / lignes mobile | **conservée** |
| 2 | Ajouter / remplacer la photo | zone photo de la carte | **fiche**, bouton « Changer la photo » ; la liste n'affiche que le repli « Ajouter une photo » | **déplacée** — la carte devient entièrement cliquable (§2), un second geste cliquable dedans se dispute le clic |
| 3 | Lire la provenance du bien | pastille `provider` sous le nom | **retirée de l'écran**, sauf le cas Beds24 de l'hôte (§6 : « Géré depuis votre compte Beds24 ») | **retirée** — « provenance » est notre vocabulaire interne ; §6 interdit de nommer le partenaire |
| 4 | Lire les canaux reliés | 2ᵉ ligne, **appel partenaire en direct** | pastilles lues dans `canaux_du_bien` (dette 59, en prod) ; détail par canal sur la fiche | **transformée** — plus aucun appel partenaire à l'affichage (§4) |
| 5 | Voir « IA en pause » | pastille rouge | liste : **un seul signal**, « Assistant en pause », gris neutre ; fiche : l'interrupteur | **transformée** — le rouge est réservé à la suppression et aux erreurs (§7) |
| 6 | Couper l'IA / Réactiver | bouton de la carte | **fiche**, interrupteur « Assistant HôteSmart » | **déplacée** — idem fonction 2 : la carte est un lien |
| 7 | Lire le mode des prix | ligne « Prix sur les plateformes » | **fiche**, bloc Prix | **déplacée** — et le texte « ancien channel manager » disparaît (D10, §6) |
| 8 | Changer le mode des prix | bouton → fenêtre | **fiche**, sélecteur à deux choix ; **disparaît une fois en `managed`** (§3.2) | **transformée** — une fenêtre pour deux choix est une fenêtre de trop ; `reglages:write` garde sa garde serveur (§5) |
| 9 | Ouvrir le calendrier du bien | bouton de la carte | **fiche**, bouton Calendrier en en-tête | **déplacée** |
| 10 | Ouvrir l'assistant de connexion | bouton « Connexions » | **fiche**, bloc « Où il est en vente », action par ligne | **déplacée** — l'assistant existant est réutilisé, pas réécrit |
| 11 | Publier ses prix | bouton → fenêtre | **fiche**, bloc Prix, « Publier mes prix » + confirmation courte | **déplacée** |
| 12 | Modifier le bien | fenêtre, 11 champs | **fiche**, bloc « Le logement » (6 champs) + bloc Prix (5 champs), **édition sur place**, enregistrement automatique | **transformée** — les 11 champs restent, répartis par sujet ; plus de bouton Enregistrer (§3.3) |
| 13 | Supprimer le bien | fenêtre + frappe du nom | **fiche**, en bas, discret rouge ; **la condition est dite avant le clic** ; frappe du nom conservée | **transformée** — la garde cachée devient visible (fonction 20) |
| 14 | Ajouter un bien | bouton d'en-tête, titulaire | liste V5, « Ajouter un logement », titulaire | **conservée** |
| 15 | Connecter son premier logement | état vide | état vide V5 : Connecter / Ajouter manuellement | **conservée** |
| 16 | Ouvrir Beds24 | lien externe sur la carte | **fiche** : « Géré depuis votre compte Beds24 », **sans lien** (§6 : « sans lien de pub ») | **transformée** |

## Sur la création

| # | Fonction | Aujourd'hui | Demain | Statut |
|---|---|---|---|---|
| 17 | Créer un bien | `/biens/nouveau`, 11 champs | même formulaire, habillé V5, mêmes champs répartis « Le logement » + « Prix » (§1) | **conservée** |

## Les quatre cachées

| # | Fonction | Aujourd'hui | Demain | Statut |
|---|---|---|---|---|
| 18 | Inventaire du partenaire en iframe | 60 lignes dormantes, `/biens/:id` | **supprimé** (§1), `api/channel-token` reste vivant pour l'assistant de connexion | **retirée** — en sommeil depuis la bêta ; du code mort qui donne l'illusion d'un écran |
| 19 | Masquage sur compte partagé | ne couvre que « Ajouter un bien » et le kill switch | **toutes** les actions masquées par droit, et **chacune garde sa garde serveur** (§5, D2) | **transformée** — c'est la correction de D2 |
| 20 | Garde de suppression | le serveur refuse, l'écran le dit **après** | **dite avant le clic** : bouton désactivé + « Impossible tant qu'il a des réservations ou des messages. » | **transformée, et rendue visible** |
| 21 | Reprise du parcours Airbnb | `bootstrapAirbnbReturn()`, silencieuse | **conservée**, dans le bloc « Où il est en vente » (§3.1) | **déplacée** |
| 22 | Redirection `/biens/:id/calendrier` | route héritée vivante | **conservée** (§1 : « la redirection reste ») | **conservée** |

## Le compte

**22 fonctions : 6 conservées, 7 déplacées, 7 transformées, 2 retirées.**

Les deux retirées sont la **pastille de provenance** (notre vocabulaire, et §6
interdit de nommer le partenaire) et l'**iframe dormante** (§1 l'ordonne).
Aucune fonction n'est perdue par omission : les sept « déplacées » le sont
parce que la carte de la liste devient **un lien**, et qu'un bouton dans un lien
se dispute le clic.

## Les onze défauts, et où ils se ferment

| défaut | où il se ferme |
|---|---|
| D1 — pas de traduction | §6 : i18n `fr/en/es` complète, préfixe `logements.*`, **sans repli français en dur** dans les appels `T()` |
| D2 — 4 actions non masquées par droit | §5, et la règle absolue : masquage **plus** garde serveur, avec le test « retirer le masquage → 403 » |
| D3 — « Capacité : personne(s) » | §2 : **rien** si la capacité est vide |
| D4 — emoji en guise d'icônes | §7 : sprite |
| D5 — couleurs en dur | §7 : aucun hexa dans les pages |
| D6 — ancienne charte | §1 : barre V5, `theme.css` / `ui.css` |
| D7 — chevauchement à 390 px | §7 : pas de défilement horizontal à 390 px |
| D8 — pas de fiche | §3 : la fiche **est créée** |
| D9 — « Beds24 » visible | §6 : seulement si c'est le compte de l'hôte, **sans lien** |
| D10 — « ancien channel manager » | §6 : interdit |
| D11 — textes des canaux non traduits | §6 : les 10 chaînes passent à l'i18n, « — inactif » devient « Pas en vente sur ce logement » |

**Les onze sont adressés par ce lot.** Deux l'étaient déjà en partie le
19 octobre : D2 pour « + Ajouter un bien » (le serveur refuse maintenant en 403,
et la règle de masquage est devenue globale) et D4/D11 pour les canaux, qui
viennent désormais du cœur.
