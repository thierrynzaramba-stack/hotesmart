# Spec — Refonte UI V5, lot « Logements » (liste + fiche par bien)

Maquette : planches `Logements-v5`, `Logements-mobile-v5`, `Fiche-bien-v5`, `Fiche-bien-mobile-v5`
de l'artefact « HôteSmart — Refonte UI ».
Base métier : `docs/specs/inventaire-biens.md` (22 fonctions, D1 à D11) et
`docs/specs/spec-canaux-au-coeur.md` (dette 59, en prod).

⚠ **`docs/specs/inventaire-biens.md` ne vit PAS sur cette branche** : il est sur
`inventaire-biens`, au commit `da5219d`. Comme c'est lui qui « fait foi sur le
fond », le croiser depuis ce worktree demande de l'extraire :
`git show da5219d:docs/specs/inventaire-biens.md`. À merger dans `main`, ou à
citer par ce SHA — sans quoi la règle « la forme ne supprime jamais le fond »
est invérifiable depuis ici.
**La spec donne la forme ; l'inventaire fait foi sur le fond.** Avant tout code :
tableau de conformité (§9), chaque fonction → conservée / déplacée / retirée.

## 1. Ce que le lot remplace

- `/biens` (`pages/biens.html`) → la **liste V5** `Logements` (onglet « Logements » de `nav.js`).
- `/biens/:id` (redirection + 60 lignes dormantes) → la **fiche V5** d'un bien. Le code dormant
  de l'iframe partenaire est supprimé (fonction 18 retirée, motif : en sommeil depuis la bêta).
- Les 4 fenêtres Modifier, Supprimer, Mode des prix, Publier → intégrées à la fiche.
- `/biens/nouveau` → même formulaire, habillé V5 (les champs du bloc « Le logement » + « Prix »).
- `/biens/:id/calendrier` : la redirection reste.
- Ancienne barre latérale retirée de ces écrans ; barre V5 (haut + bas).

## 2. Liste (desktop 4 colonnes, mobile en lignes)

Une carte par bien, entièrement cliquable → fiche :
- photo (repli : vignette neutre + « Ajouter une photo » si droit `reglages:write`) ;
- nom ; ville · capacité (« 4 voyageurs » ; **rien** si capacité vide — D3) ;
- pastilles de canaux lues dans `canaux_du_bien` : point vert = en vente pour ce bien ; rond vide gris = canal relié mais ce bien n'y est pas en vente ; canal absent = pas de pastille. Couleurs neutres (les couleurs Airbnb/Booking/Direct restent réservées au Calendrier) ;
- **un fait daté** : prochaine arrivée, « Occupé · départ <jour> », ou « Libre jusqu'au <date> » (faits comptés depuis les réservations, jamais d'estimation) ;
- **un seul signal** si présent : « Assistant en pause » (gris neutre, icône pause).
En-tête : titre « Logements » + « Ajouter un logement » (bouton blanc bord noir), visible seulement pour le titulaire.

États : vide (« Ajoutez votre premier logement » + Connecter / Ajouter manuellement), refus de droit, erreur de lecture — même forme que Ménages, i18n, pas de « PMS ».

## 3. Fiche d'un bien `/logements/:id`

> ⚠ **Route corrigée le 21 octobre 2026 (décision de Thierry).** La spec disait
> `/biens/:id` — c'est aujourd'hui l'IFRAME DORMANTE que le §1 ordonne de
> supprimer, et c'est la raison pour laquelle la carte de la liste n'est pas
> encore cliquable : un clic y déposerait l'hôte dans du code mort. La fiche V5
> vit donc sur `/logements/:id`, cohérente avec `/logements` ; `/biens/:id`
> redirigera à l'étape 4, et l'ancien écran reste **intact** pendant toute la
> recette.

Retour « ‹ Logements ». En-tête : photo (bouton « Changer la photo » si droit), nom, ville · capacité,
pastilles, bouton **Calendrier**, interrupteur **Assistant HôteSmart** (kill switch, titulaire / `reglages:write`).

Colonne gauche :
1. **Où il est en vente** — Airbnb, Booking.com, Réservation directe au même rang. Par ligne : état (« En vente » vert / « Pas en vente sur ce logement » gris), « vérifié il y a… » (règles de la dette 59 : « non vérifié depuis le … » + Actualiser au-delà de 24 h), et l'action Connecter / Activer (assistant de connexion existant, reprise OAuth Airbnb conservée — fonction 21).
2. **Prix** — mode des prix en sélecteur : « HôteSmart envoie mes prix » / « Je garde mes prix actuels ». **Le second n'apparaît que si le bien est en mode `keep`** (migration) ; une fois en `managed`, le sélecteur disparaît. Champs : prix de base, prix plancher (défaut 10 €), devise, voyageurs inclus, supplément par voyageur. Bouton **Publier mes prix** (seulement en `managed`) → confirmation courte : « Vos prix remplaceront ceux d'Airbnb et Booking.com pour toutes les dates à venir. » [Annuler] [Remplacer mes prix].
3. **Le logement** — nom, capacité, adresse, code postal, ville, pays. Édition sur place, enregistrement automatique avec « Enregistré » (pas de bouton Enregistrer), erreurs serveur affichées sous le champ.
4. **Supprimer ce logement** — en bas, discret rouge. La condition est dite **avant** le clic.

   > ⚠ **Règle corrigée le 21 octobre 2026 (décision de Thierry).** Cette spec
   > disait « bouton désactivé si le bien a des réservations ou des messages ».
   > **Ce n'est pas ce que le serveur refuse.** `api/channel-property.js` DELETE
   > purge les réservations et les messages ; ce qu'il refuse, c'est un bien
   > **encore relié à une annonce**. Écrire la règle d'origine aurait affiché
   > une phrase que le serveur dément — et promis un refus là où il accepte.
   >
   > **On s'aligne sur le serveur : c'est lui la vraie protection**, et c'est la
   > même règle que pour la suppression de compte. Donc :
   > · bouton **désactivé tant que le bien est relié à une annonce**, avec la
   >   raison « Déconnectez d'abord ses canaux » ;
   > · quand il est actif, la **confirmation dit ce qui sera effacé, avec les
   >   nombres** (réservations, messages…), puis la frappe du nom (conservée).
   >
   > ⚠ Les nombres supposent que l'endpoint les compte : c'est une dépendance de
   > l'**étape 3**, l'étape 2 n'affichant que l'état et la raison.

Colonne droite :
5. **Ménage** — prestataires assignées au bien (nom prénom, mode : d'office / proposé en Nᵉ, pouces), lien « Gérer l'équipe ménage » (ouvre le volet existant).
6. **Avis des voyageurs** — la **même note sur 5, avec l'étoile, que sur la liste**.

   > ⚠ **Corrigé le 21 octobre 2026 (décision de Thierry).** Cette spec disait
   > « pouces vert / rouge sur 30 jours (jamais d'étoiles) ». Deux écrans du
   > même lot auraient alors dit les avis de deux façons — et le rouge est
   > réservé par le §7 à la suppression et aux erreurs, or une remarque de
   > propreté n'est ni l'une ni l'autre.
   >
   > · **la note** : identique à la carte de la liste, étoile du sprite comprise
   >   (`4,9 / 5 · 336 avis`). Les deux écrans doivent dire la même chose ;
   > · **les pouces** : réservés à la **propreté** seule, en couleur **neutre**,
   >   jamais en rouge. **Juste le compteur, sans légende.**
7. **Réglages** — Serrure (état + lien vers son réglage), Taxe de séjour (barème + lien). Lecture et lien seulement dans ce lot.

Mobile : en-tête photo pleine largeur, Calendrier, interrupteur, « Où il est en vente », puis lignes « Prix », « Ménage », « Le logement », « Avis », « Réglages » qui ouvrent chacune une page.

> ⚠ À l'**étape 2**, la fiche est en **lecture seule** : aucun bouton d'action
> n'agit (ni photo, ni interrupteur, ni sélecteur de prix, ni suppression). Ce
> qui est masqué par droit garde sa garde serveur, et ce qui mène à un refus
> n'est pas montré — règles de Thierry du 20 octobre.

## 4. Données

Un endpoint de lecture unique pour la fiche, `GET /api/channel-property?id=` (ou `api/logement`), qui assemble **côté serveur** :
- `properties` (UUID) ; `canaux_du_bien` (UUID) ; `ota_reviews` (UUID) ;
- réservations, ménages/prestataires, serrure, taxe de séjour (tables en `property_id` **TEXT**) — la jointure TEXT/UUID est faite **dans l'endpoint**, jamais dans la page ;
- le drapeau « suppression possible » (même règle que la garde DELETE actuelle).
Écritures : endpoints existants (PATCH, photo, automation, fullsync, DELETE). `X-Compte` sur chaque appel ; aucun appel partenaire à l'affichage.

## 5. Droits (règle absolue)

Chaque action masquée par droit garde sa garde serveur (D2). Modifier / Supprimer / Mode des prix / Publier / Photo / Connecter : `reglages:write` ; ajout de logement : titulaire. Profil en lecture : la fiche s'affiche, champs en lecture seule, aucun bouton d'action dans le DOM. Test : retirer le masquage → le serveur répond 403.

## 6. Textes

- Jamais : le nom du partenaire, « PMS », « ancien channel manager », « channel manager », emoji.
- **Beds24** : affiché seulement pour un bien dont c'est le compte de l'hôte (« Géré depuis votre compte Beds24 »), sans lien de pub ; hors de ce cas, jamais.
- « — inactif » remplacé par « Pas en vente sur ce logement » (D11).
- Dates en toutes lettres via `Intl`. i18n `fr/en/es` complète, préfixe `logements.*`, y compris les 10 chaînes de canaux de D11 (pluriels ICU). Pas de repli français en dur dans les appels `T()`.

## 7. Charte

`theme.css` / `ui.css` / sprite ; aucun hexa dans les pages ; ambre réservé au badge de navigation ; vert = en vente / OK ; rouge = suppression et erreurs ; boutons principaux blancs bord noir ; zones de clic ≥ 44 px ; pas de défilement horizontal à 390 px (D7).

## 8. Ordre de livraison

0. Endpoint de lecture de la fiche (assemblage TEXT/UUID) + tests, sans écran.
1. Liste V5 (lecture seule) + états vide/erreur/refus.
2. Fiche V5 en lecture : en-tête, canaux, prix, logement, ménage, avis, réglages.
3. Actions de la fiche : édition sur place, photo, assistant, mode des prix, publier, connecter, supprimer.
4. Création `/biens/nouveau` en V5 ; retrait de l'ancien écran et du code dormant.
Chaque étape : desktop + mobile, i18n-check, review high, preview staging, recette de Thierry, puis prod.

## 9. Tableau de conformité (à produire avant le code)

| # inventaire | Fonction | Aujourd'hui | Demain | Statut |
|---|---|---|---|---|
| 1–22 | … | … | … | conservée / déplacée / retirée (motif) |
