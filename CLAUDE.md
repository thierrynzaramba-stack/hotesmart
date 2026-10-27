# CLAUDE.md — HôteSmart

SaaS LCD modulaire (App Store hôtes francophones). Product owner = Thierry (non-dev, ne parle pas anglais — traduire si besoin). Claude = développeur AI.

## INTERACTION
- Répondre en français. Étape par étape. UNE action à la fois.
- Pas de postambules, récaps, félicitations, emoji. Finir sur du technique direct.
- Ne JAMAIS afficher/coller une clé, un token ou un secret — règle absolue ci-dessous.

## RÈGLE ABSOLUE — LE CLONE EST PARTAGÉ PAR PLUSIEURS SESSIONS

- **Avant de commiter : `git status --short`.** Un fichier modifié qu'on n'a pas
  touché soi-même appartient à quelqu'un d'autre. On commite **par chemins
  explicites** — `git add <fichiers>` — et **jamais** `git add -A`, `git add .`
  ni `git commit -a`.
- **Aucun `git checkout` / `switch` / `stash` sans prévenir Thierry.** L'arbre de
  travail est COMMUN : changer de branche change le sol sous les pieds de
  l'autre session, en plein milieu de son édition.
- **Un chantier long se fait dans un worktree séparé** (`git worktree add`), pas
  dans le clone principal. `/home/thierry/hotesmart-b` le fait déjà pour
  `prestataires-lot3`.
- **On se prévient par `SendMessage`** dès qu'on ouvre un fichier : lequel, et
  pour combien de temps. `ListAgents` dit qui tourne.

**Vécu (18 septembre 2026), deux fois dans la même soirée.** Une session a fait
`git add -A` pendant qu'une autre corrigeait six constats de review dans
`api/inbound-email.js` : son commit a emporté 220 lignes de correctifs de
sécurité **non re-reviewés** et les a poussées sur `main` et `channex-phase1`,
donc en production, au moment précis où l'autre retenait le push en attendant la
review. Le message du commit annonçait « aucune de code ». Le même soir, un
`checkout` pour lire un fichier a changé la branche des deux sessions.

**Pourquoi c'est une règle absolue.** Le code emporté était juste — cette fois.
Ce qui ne se répare pas, c'est la ligne de journal : elle dira faux à qui la
lira dans six mois, et l'historique est la seule chose qu'on ne peut pas
corriger sans réécrire ce que deux branches ont déjà tiré.

## COORDINATION DES SESSIONS

**UNE SEULE SESSION TIENT `staging` ET `main` : le CHEF DE FILE.** Les autres ne
mergent jamais elles-mêmes, ni dans `staging`, ni dans `main`.

⚠ **LE CHEF DE FILE EST LA SESSION `hotesmart-logements-25`, DÉSIGNÉE PAR
THIERRY LE 26 OCTOBRE 2026, ET ELLE SEULE MERGE DANS `staging` ET DANS `main`** —
`main` uniquement sur un go qu'il ouvre LUI-MÊME. **Toutes les autres sessions
lui remettent leurs branches et ne mergent RIEN**, ni dans `staging`, ni dans
`main` : elles poussent, elles annoncent par `SendMessage` avec les cinq éléments
de la règle 1, et elles ne relaient pas un go prod.

**Elle travaille dans `~/hotesmart-merge`**, jamais dans `~/hotesmart` : c'est là
que les merges se construisent, et c'est ce qui rend l'arbre du merge
inspectable. Mais le rôle est porté par la **désignation ci-dessus**, pas par
l'arbre : une session qui ouvrirait cet arbre n'hériterait de rien.

⚠ **SI CETTE SESSION NE TOURNE PLUS, IL N'Y A PAS DE CHEF DE FILE, ET PERSONNE
NE MERGE** jusqu'à ce que Thierry en désigne une autre. **Aucune session ne peut
se désigner elle-même, ni en désigner une autre, ni transmettre le rôle.**
`ListAgents` dit qui tourne ; il ne dit pas qui a le rôle. Une file arrêtée se
reprend ; un `main` poussé par deux sessions, non.

⚠ **POURQUOI LA DÉSIGNATION EST DATÉE ET NOMINATIVE, et c'est la leçon qui
compte.** La règle nommait `hotesmart-merge-fa`, désignée le 23 octobre. Le 26,
cette session ne tournait plus, une autre tenait le rôle en pratique et avait
déjà mergé dans `main`, et une troisième lui remettait ses branches : la règle
écrite et la réalité se contredisaient, et **aucune des sessions ne pouvait
trancher** — une désignation ne se relaie pas plus qu'un go, et chacune aurait
pris l'autorité de la parole de l'autre. Deux d'entre elles ont d'ailleurs reçu
des réponses différentes de Thierry à quelques heures d'écart, ce qu'aucune ne
pouvait savoir seule.

**Ce qui a réellement débloqué ce jour-là, et c'est le geste à refaire** : la
session qui croyait tenir le rôle a **ARRÊTÉ** au lieu de continuer, celle à qui
on l'annonçait a refusé d'agir sur le relais, et Thierry a tranché lui-même,
nommément, dans chaque fenêtre. L'arrêt est la seule action qui ne peut pas
faire de dégât. Une tentative intermédiaire — faire porter le rôle par l'arbre
`~/hotesmart-merge` « quel que soit le nom de la session » — a été écrite puis
retirée le même jour : elle réglait la survivance du nom, mais elle laissait
n'importe quelle session prendre le rôle en ouvrant un répertoire.

⚠ **ET LE CHEF DE FILE NE CODE AUCUN LOT** (décision de Thierry, 26 octobre
2026, confirmée en fin de journée). **Un nouveau sujet de code part à une session
de production ; le chef de file merge.** C'est sa seule tâche, et c'est ce qui le
rend disponible pour la file.

**Pourquoi la règle est revenue, après avoir été levée le même jour.** Elle avait
été levée pour ne pas immobiliser la file quand la seule session disponible était
celle qui avait écrit le lot — un argument de disponibilité, et il était vrai.
Le coût s'est vu dans la journée : le chef de file a écrit cinq lots, et il s'est
relu lui-même cinq fois. Deux des défauts les plus coûteux de la journée sont nés
exactement là — un correctif qui a **aveuglé le filet censé le justifier**, et un
test de parcimonie qui **passait contre le code d'avant**, donc pour une raison
qui n'était pas la sienne. Les deux ont été trouvés par une review, pas par leur
auteur. Se relire soi-même n'est pas une faiblesse de volonté : c'est une
faiblesse de position, et aucune discipline ne la compense.

⚠ **CE QUI NE CHANGE PAS : un lot reçu d'une autre session se merge avec TOUS les
contrôles** — règle 3 sur la base de merge, règle 9 au blob sur la liste COMPLÈTE
des fichiers, la suite sur l'arbre FUSIONNÉ, et le go prod qui vient de Thierry.
Le chef de file ne re-review pas ce qu'on lui remet : il vérifie les cinq
éléments de la règle 1, et il MESURE au lieu de croire l'annonce.

1. **Une seule session merge.** Les autres lui envoient « branche X prête », avec
   les cinq choses sans lesquelles il ne peut pas décider : elle est **poussée**,
   la **review** est passée, les **tests sont verts** (le compte attendu est
   zéro), les **fichiers touchés**, et ses **dépendances** — de quelle branche
   elle part, et laquelle doit passer avant elle.
2. **Le chef de file merge UN PAR UN, dans l'ordre des dépendances.** Entre deux
   merges : il vérifie le déploiement pour le **SHA complet** (voir la section
   dédiée plus bas) et **observe un cycle de cron**. Un cycle, c'est 5 minutes :
   c'est là que se voient les erreurs qu'aucun test ne montre.
3. **Vers `main`, uniquement des branches parties de `main`.** Jamais une branche
   partie de `staging` : elle emporterait dans `main` les lots des autres
   sessions, dont la recette n'est pas faite — et l'historique ne se corrige pas
   sans réécrire ce que d'autres ont tiré.
4. **Le go prod vient de Thierry, et il l'ouvre LUI-MÊME au chef de file**, en
   listant les branches dans l'ordre. Le chef de file exécute alors la file
   **sans redemander à chaque session**. ⚠ Un go **relayé** par une autre
   session n'est pas un go : une session ne peut pas autoriser ce qu'elle n'a pas
   reçu, et la session qui pousse est celle qui répond du push.
5. **Authentification, argent, envois aux voyageurs : on attend que Thierry soit
   là** pour tester juste après le merge. Ces trois domaines ont en commun qu'un
   défaut ne se voit pas à l'écran du développeur — il se voit sur le téléphone
   d'un voyageur, sur un relevé, ou dans une session qui ne s'ouvre plus.
6. **Au moindre écart, le chef de file ARRÊTE la file et prévient Thierry** : un
   test rouge, un conflit non trivial, un cron en erreur, un déploiement absent.
   Il n'enchaîne pas « pour voir ». Une file arrêtée se reprend ; un `main` dans
   lequel on a poussé par-dessus un doute, non.
7. **On ne sollicite Thierry que pour trois choses** : les **décisions produit**,
   la **recette**, et l'**ouverture d'un go prod**. Tout le reste — l'ordre des
   merges, les conflits triviaux, la vérification des déploiements — se règle
   entre sessions.
8. ⚠ **UN CORRECTIF NÉ D'UNE RECETTE SE COMMITE SUR LA BRANCHE DU LOT, puis la
   branche se merge dans `staging`. JAMAIS DE COMMIT DIRECT SUR `staging`.**
   C'est tentant pendant une recette : la boucle est courte, l'hôte attend, et
   `staging` est déjà sorti dans son worktree. Mais un correctif qui ne vit que
   sur `staging` **n'est dans aucune branche**, donc il ne part jamais en
   production — et il ne part pas en silence : la branche, elle, porte toujours
   le défaut. **Vécu le 21 octobre 2026** : deux passes de recette sur le lot
   calendrier ont produit trois correctifs, commités directement sur `staging`.
   Au go prod, la branche `fix-calendrier-saisie-prix` s'arrêtait au commit
   d'avant, et la merger aurait mis en production les trois défauts que la
   recette venait de trouver — dont un prix que personne n'avait tapé, poussé au
   canal. Rattrapé par `cherry-pick -x` vers la branche, mais c'est un
   rattrapage, pas un déroulé.
9. ⚠ **AVANT TOUT MERGE PROD, LE CHEF DE FILE VÉRIFIE QUE CHAQUE FICHIER DU LOT
   EST IDENTIQUE À L'ÉTAT RECETTÉ SUR `staging`** — au blob, pas à l'œil, et sur
   la liste COMPLÈTE des fichiers de l'index, jamais sur un échantillon :

   ```bash
   # dans l'arbre du merge, avant de commiter
   git diff --name-only --cached <main-avant> | while read f; do
     a=$(git rev-parse ":$f"); b=$(git rev-parse <sha-recette>:"$f" 2>/dev/null || echo ABSENT)
     [ "$a" != "$b" ] && echo "DIFFERE : $f"
   done
   ```

   Une ligne de sortie est une question à se poser, pas forcément un défaut : un
   fichier partagé par deux lots **doit** différer, puisque `staging` en porte
   un que `main` n'a pas encore. Mais chaque écart doit être **nommé et
   expliqué** avant le commit.
   **Vécu le 21 octobre 2026, deux fois dans la soirée.** Au merge du lot
   logements, quatre fichiers n'étaient PAS en conflit, donc git a pris la
   version de la branche sans un mot — et la suite rendait **8 rouges** : la
   branche précédait la dette 76, et son `lib/logement/lecture.js` n'appelait
   plus l'alarme des sources d'avis inconnues. Au merge du lot calendrier, le
   même contrôle a confirmé l'inverse : les neuf fichiers du lot étaient
   byte-identiques au recetté, et le seul écart — `shared/ui.css` — était le lot
   logements, attendu et vérifié. **Le contrôle sert autant à valider qu'à
   alerter.**
   ⚠ **Et un merge vers `main` n'est jamais le merge vers `staging` rejoué** :
   sur `staging`, le lot arrive dans un arbre qui contient déjà les autres lots,
   donc git a peu à faire ; sur `main`, il arrive seul, et tout ce que les autres
   lots ont ajouté PAR-DESSUS ses fichiers n'existe pas — sans conflit, sans
   avertissement.

10. ⚠ **EN FIN DE JOURNÉE, TOUT TRAVAIL EN COURS EST COMMITÉ ET POUSSÉ SUR SA
    BRANCHE, MÊME EN WIP. RIEN NE DORT SUR UN DISQUE.** Consigne de Thierry du
    23 octobre 2026. Un commit de travail n'a pas à être propre : son message
    dit où on en est et ce qui reste, et il se réécrit ou se regroupe plus tard.
    Ce qui ne se répare pas, c'est le travail qu'on ne retrouve pas.
    **Pourquoi c'est une règle de file et pas une habitude personnelle.** Une
    branche non poussée est invisible de tout le monde : le chef de file ne peut
    pas la compter dans la file, les autres sessions ne savent pas que ces
    fichiers sont tenus, et personne ne peut la reprendre. Et dans un clone
    PARTAGÉ, le risque n'est pas théorique — la section ci-dessus raconte un
    `git add -A` qui a emporté les correctifs d'une autre session : ce qui n'est
    pas commité est à la merci du prochain geste de quelqu'un d'autre.
    **Vécu, mesuré le 23 octobre 2026.** `fix-dette-78` existait à `c66ee09`
    dans le worktree `/home/thierry/hotesmart-debug`, **absent du distant**
    (`git ls-remote` : rien) — alors que Thierry avait décidé de corriger la
    dette 78 le **20 octobre**. Trois jours sur un disque, pour un correctif
    déjà tranché. C'est ce jour-là qu'il a posé la règle.
    ⚠ **ET LA POUSSÉE NE VAUT PAS « PRÊT » :** une branche poussée en WIP n'est
    pas une remise au chef de file. La remise, c'est les cinq éléments de la
    règle 1 — poussée, review passée, tests verts, fichiers touchés,
    dépendances. Pousser met le travail à l'abri ; ce sont les cinq éléments qui
    le mettent dans la file.

**Pourquoi cette section existe.** Le 18 septembre 2026, deux sessions ont
travaillé dans le même clone et l'une a emporté 220 lignes de correctifs de
sécurité non relues dans un commit qui annonçait « aucune de code » (voir la
section sur le clone partagé). Le 20 octobre 2026, le problème a changé
d'échelle : quatre branches de trois sessions attendaient `staging` et `main` en
même temps, deux d'entre elles touchaient les mêmes fichiers avec des contrats
différents, et un « go prod » a été relayé d'une session à l'autre. Ce qui coûte
cher n'est plus l'écriture simultanée — les worktrees l'ont réglée — c'est
**l'ordre des merges et l'origine de l'autorisation**.

## RÉFLEXE MACHINE (multi-machines Mac bureau / PC portable)
- AVANT toute modif quand on change d'ordi : `git checkout main && git pull origin main`.
- Workflow commit : checkout main && pull && add && commit && push origin main && checkout channex-phase1 && merge main && push origin channex-phase1.
- Mac : repo /Users/thierry/Desktop/hotesmart, zsh, here-docs OK.
- PC : repo ~/hotesmart, Git Bash (here-docs cassent), PowerShell `;` pas `&&`. WSL2 si dispo.
- **Aucune branche dont le nom contient « staging »**, sauf la branche `staging`
  elle-même (cible du projet Vercel staging : elle reçoit la branche d'un lot
  AVANT main, pour la recette, puis main après le merge ; aucun commit n'y est
  fait directement). Une preview du projet de PRODUCTION porte le nom de branche dans
  son hostname : `hotesmart-git-<branche>-<equipe>.vercel.app`. Une branche
  `staging-xxx` y produit un hostname qui parle de staging alors que les
  fonctions `/api` tournent sur la prod. Le résolveur de `shared/config.js`
  ferme déjà ce cas par des motifs ancrés — cette règle est la seconde ligne,
  pour le jour où un domaine propre changera la forme des hostnames.

## STACK
- frontend = HTML/JS statique (/pages, /apps). Scope module ES → window.fn.
- backend = Vercel Serverless /api en **CommonJS** (require/module.exports — JAMAIS import ES6).
- DB = Supabase projet cjmrizpdyhrcurmgyrhs. RLS 28/28 actif — ne JAMAIS désactiver RLS (lecture globale = policy explicite TO authenticated USING(true)).
- auth = Supabase Auth + SMTP Brevo. ai = Claude Haiku via /api/grok.js.
- pms = DUAL-PROVIDER PERMANENT : Beds24 (hôtes équipés) + Channex (hôtes sans CM). Routage par properties.provider via lib/channels/. Marque blanche : variables CHANNEL_* jamais CHANNEX_*.
- paiements = Stripe TEST. emails = Brevo. cron = Vercel natif */5 → /api/cron (Bearer CRON_SECRET).
- deploy = hotesmart.vercel.app (Vercel Pro, 100 fonctions, auto-deploy sur push main). Branche travail = channex-phase1.

## ARCHITECTURE — LE CŒUR DE DONNÉES D'ABORD
- Toute donnée collectée auprès d'un provider (Channex, Beds24, et ceux qui
  viendront) est **d'abord répertoriée dans le cœur de données HôteSmart** —
  les tables Supabase, écrites **par la couche sync uniquement** — puis rendue
  accessible aux apps (ménage, messagerie, yield, avis…) pour leur traitement
  particulier.
- **Aucune app ne lit un provider directement.** Aucune donnée n'existe
  seulement dans une app.
- C'est la généralisation du principe `bookings_snapshot` : un writer unique, un
  schéma commun aux deux providers, et toutes les apps qui lisent la même vérité.
- Vécu : le planning ménage appelait `/api/beds24` en direct, donc un hôte
  Channex voyait un planning **vide** (écart E1 de l'audit d'unification). Le
  correctif n'a pas été d'ajouter un second appel provider dans l'app, mais de la
  faire lire le cœur.
- Corollaire pratique : une nouvelle donnée provider se traite dans cet ordre —
  table du cœur, writer dans `lib/`, puis lecture par l'app. Jamais l'inverse.

## ARCHITECTURE — DONNÉE NON URGENTE = CALCULÉE 1 À 2 FOIS PAR JOUR, SERVIE PRÊTE

- **Les données NON URGENTES** — CA, TO, notes moyennes, min/max, comparaisons
  N-1, marché, statistiques — **sont calculées par le cron quotidien, une à
  deux fois par jour, dans des tables de résumé, et servies par une API qui ne
  fait que LIRE.**
- **Les données TEMPS RÉEL** — réservations, disponibilités, messages, codes,
  ménages du jour, paiements, surréservation — **ne passent JAMAIS par un
  résumé.**
- **TOUT NOUVEL AFFICHAGE déclare sa catégorie dans sa spec AVANT d'être codé.**
  Non urgent = résumé obligatoire.
- **Un test refuse un endpoint d'écran qui calcule une donnée non urgente à la
  lecture.**
- **L'écran affiche l'heure du calcul.** Un résumé sans son heure est un chiffre
  dont personne ne sait l'âge.
- **Un logement nouvellement créé déclenche son premier calcul immédiatement** —
  sinon sa fiche dit « non calculable » jusqu'au lendemain, et l'hôte conclut
  que le produit ne sait rien faire.

**Pourquoi c'est une règle d'architecture et pas une optimisation.** Un chiffre
non urgent calculé à la lecture est payé à CHAQUE ouverture d'écran par CHAQUE
hôte, pour une valeur qui n'a pas changé depuis la nuit. Le coût ne se voit pas
en développement — il se voit quand les logements se multiplient, et il croît
avec eux.

**Vécu, mesuré le 22 octobre 2026 en production, compte réel à 4 logements.**
L'écran d'accueil coûtait **13 appels HTTP, 100 requêtes Supabase et
1 047 556 octets**. `/api/yield`, appelé **deux fois par bien**, en portait
**72 requêtes et 586 Ko** — à lui seul 72 % des requêtes de la page, pour du CA
et du TO sur 30 jours, c'est-à-dire exactement de la donnée non urgente. Et
`/api/messages` en portait 437 Ko **pour un seul champ** : l'état du code
d'accès d'une arrivée. Détail et ordre des lots :
docs/specs/spec-performance-pages.md.

**Corollaire, et c'est la moitié qu'on oublie** : une table de résumé stocke un
`null` AVEC son motif, jamais un 0. Un résumé qui écrit 0 là où le calcul
répond « non calculable » transforme une absence en fait, et l'écran l'affiche
avec l'aplomb des vrais chiffres (docs/kb/restitution-yield.md).

## RÈGLE — TOUT LOT QUI TOUCHE LE FRONT RESPECTE LE CHARGEMENT RAPIDE

**Le chantier performance est CLOS** (26 octobre 2026, décision de Thierry). Ses
lots (a) et (b) sont livrés ; ce qui restait — (c) et (d) — ne vit plus comme un
chantier séparé mais comme **cette règle, appliquée au fil des lots**. Détail et
mesures : docs/specs/spec-performance-pages.md.

⚠ **TOUTE SPEC DE LOT QUI TOUCHE LE FRONT PORTE UNE CASE « PERFORMANCE », ET
ELLE EST OBLIGATOIRE.** Un lot sans cette case n'est pas prêt à être codé. Les
huit points ci-dessous y sont répondus un par un — « sans objet » est une
réponse valable, « on verra » n'en est pas une.

1. **Un écran = UN endpoint d'écran** (`/api/ecran/<page>`), garde unique
   `contexteDEcran`, et les lectures **en parallèle côté serveur**. Pas treize
   appels depuis le navigateur pour peindre une page.
2. **Donnée non urgente = résumé PRÉ-CALCULÉ une à deux fois par jour**, jamais
   calculée à la lecture, et **l'heure du calcul est affichée**. Un résumé sans
   son heure est un chiffre dont personne ne sait l'âge.
3. **Affichage instantané** : cache navigateur **à clé utilisateur + compte**,
   **vidé à la déconnexion**. ⚠ Et JAMAIS de code d'accès, de paiement, de
   surréservation, ni d'une tâche qui en porte un : ces états se relisent, ils
   ne s'affichent pas depuis un cache.
4. **Toute donnée de compte en `private, no-store`**, et l'en-tête est posé
   **AVANT le premier refus** — pas avant la garde : avant le PREMIER refus, le
   405 de méthode compris (dette 90).
5. **Fichiers statiques versionnés et en cache longue durée** (`?v=<empreinte>`
   + `max-age` long, `immutable`). Un fichier sans version ne peut pas être mis
   en cache longtemps sans risquer de servir du vieux.
6. **Jamais de lecture tronquée en silence à 1000 lignes.** PostgREST rend 1000
   lignes SANS erreur : toute lecture qui peut dépasser se pagine **par
   curseur**. C'est la famille de défauts la plus silencieuse du dépôt.
7. **Budget par écran : premier affichage < 1 s, écran complet < 2 s.** Il se
   tient par un **test qui compte les appels de l'écran**, et par
   `Server-Timing` portant **le nombre de requêtes** — un budget sans test est
   un vœu.
8. **Mesure AVANT / APRÈS dans la spec du lot** : appels, requêtes, octets.
   Trois nombres, mesurés, pas estimés.

**Pourquoi une règle plutôt qu'un chantier.** Un chantier se termine ; un écran
neuf, non. La mesure du 22 octobre 2026 — accueil à **13 appels, 100 requêtes,
1 047 556 octets** sur un compte de quatre logements — n'a pas été produite par
une négligence, mais par treize décisions raisonnables prises chacune sans
regarder la page entière. Une case dans la spec force ce regard au moment où il
coûte le moins : avant d'écrire la première ligne.

## RÈGLE — LE MOBILE SUIT L'ORDINATEUR
- **Toute spec livrée sur la version ordinateur d'un écran est reportée sur sa
  version mobile — ou le report est PROPOSÉ à Thierry en fin de chantier.**
  Jamais un chantier desktop clos sans que la question du mobile ait été posée.
- **Une règle partagée par les deux versions vit dans un module commun**
  (`shared/…`), jamais recopiée dans chaque page : deux copies divergent.
- Vécu (30 septembre 2026) : la couleur des réservations était tirée au sort
  (`SRC[idx % 3]`) sur les deux calendriers ; l'ordinateur avait été corrigé,
  le téléphone jamais — une réservation Booking s'y affichait en rouge Airbnb.
  Le mobile n'avait ni fiche, ni ajout, ni messagerie. Rattrapé par
  `shared/calendrier-resa.js` (docs/kb/reservation-directe.md §12).

## RÈGLE — REFONTE UI : LA FORME NE SUPPRIME JAMAIS LE FOND
- **Les specs UI (docs/specs/spec-refonte-ui-v5*.md) et la maquette donnent la
  FORME. Les specs métier (docs/specs/*.md) et les KB (docs/kb/) donnent le
  FOND.**
- **Avant chaque lot** : lire les specs métier et la KB de la page refaite, les
  croiser avec la spec UI, et adapter le template — toute fonction, information
  ou réglage existant est **conservé, déplacé ou retiré AVEC RAISON**, dans une
  section « Inventaire » de la spec du lot.
- **Une spec UI ne supprime jamais une fonction métier par omission.** En cas
  de conflit entre forme et fond, le fond l'emporte, et on le signale à
  Thierry.
- Vécu (11 octobre 2026, lot 2 étape 1) : la nouvelle messagerie avait perdu
  le badge « Arrive aujourd'hui / demain », le téléphone du voyageur en lien
  d'appel et l'état du ménage — des affichages que l'ancienne page portait
  pour les arrivées du jour, repérés par Thierry en recette, pas par la spec.

## ARCHITECTURE — CONFIG D'APP vs CONFIG GÉNÉRALE
- **La configuration d'une APP vit DANS l'app.** Prestataires de ménage et leurs
  biens → `apps/menages/prestataires.html`. Modèles de messages → l'app
  messagerie. Réglages de tarification → l'app yield.
- **`/settings` ne porte que la configuration HôteSmart GÉNÉRALE** : identités,
  accès, droits par domaine, facturation, connexions.
- **Test qui tranche : ce réglage a-t-il un sens si l'app n'existait pas ?**
  Oui → `/settings`. Non → dans l'app.
- Corollaire : un prestataire de ménage n'a **pas accès à HôteSmart**, seulement
  à l'app ménage. Il reste un profil `access_mode = 'lien'` en base — le modèle
  de données ne bouge pas, les avis et la qualité en auront besoin — mais seul
  l'écran de l'app ménage le gère.
- Vécu : gérer les prestataires depuis `/settings` y avait introduit un second
  writer de `public_tokens.property_ids`, donc l'écrasement silencieux des biens
  réglés dans l'app ménage.

## RÈGLE ABSOLUE — REVIEW AVANT PUSH
- **Aucun push tant qu'une review est en cours.** La review fait partie du commit,
  pas de l'après-commit : on attend son retour, on la LIT, on corrige, puis on pousse.
- Vécu : un push lancé pendant une review a mis en production une régression
  bloquante (l'envoi de SMS cassé ~20 min) que cette même review a signalée en
  premier point. Sur ce chantier, chaque review a trouvé au moins un défaut réel
  dans du code qui passait les tests.
- Corollaire : `npm test` au vert n'autorise pas à pousser. Les tests disent que
  ce qu'on a pensé à vérifier fonctionne, pas que le code est correct.

## RÈGLE ABSOLUE — LIRE AVANT D'ÉCRASER
- **Un fichier existant se lit avant d'être réécrit.** `ls` / `git log -- <chemin>`
  d'abord ; si le fichier existe, on l'ouvre EN ENTIER, et on édite de façon
  ciblée plutôt que de réécrire.
- Après une écriture : `git diff --stat`. Un diff de 90 lignes supprimées là où
  on croyait en ajouter 15 signale qu'on a écrasé, pas complété.
- Vécu (12 septembre 2026) : `api/yield-exceptions.js`, livré au lot 2.2 avec
  ses gardes apprises en review, réécrit sans être lu — 97 insertions,
  92 suppressions. C'est un TEST du lot 2.2 qui a refusé de passer, pas la
  prudence. L'ajout réellement nécessaire faisait 17 lignes.
- Détail et corollaire : REVIEW.md règle 14.

## RÈGLE ABSOLUE — UN MASQUAGE PAR DROIT NE SUFFIT JAMAIS

- **Tout élément masqué parce que l'utilisateur n'y a pas droit se double d'une
  GARDE SERVEUR.** Le masquage est un confort d'interface, pas une protection :
  il tombe sur une feuille de style absente, sur un `display` d'auteur, sur un
  navigateur qui n'applique pas la règle — et il ne tombe jamais devant une
  requête faite à la main.
- **Le test qui tranche** : si on retire le masquage et qu'on clique, le serveur
  refuse-t-il ? Si la réponse n'est pas « oui, en 403 », il n'y a pas de garde.
- La règle qui fait que `hidden` masque — `[hidden] { display: none !important; }`
  — est **en tête des trois feuilles du site** (`public/style.css`,
  `shared/theme.css`, `shared/ui.css`) et **en ligne** sur les quatorze pages
  qui n'en chargent aucune. Pas d'`@import` : il ajoute une requête bloquante
  par feuille. Et en ligne plutôt qu'un fichier partagé, parce que
  `pages/book.html` doit rester autonome (marque blanche, embarquable) et que
  deux pages de l'app prestataire doivent tenir hors ligne.
- **C'est `tests/masquage-hidden.test.js` qui tient la cohérence** : il résout
  les feuilles de chaque page, suit leurs `@import`, ajoute ses blocs `<style>`,
  et refuse toute page hors de portée — en exigeant une règle *effective*
  (`!important` ou sélecteur composé ; une règle nue perd contre une classe de
  même spécificité déclarée après). Il compare aussi les trois copies au
  caractère, pour qu'une divergence soit un rouge et non une découverte.

**Pourquoi c'est une règle absolue.** `hidden` est un attribut, et le navigateur
le traduit par une règle de SA feuille — `[hidden] { display: none }`. Toute
déclaration d'AUTEUR l'emporte sur elle, parce que la spécificité ne se compare
pas entre origines. Et une règle `[hidden]` nue ne suffit pas non plus :
`[hidden]` et `.btn` ont la même spécificité, donc l'ordre de déclaration
tranche, et la règle du composant vient après. D'où le `!important`.

**Vécu, trois fois le même défaut.** `apps/yield/index.html` (relevé en review),
puis `pages/avis.html` — « le bouton de saisie restait visible, y compris pour
un membre `avis: read` » —, puis `pages/biens.html` le 19 octobre 2026 :
« + Ajouter un bien », masqué par `btn.hidden = !estTitulaireCourant` avec en
commentaire « sinon la création partirait sur le compte du MEMBRE », était
**visible et cliquable** pour un membre délégué.

**Et la troisième fois, le serveur ne refusait pas non plus.** Mesuré sur
staging : un POST de création avec le jeton d'un membre rendait 400 — le refus
de la *validation*, qui vient après la garde — et non 403. La garde était
`requirePermission({ domaine: 'reglages', niveau: 'write' })` sans
`compteDelegue` : sans ressource désignée et sans ce drapeau, le compte cible
retombe sur l'appelant, et tout utilisateur authentifié est titulaire de son
propre compte. **Elle ne filtrait rien, pour personne.** Coût du geste : un bien
sur le compte du membre, et une propriété provisionnée chez le partenaire.

Les deux premières occurrences avaient été corrigées page par page, en ajoutant
la règle manquante — et `shared/ui.css` annonçait même l'avoir « fermé ICI pour
toute la classe de défauts », dans une feuille que 4 pages sur 45 chargeaient.
Détail et audit complet : docs/kb/profils-et-droits.md §13.

## RÈGLE ABSOLUE — UN SECRET NE PASSE JAMAIS PAR LE TERMINAL

- **Un secret s'écrit directement dans son fichier cible.** Il ne s'affiche pas,
  ne se colle pas dans une réponse, ne transite pas par une sortie de commande.
- Ce qu'on affiche d'un secret : le **nom de la variable** et sa **longueur**.
  Rien d'autre. `CRON_SECRET écrit (64 caractères)` est un compte rendu complet.
- Vaut aussi pour la LECTURE : `vercel env pull` écrit les valeurs en clair.
  On ne lit jamais le fichier produit en entier — on liste les NOMS
  (`vercel env ls`), et on supprime le fichier aussitôt.
- Un secret généré pour être posé dans une interface se génère **dans cette
  interface** quand elle le permet, sinon il est écrit dans un fichier local
  hors dépôt que le product owner ouvre lui-même.

**Pourquoi.** Un terminal n'est pas un canal privé : la sortie part dans
l'historique du shell, dans les transcriptions de session, et dans tout ce qui
les archive. Un secret affiché est un secret à faire tourner — le coût n'est pas
l'affichage, c'est la rotation et la fenêtre pendant laquelle l'ancienne valeur
reste valable.

**Vécu (14-15 septembre 2026).** Pendant la préparation du chantier staging,
`vercel env pull` puis la lecture du fichier produit ont exposé quatre secrets de
production en clair, dont `BREVO_API_KEY` et `CLAUDE_API_KEY` — tous deux
facturables. Le `CRON_SECRET` de remplacement, généré pour corriger la fuite, a
été affiché à son tour : le correctif a reproduit le défaut. La règle
« ne jamais afficher un secret » existait déjà en INTERACTION ; ce qui manquait
était le GESTE de remplacement — écrire dans le fichier, rendre compte par le
nom et la longueur.

## RÈGLE ABSOLUE — UNE REVIEW PAR COMMIT, PAS DE BOUCLE
- **Une review par commit.** Si elle trouve un problème de SÉCURITÉ (fuite entre
  comptes, contournement de garde, authentification), on corrige et on re-review
  **une seule fois** les correctifs.
- Tout le reste — mineur, style, durcissement optionnel — se corrige **sans
  nouvelle review**, ou se note au KB comme dette.
- **Deux reviews sans constat de sécurité = on pousse.**
- Vécu : neuf reviews enchaînées sur le même groupe d'endpoints. Les trois
  premières ont trouvé les vraies fuites ; les six suivantes n'ont plus trouvé
  que du durcissement, chaque correctif ouvrant le prétexte d'une review de plus.
  Le coût dépassait le gain, et deux régressions ont été introduites par les
  correctifs eux-mêmes.

## RÈGLES TECHNIQUES DURES (non négociables)
- api/grok.js : NE JAMAIS RENOMMER/SUPPRIMER (wrapper Haiku, legacy Lisa). Utilisé par agent-ai/index.html, messages.html, analyze.html, messagerie.html, extract-kb.js.
- api/cron.js : TOUJOURS généré en fichier COMPLET. Jamais de patch manuel partiel.
- api/simulate.js : ne pas supprimer.
- vercel.json cleanUrls=true : rewrites SANS .html dans la destination (sinon 404).
- Tout code canal via lib/channels/ (getProvider). Jamais Beds24/Channex en dur.
- properties.id = UUID ; property_id des tables enfant = TEXT (provider propId). Ne JAMAIS joindre naïvement uuid vs text.
- room_type/rate_plan Channex stockés dans properties.provider_room_type_id / provider_rate_plan_id.
- SENDVIABEDS24_ENABLED doit être 'true' en prod (sinon envoi Beds24 = DRY RUN silencieux).
- Beds24 token : refresh auto cron 5min. Généré 15 avril 2026, expire 14 juillet 2026.

## GARDE-FOUS PRODUIT
- AUCUN autre bridge CM (Smoobu, Hostaway, Lodgify) ni marque de serrure avant prospect réel.
- inventory_type : seul 'whole' codé. PWA hôte = V2 (après 10+ clients payants).
- Refonte mobile messagerie.html AVANT d'annoncer la messagerie sur la landing.

## 3 BOUSSOLES (challenger toute feature, franc, pas complaisant)
1. Mettre en ligne rapidement. 2. Produit viral et indispensable. 3. Différenciation + résolution douleurs aiguës.

## ÉTAT (fin Session #22)
Certification PMS Channex SOUMISE (formulaire Google enregistré). En attente revue live Channex.

**Chantier AVIS VOYAGEURS CLOS** (lots 1-7) : `ota_reviews` au cœur, poll
quotidien Channex (70 avis), webhook `updated_review`, classification propreté
en deux étages (règle avant IA), page `/avis`, saisie manuelle, et détection
automatique dans les messages entrants — 359 analysés, 5 signalements, 0 faux
positif, avec validation humaine avant tout comptage. Beds24 tranché : 93 avis
Booking.com importés ; les avis Airbnb de ces biens sont hors de portée de
l'API Beds24 et viendront avec leur migration Channex (doc officielle).
168 avis dans le cœur. Bilan et leçons : docs/kb/avis-voyageurs.md §10-11.

**Chantier profils et droits CLOS** (étapes 0-5) : 26/26 endpoints gardés,
10 fuites fermées, sélecteur de compte et masquage par droit livrés et validés en
production. Détail et dettes : docs/kb/profils-et-droits.md §12.
L'étape 6 (fiche prestataire) est fusionnée dans le chantier prestataires.

**Chantier HISTORIQUE DES RÉSERVATIONS CLOS** : le cœur porte le payload
provider intégral (`bookings_snapshot.raw` + empreinte), backfill one-shot
214 → 1436 lignes, 11 ménages fantômes réconciliés, rattachement des avis
5/28 → 24/28. Détail : docs/kb/bookings-snapshot.md §4 bis à §4 quater.

**Chantier RÉSERVATION MANUELLE (phase 2) CLOS** (étapes 1-4) : primitive
d'écriture CRS Channex (`ota_name: "Offline"`), verrou anti-surréservation
(`write_locks` + `inventory_units`) et alarme récurrente qui ne s'éteint que par
acquittement manuel, fiche de réservation et formulaire de saisie dans le
calendrier. **Étape 4 validée par le test réel sur Colomiers le 7 septembre
2026** : création, fiche et annulation depuis l'interface, pipeline complet
traversé. Détail, incident stop_sell et règles gravées :
docs/kb/reservation-directe.md.

Bloquants pré-lancement : (a) ~~/settings 404~~ **fait** + onboarding 2 parcours ;
(b) wiring Stripe ; (c) activation features payantes ; (d) user_id dans INSERT serrures.

**Chantier YIELDFLOW 4.5-4.6 LIVRÉ EN PROD.** 4.5 pilote tarifaire par bien
(53c06eb), 4.6.0 fenêtre glissante et trois états d'une nuit (3d2e8f2), 4.6.1
canal interne (e7cd289), 4.6.2 fermetures de l'hôte (95619a5) — une fermeture
se manipule comme une réservation, modifiée à la main par l'hôte seul, jamais
par une app ; rouvrir une nuit couverte est refusé. **4.6.3 à 4.6.5 en prod le
23 septembre 2026 (3897cb0)** : moteur d'ouverture, moteur de prix, pilote
quotidien et alarmes ; écran « Prédiction de prix » (bouton activé /
désactivé confirmé dans les deux sens), CA sur le bandeau et les tuiles.
Recette du 22 septembre en huit pièces, toutes conformes : une nuit ouverte,
pas encore ouverte, fermée ; une fermeture de l'hôte n'est jamais rouverte par
Yield ; seul l'hôte rouvre ; la fenêtre glisse d'une nuit par jour.
**Deux origines de prix, deux traitements** : les prix du calendrier sont
remplacés par les prédictions à l'activation (la confirmation dit « N nuits
ont déjà un prix au calendrier ») ; les prix posés par le ✎ (`prix_hote`) ne
sont jamais touchés, survivent à la désactivation (dette 22) et leur vie se
trace dans `prix_hote_journal`. Règle de saut du moteur, une seule :
`lib/nuits-du-moteur.js`. Migrations `pilote-fenetre`, `prix-hote`,
`prix-hote-journal` appliquées staging et prod (et `fermetures`, absente en
prod jusqu'au 23 septembre). **La bulle est ACTIVÉE (pilote YieldFlow) depuis
le 23 septembre 2026** ; son reliquat de bascule (476 nuits) a été réparé par
`scripts/defaire-fermeture-bascule.js`. Cœur de vie 23 portait le même reliquat
(786 nuits, lot 2026-09-10T17:17, du 8 déc. 2026 au 31 janv. 2029) : **réparé
le 30 septembre 2026 sur go de Thierry** (même script, incident 16387) ; le
pilote a rouvert 232 nuits avec leur prix jusqu'au 27 juillet 2027 (fenêtre
300 jours). Symptôme vu par Thierry : « il s'ouvre seulement jusqu'à décembre ».
Aussi en prod : UI calendrier et fonctions Vercel en région Paris
(`docs/kb/performance.md`). Spec : docs/specs/spec-yieldflow-v1.md §2 ter.

**Lot V2.0 EN PROD le 23 septembre 2026 (c67eaca)** — durcissement de la V1 et
les demandes de Thierry sur le prix. Tout est au KB `suggestion-yield.md`
§3 bis à §3 quater et `evenements-yield.md` §8 :
- **dette 17 soldée** : l'écran et le moteur passent par la même assemblée
  (`preparerContexte` / `prixDeLaNuit`) ; `scripts/verifier-parite-prix.js`
  compare prix, grille, prime et relèvement (0 divergence sur 440 nuits) ;
  dette 25 soldée (capacité non calculable : le pilote ne tarife rien et le dit).
- **Dates commerciales** : sans historique, une date commerciale garde le
  niveau de sa nuit SOUS-JACENTE (le réveillon 2026 était à 125 € entre deux
  nuits de Noël à 155 €) ; la date passe avant le pont, jamais avant le férié ;
  garde-fou `sous_la_nuit_ordinaire`.
- **Comparable N-1** : les dates commerciales viennent de leur source (plus de
  liste recopiée) ; une nuit de vacances ne se compare jamais à une date
  commerciale N-1.
- **Fourchette Exceptionnel** : bas = prix du niveau, plafond = prix atteint
  par au moins DEUX réservations (La bulle 255 €, Cœur de vie 23 265 €) —
  donnée vivante, borne du cliquet, pas une garantie contre deux ventes
  aberrantes. La prime vient uniquement de la PREUVE (prix obtenu l'an dernier
  sur la nuit comparable), arrondie au pas supérieur ; la pression la retire
  (≤ −25 %) sans jamais ajouter d'euro.
- **Plancher N-1 à tous les niveaux** : même décision que la fourchette ;
  type de nuit b′ (le jour de la preuve se vend au même niveau ou moins bien
  dans la structure hors vacances — « le plancher est un plancher ») ; un jour
  non mesuré refuse ; le délai −1 (14 jours) retire (le prix N-1 a été obtenu
  à un délai inconnu) ; le réglage de l'hôte qui baisse prime ; le niveau
  affiché suit le prix ; 10 € d'écart minimum.
- **REVIEW.md règles 17, 18, 19** : un test peut figer un bug ; une mesure dit
  sa plage ; tout test neuf rougit contre le code d'avant (contre-épreuve par
  `git archive` hors de l'arbre, jamais `git show > fichier`).
Restent au registre (docs/kb/dettes-v1.md) : 20 (le calendrier dit « fermée »
une nuit pas encore ouverte), 21 (nuit rouverte à la main sans prix), 24
(agrandir la fenêtre ne prévient pas), 26 (référence en prix voyageur total,
ménage compris), 27 (le full sync journalise des nuits sans ligne), **28** (le
délai affiné par le « vendu à date » N-1). V2 « nouveau bien sans historique »
cadrée (`docs/kb/chantier-nouveau-bien.md`).

**V2 marché EN PRODUCTION (branche `lot-v2-3-marche-quand`, octobre 2026), EN
AFFICHAGE SEUL.** Pages « Le marché global » et « Choisir vos comparables »
(menu YieldFlow), et colonne « Prix de départ » de la Prédiction de prix, jour
par jour sur 12 mois (§22.11 à §22.13 : ancre × forme, 8 cases, un hôte = une
voix, tranches de YieldFlow, Exceptionnel pour les événements déclarés).
**Rien n'écrit au calendrier ni ne pousse de prix** :
`tests/v2-marche-aucune-ecriture-calendrier.test.js` le garantit. Les 12
migrations V2 sont en production, vérifiées par script (§22.12). Garde-fous
AirROI pour octobre : 25 $ par compte sur 30 jours et 25 $ par mois (dette
53, à redescendre). Seconde capture des calendriers le 5 novembre 2026
(dette 52).

**Lots 4.6.6 et 4.6.7 EN PROD le 30 septembre 2026** (0dc6c25, d557124) :
- **4.6.6 — réduire la fenêtre retire de la vente les nuits qui en sortent**
  (décision de Thierry, option 1 ; dettes 29 et 34 soldées). Enregistrer la
  fenêtre annonce les nuits OUVERTES au-delà de la nouvelle fin (non vendues,
  ✎ et ouvertures à la main compris), exige leur nombre et leurs bornes, réduit
  la fenêtre PUIS les retire : fermées chez le canal par l'écrivain unique
  (`retirerDeLaVente`, lib/calendrier-writer.js), lignes supprimées seulement
  si le canal a accepté — elles redeviennent « pas encore ouvertes » et le
  pilote les rouvre avec leur prix quand la fenêtre les rattrape. Sinon :
  état d'avant rétabli, fenêtre d'avant restaurée ; tout état douteux sonne au
  fondateur avec les dates. Un bien sans plan tarifaire se retire en base
  seulement, et le dit ; Beds24 est refusé. Le canal du moteur relit la
  fenêtre en base avant d'ouvrir. Éprouvé en réel : Cœur de vie 23 (178 nuits
  retirées puis rouvertes, prix Channex = base + supplément voyageurs) et La
  bulle (24 nuits du 31 août au 23 septembre 2027, fermées chez Channex, rien
  d'autre touché).
- **4.6.7 — la grille fixée par l'hôte, niveau par niveau** (décisions de
  Thierry). Table `grille_hote` (+ journal), writer unique
  `lib/yield/grille-hote.js` — PAS `prix_hote`, qui fige une nuit que le moteur
  saute. Point d'application unique : `preparerContexte`, APRÈS le
  positionnement des contextes. Les ajustements (jour de semaine, événements,
  plancher N-1, primes, fourchette) s'appliquent par-dessus ; l'ordre des
  niveaux tient à chaque application (un calculé s'écarte d'un pas, un fixé ne
  bouge jamais) ; « au calcul » (×) n'est jamais refusé ; confirmation « N nuits
  vont changer de prix » comptée par la règle du moteur, grille actuelle
  contre proposée. Le prix recommandé au moment du geste est gardé :
  `grille_hote.recommended_rate_cents`, et `prix_hote.recommended_rate_cents`
  pour chaque ✎. Migration `2026-09-30-grille-hote` appliquée staging et prod,
  prouvée par `scripts/verifier-migration-grille-hote.js`.
- **Staging n'a aucun cron** (docs/STAGING.md §1) : en recette, le pilote se
  lance par `scripts/piloter-yieldflow.js` (à blanc, puis `--go`).

**Refonte UI V5 — lot 2 « Messages » ÉTAPES 1 À 4 + RECETTE 1 GUESTFLOW EN
PROD (12 octobre 2026, 38ed719)** : étape 4 = Test/Auto (confirmation avant
Auto, état RELU en base), épingle et archivage manuel portés (menu ⋯ du fil,
actions gardées), ancienne MESSAGERIE en redirection (dette 43 soldée) —
`config.html` RESTE EN SERVICE (URL seule) jusqu'à couverture 100 % de
l'inventaire GuestFlow (spec lot-messages §12 bis). CHANGEMENT DE PÉRIMÈTRE
(12 octobre) : tout GuestFlow vit dans Messages, en deux recettes. Recette 1
LIVRÉE : tiroir par bien à deux volets portés par deux boutons d'en-tête
(i-scheduled / i-ai) — « Réponses de l'IA » (mode, pause, consignes
agent_prompting écrites insert-puis-delete, garde IA en état, Connaissances,
Alertes en bas : 2 types × 2 canaux, porte Brevo, Tester depuis la base) et
« Messages programmés » (renvoi provisoire). Liste épurée (plus d'extrait ni
de date). `[hidden]{display:none !important}` en tête de ui.css (classe de
défauts fermée). Dettes 66 (origine des envois), 67 (évaluation en
proposition au départ), 68 (réglages IA non délégables, tiroir réservé au
titulaire). Recette 2 LIVRÉE
(volet Messages programmés, parité prouvée sur les 11 messages réels — 0
écart, scripts/verifier-parite-templates.js), puis REDIRECTIONS (go de
Thierry du 12 octobre) : messagerie, config et templates redirigent vers
/messages, sidebar réduite à la Base de connaissance, plus aucune écriture
directe depuis l'ancienne app. **LOT 2 « MESSAGES » CLOS.** Restent au
registre : dettes 66 (origine des envois) et 67 (évaluation en proposition
au départ) — à traiter ensemble avant le lot Calendrier — et 68 (délégation
des réglages IA). étape 3 = Envoyer / Modifier / Rejeter sur les propositions dans
le fil (Envoyer = chemin de l'ancienne page : posterMessage puis clôture
statut+journal par POST /api/messages action=proposition ; statuts
done/ignored, pas de 'rejected' ; statut RELU avant l'envoi — pas de double
message ; badge décrémenté sans rechargement). Dette 66 ouverte (origine
ia_validee/ia_modifiee/hote posée par le writer d'envoi — prérequis « Fait
pour vous », après l'étape 4, avant le lot Calendrier) : d'ici là, bulle
envoyée SANS robot. étape 1 = pages/messages.html en lecture seule (liste + fil),
arrivées du jour/demain en tête avec téléphone composable (+33 rétabli), photo
du bien en avatar, logos de canal aux vraies couleurs (jetons --canal-*),
« à traiter » = séjours à venir/en cours seulement (règle resserrée, module
partagé). Étape 2 = envoi manuel (routage par SOURCE, échec « Non envoyé ·
Réessayer », texte jamais perdu), « Proposer une réponse »
(api/guestflow-proposer.js : génération et garde de coût DU CRON, clés sur la
référence provider, refus parlants), pagination serveur (curseur composite
lastTime+bookId, arrivées j/j+1 toujours en première page), état lu
(conversation_flags.read_at, migration appliquée staging ET prod, writer
unique POST /api/messages action=lu). Ancienne messagerie : URL seule, aucun
menu. Inventaire : spec lot-messages §12. KB : docs/kb/messages-v5.md.
Étapes 3-4 à venir (Envoyer/Modifier/Rejeter dans le fil ; Test/Auto +
redirection). Lot photos LIVRÉ le 10-11 octobre
(properties.photo_url, bucket property-photos, fiche /biens ; dette 65).

**Chantier REFONTE UI V5 — lot 1 LIVRÉ (10 octobre 2026, branche
`lot-ui-v5-1`)** : socle (shared/theme.css seul porteur d'hexas, ui.css,
icons.svg, nav.js 5 entrées, i18n fr/en/es) et `pages/aujourdhui.html` devenue
l'accueil (index.html et /dashboard redirigent). Faits comptés seulement :
« À valider » restreint aux conversations ouvertes (49 → 1 ce jour-là), notes
affichées /5 (le cœur stocke /10), tuile codes retirée (dette 62, user_id
absent de l'INSERT serrures), min/max mensuel depuis le premier mois vendu.
Menu ≡ : section « Outils » PROVISOIRE, retirée lot par lot. Dette 59
(canaux au cœur) = PRÉREQUIS du lot Logements. Recette du jour : 5 résas de
test Colomiers annulées par le CRS, deux blocages saisis comme résas passés
`blocked` (dettes 63-64). KB : docs/kb/aujourdhui.md.

**Refonte UI V5, lot Calendrier : ETAPE 1 + retouches EN PROD le 13 octobre
2026 (963d05d).** Depuis e8ed91d : barres PLEINES (l'essai contour est
referme), telephone restructure comme l'ancien mobile (barres en demi-cases
par semaine, pastille noire aujourd'hui, mois + selecteur STICKY en tete,
multi-biens EMPILES avec delimitation, bulles = AJOUT), la ligne de donnees
de l'ordinateur suit le SELECTEUR DE VUE partage (les lignes a cocher ont
disparu), dates reservees non grisees, ORDRE des biens par glisser (poignee
du bandeau, tactile + souris) — liste etat.choisis persistee COMMUNE aux
deux ecrans.

**Redirections FAITES le 13 octobre 2026 (4a108e5, go de Thierry)** :
biens-calendrier.html et calendrier-mobile.html redirigent vers /calendrier ;
redirects declaratifs vercel.json (/biens/:id/calendrier -> /calendrier?bien=:id,
honore par la V5 : le bien demande s'affiche en tete). Les ~96 garde-fous des
anciennes pages sont RETARGES sur la V5 (11 fichiers de tests — les gardes
SERVEUR de reservation-directe restaurees apres review). Multi-biens au
telephone (calendriers EMPILES, bulles = ajout), ordre des biens par GLISSER
(poignee du bandeau), vue partagee par selecteur, fiche enrichie (detail
?booking=). Suite : 4988 tests dont 28 rouges attendus. EN SUSPENS (Thierry
tranche) : le SURVOL DE COLONNE de l'ancien planning (demande du 21/09)
n'existe pas en V5 — a reporter ou abandonner.

(Bloc d'origine :) `/calendrier` (pages/calendrier.html, contrat partage
shared/calendrier-contrat.js, orphelines shared/nuits-orphelines.js) : grille
par blocs de bien (nom hors cadre, 2 lignes de contenu, vignette supprimee puis
bandeau photo 28), 4 etats en couleur (vendue = la BARRE seule a l'ordinateur,
le gris reste au telephone), barres en CONTOUR couleur canal (booking = --info,
direct = --ok ; prenom, total au survol), selecteur de biens masques dans
l'angle de la bande, lignes optionnelles cochees au menu ... (par defaut
Reservations + Prix), fiche enrichie par GET /api/calendar?booking=
(coordonnees TITULAIRE SEUL, date de vente, detail du prix : total voyageur
via prixVoyageur, taxe de sejour via taxeSejourDe, frais Airbnb = retenue
hote ; kb synchronisation.md §8 ter). Le frais de SERVICE voyageur Airbnb
n'est transmis par aucun canal. ANCIENNES pages calendrier INTACTES : la
redirection viendra sur go explicite de Thierry. Restent : recette mobile a
poursuivre, etapes 2-4 de la spec (volets Prix/Evenements/Bilan/Marche,
marques ~ et ✎). Banc local : ~/.cache/hotesmart-banc (hors depot).

Chantier prestataires EN COURS. Lot 3 (assignation par journee) **LIVRE EN
ENTIER** : 3.1 dispos RRULE, 3.2 `garde.js`, **3.3 le moteur consomme la
garde** — `requires_ack` remplace `rang === 1` partout, proposition posee a
l'approche du depart (7 jours) et notifiee, escalade automatique au refus et a
l'expiration en sautant qui a deja refuse, alerte sur trou de garde seulement ;
**3.4 l'ecran du planning de garde** et **3.5 les jours attitres + « Mes
disponibilites »**, tous deux en production le 14 octobre 2026 dans la refonte
V5. `apps/menages/garde.html` est ferme depuis, ses seize garde-fous transposes
(voir plus bas).

**LOT MENAGES V5 EN PRODUCTION le 14 octobre 2026 (66064f9).** La page
`/menages` (bulle « A traiter », calendrier de garde, volet Equipe, fiche
menage et sa note, fenetre de configuration d'une prestataire a deux onglets)
et l'ACCUSE DE LECTURE : bouton « Vu » dans la bulle du bien sur la page de la
prestataire, alerte « Pas vu » chez l'hote, deux relances SMS a 9 h (la veille
et le jour meme). Migrations `2026-10-14-menage-vu-le` et `-vu-par` appliquees
staging ET prod, prouvees par `scripts/verifier-migration-menage-vu-le.js`
(prod : 28 validations rattrapees sur 28, 0 sans auteur).

⚠ **Regle gravee : une validation ne vaut que pour QUI l'a posee**
(`menages.vu_par = provider_id`). Un menage qui change de main perd la
validation de la precedente — sinon l'hote lit « A jour » sur quelqu'un qui n'a
jamais rien lu. C'est la DONNEE qui porte son proprietaire, pas les six chemins
d'ecriture de `provider_id` qui pensent a la remettre a zero.

⚠ **ETAPE 4 : UN ECRAN FERME, UN RESTE.** La navigation principale
(`shared/nav.js`, `pages/aujourdhui.html`, sidebar) mene a `/menages`, et
**`apps/menages/index.html` est une redirection** depuis le 14 octobre 2026 :
la fiche V5 porte desormais les QUATRE gestes d'assignation (« Proposer » —
le defaut du serveur —, « Assigner », « Retirer la proposition », « Personne »),
et ce que l'ancien ecran faisait d'autre, la V5 le fait mieux (la note passait
en ecriture RLS directe ; « Marquer fait » n'ecrivait que dans le localStorage).

- `apps/menages/garde.html` est **ferme aussi** (14 octobre 2026). Ses SEIZE
  garde-fous de rendu ont ete transposes un par un vers `pages/menages.html`
  dans `tests/garde-endpoint.test.js`. **Deux choses ne sont pas reprises, et
  c'est assume** (l'inventaire les signalait deja) : la REMPLACANTE du jour et
  le DETAIL DU JOUR agrege — le clic ouvre la fiche d'UN menage. L'endpoint
  continue de rendre la remplacante, et un test garde ce contrat.
- `apps/menages/prestataires.html` reste : la saisie de la **recurrence A/B** y
  vit encore, atteinte par « Corriger pour elle ». C'est le dernier ecran du
  domaine a reprendre.

## ⚠ DETTE SOLDEE LE 17 OCTOBRE 2026 — LA SUITE EST A ZERO ROUGE

**5249 tests, 5249 verts.** Les quatre familles decrites ci-dessous ont ete
reparees par la regle qu'elles illustraient : *dates relatives si le test lit
l'horloge, dates figees s'il injecte le temps.*

| fichier | rouges | ce qui a change |
|---|---|---|
| `tests/booking-changes.test.js` | 8 | le sejour par defaut de `snap()` devient a venir ; les tests de la garde gardent leurs dates figees, ils INJECTENT `AUJOURDHUI` |
| `tests/messages-classify.test.js` | 10 | le message de reference est date d'il y a deux jours |
| `tests/avis-endpoint.test.js` | 6 | les avis de reference suivent l'horloge ; les avis volontairement ANCIENS (`2024-01-01`) restent figes, c'est leur role |
| `tests/menages-public-filtre-presta.test.js` | 4 | les deux sejours sont relatifs, l'un partant aujourd'hui |

**Deux pieges trouves par la contre-epreuve, et pas par la suite :**
`JOURS=N node --require ./tests/outils/horloge-decalee.js --test …` a montre
que `tests/disponibilites-endpoint.test.js` — vert ce jour-la — rougissait a
J+30, J+45, J+60 et J+90. Deux causes, toutes deux invisibles a la lecture :
un **mois demande fige** (`2026-11`) alors que l'endpoint ne calcule que des
mois a venir, et des jours designes par leur **numero** (« le 16 ») dans des
tests qui posent une regle « du lundi au vendredi » — le 16 n'est un lundi
qu'un mois sur sept. Les deux sont ancres : mois courant + 1, et de VRAIS
lundis calcules. Eprouve a J+15, 45, 60, 75, 120, 200 et 400 : zero rouge.

**La regle de comptage devient donc : ZERO.** Un seul rouge est un vrai rouge.
Et la contre-epreuve a horloge decalee n'est plus un outil de diagnostic, c'est
la seule facon de savoir si un test neuf tiendra dans deux mois.

⚠ **IL RESTE UN ROUGE A J+60**, hors du domaine menage :
`tests/airroi-client.test.js` — « LE TEST QUI COMPTE (SECURITE, review de
f40ee9e) ». Il calcule pourtant sa fenetre relativement : la cause est
ailleurs, probablement dans une fixture sur disque qui ne suit pas. C'est le
chantier marche, donc YieldFlow : a reprendre avec le go de Thierry.

## CE QUI SUIT EST L'HISTOIRE DE CETTE DETTE, gardee pour la lecon

## DETTE DATEE — 28 TESTS ROUGES PERMANENTS (soldee le 17 octobre 2026)

⚠ **LE COMPTE ATTENDU EST ZERO. MISE A JOUR DU 19 OCTOBRE 2026, DEMANDEE PAR
THIERRY.** Le titre disait « soldee » depuis le 17 octobre, mais la regle de
comptage, plus bas, disait encore « 28, et exactement 28 ». Les deux ne pouvaient
pas etre vrais, et c'est la version haute que tout le monde lit en premier.

**Mesure du jour**, sur `dette-59-canaux-coeur` (qui contient `main`) : suite
complete a **5346 tests, 5346 verts, zero rouge** ; et les quatre fichiers des
quatre familles, lances seuls, a **133/133**. La dette a ete refermee par
`70f805d` (« Tests : la dette des 28 rouges est soldee »).

**Ce que ca change : TOUT ROUGE EST UNE REGRESSION.** Un compte attendu de 28
contre zero reels n'etait plus une barriere, c'etait un chiffre qui faisait
hausser les epaules — exactement le defaut que cette section dit elle-meme de
ne jamais laisser s'installer. Avant tout push : lire le compte. **Un seul
rouge = on ne pousse pas** tant qu'on ne l'a pas nomme.

**L'histoire qui suit est conservee**, parce que la maladie peut revenir et que
savoir la reconnaitre — avec son outil de contre-epreuve calendaire — vaut pour
tout test a dates figees.

---

**Constat du 13 septembre 2026.** `tests/booking-changes.test.js` (6) et
`tests/booking-changes-dispatch.test.js` (2) echouent depuis la nuit du 12 au
13 septembre.

⚠️ **REPARTITION MISE A JOUR LE 14 SEPTEMBRE 2026 : les 8 sont desormais TOUS
dans `tests/booking-changes.test.js`**, et `booking-changes-dispatch.test.js`
est repasse a 20/20. Le TOTAL n'a pas bouge — la regle de comptage tient — mais
la repartition, elle, a glisse : deux tests de dispatch ont gueri pendant que
deux tests de `booking-changes` franchissaient a leur tour la garde
d'anciennete. C'est le comportement attendu d'une dette a dates FIGEES : elle se
deplace au fil des jours. La noter evite qu'on lise « dispatch est rouge » dans
six semaines et qu'on cherche une panne la ou il n'y en a pas.

**Ce ne sont pas des regressions** : les fixtures portent des
dates FIGEES (sejour du 1er au 5 septembre 2026) et viennent de franchir la
garde d'anciennete `JOURS_DE_GRACE = 7` de `lib/booking-changes.js`. Au-dela,
`sejourTermine()` rend `true` et `detectChange()` rend `null` : les tests
comparent donc `null.type` et levent.

**Pourquoi ca ne peut pas rester.** Huit tests rouges en permanence, c'est une
alarme qu'on apprend a ignorer — et le jour ou un NEUVIEME echec apparait,
personne ne le voit. Une suite de tests ne vaut que si son vert veut dire
quelque chose.

**Comment les corriger** (meme famille que les 6 tests de
`cleaning-sync-menages-entite.test.js`, deja notee ci-dessous) : ces tests
n'injectent PAS `maintenant`, ils lisent l'horloge. Regle du depot : *dates
relatives si le test lit l'horloge, dates figees s'il injecte le temps.* Deux
voies, a trancher a la session dediee — rendre `detectChange` injectable comme
`sejourTermine` l'est deja, ou calculer les fixtures relativement a aujourd'hui.

**Session dediee AVANT la cloture de la V1 YieldFlow.** Ne pas les corriger a la
volee dans un commit de lot : un test a dates figees se repare avec la regle en
tete, pas en decalant les dates d'un mois.

⚠️ **COMPTE ACTUALISE LE 20 SEPTEMBRE 2026 : 21, EN TROIS FAMILLES.**
Le 18 septembre la suite etait a 8 ; le 20, a 21 — sur le MEME commit, sans
qu'une ligne ait change. Les 13 nouveaux ne sont pas des regressions : c'est la
meme maladie des dates figees, sous une autre forme. Contre-epreuve faite par
deux sessions independamment : decaler les fixtures d'un mois les remet TOUS au
vert, sans toucher une ligne de production.

| famille | fichier | rouges | ce qui se declenche |
|---|---|---|---|
| 1 | `tests/booking-changes.test.js` | **8** | garde d'anciennete `JOURS_DE_GRACE = 7` (sejour termine) |
| 2 | `tests/avis-endpoint.test.js` | **6** | fenetre glissante de 30 jours de `api/avis.js` (`periodeNormalisee` → `borneDepuis`) : AVIS_B du 20 aout vient d'en sortir ; le 29 septembre, trois de plus (« un avis NON analyse… », « un membre limite a un bien… », « une detection en attente… ») — contre-epreuve +1 mois : 5 des 6 au vert, le 6e casse par le decalage lui-meme (la date invalide 02-30 devient valide) |
| 3 | `tests/messages-classify.test.js` | **10** | meme fenetre : le message du 20 aout est ecarte AVANT la garde de panne DB, donc la garde n'est jamais appelee — elle mord toujours |
| 4 | `tests/menages-public-filtre-presta.test.js` | **4** | fenetre glissante de 14 jours du fil d'actualites (`api/menages-public.js`, « on remonte aussi les 14 derniers jours ») : le menage `b1` du 6 septembre en est sorti le 21 (constate le 21 septembre 2026, contre-epreuve +1 mois : 20/20) |

Les familles 2 et 3 franchissent une FENETRE DE LECTURE, pas une garde
d'anciennete — c'est ce qui les rend penibles : elles se declenchent a des
dates qu'aucun de nous n'a en tete. La regle du depot vaut pour les trois :
*dates relatives si le test lit l'horloge, dates figees s'il injecte le temps.*
**La session dediee pour solder les TROIS familles reste due avant la cloture
V1.** Un chiffre qui bouge tout seul avec le calendrier est un mauvais
garde-fou : l'actualiser n'est qu'un sursis.

**REGLE DE COMPTAGE, POSEE LE 14 SEPTEMBRE 2026 (demande de Thierry).**
⚠ **UNE CINQUIEME FAMILLE A EXISTE LE 1er OCTOBRE 2026, ET ELLE A ETE REFERMEE
LE JOUR MEME** — deux tests de `tests/pwa-mes-jours-dom.test.js` qui tapaient
`dans(-3)`, hors du calendrier rendu les 1er, 2 et 3 du mois. Le compte est
redevenu **28, et exactement 28**. Ce qu'il faut en retenir : un compte a
geometrie variable est une barriere affaiblie. Le jour ou une vraie regression
apporte deux rouges un 2 du mois, un compte attendu de « 30 ces jours-la » ne
fait arreter personne. **Documenter un rouge calendaire est le dernier recours ;
ancrer le test dans sa fenetre est le premier.**

⚠ **ET LA CONTRE-EPREUVE CALENDAIRE A UN OUTIL**, parce que la faire a la main
donne de faux resultats : `tests/outils/horloge-decalee.js`, a PRECHARGER
(`JOURS=10 node --require ./tests/outils/horloge-decalee.js --test <fichier>`). Il
decale l'horloge de Node **et celle de la fenetre jsdom**, qui vit dans un autre
realm. Decaler les fixtures seules, ou le seul global de Node, fabrique des
echecs qui n'ont rien a voir avec le calendrier : mesure du 1er octobre 2026,
8 et 10 rouges contre 132/132 par l'outil. Il a fallu deux sessions comparant
leurs mesures pour le voir.

Le nombre attendu **a ete** 28, et exactement 28 (8 + 6 + 10 + 4, au
29 septembre 2026 — il etait 8 jusqu'au 18, 21 le 20, 25 du 21 au 28), jusqu'a
ce que `70f805d` solde les quatre familles. ⚠ **IL EST MAINTENANT ZERO** (voir
l'encadre en tete de cette section). Avant tout push : lire le compte, pas la
couleur. **Un rouge = une regression, on ne pousse pas** tant qu'on ne l'a pas
nommee ; et si une famille calendaire reapparait un jour, on remet son compte
ici pour qu'elle reste protegee. Et un compte qui MONTE sur un commit inchange
se contre-eprouve avant d'etre pris pour une regression : decaler les fixtures
d'un mois, relancer, restaurer l'arbre — si tout repasse au vert, c'est le
calendrier, et on l'ajoute au tableau ci-dessus avec sa cause. C'est la meme discipline que le `ATTENDU` de
`tests/bookings-snapshot-troncature.test.js` : une exemption se COMPTE, elle ne
se decrit pas.

Vecu le jour meme : le correctif de la garde des cles migrees a fait passer la
suite a 9 rouges. Le neuvieme etait une vraie rechute — une lecture de
`bookings_snapshot` ajoutee sans borne dans un script neuf, donc tronquee a
1000 lignes sans erreur. Sans le comptage, elle se serait noyee dans « les 8
rouges habituels ».

Prochain chantier (court, avant la phase 3) : **audit stop_sell** —
docs/specs/spec-audit-stop-sell.md. Principe grave : le coeur memorise
l'INTENTION commerciale de l'hote par jour et par bien, toute poussee
d'inventaire la restitue, seul un geste volontaire de l'hote la met a jour ;
le stop_sell est une decision MEMORISEE, le stock une consequence CALCULEE.
La memoire est `calendar_inventory` (writer unique : api/calendar.js POST) mais
elle est vide d'intention (0 ligne stop_sell=true, 1 bien sur 4) — la rendre
vraie est l'etape 0. Inclut le fix des 6 tests a dates figees de
tests/cleaning-sync-menages-entite.test.js.

Ensuite : prestataires (fiche + convergence des deux populations +
les 5 dettes du §12). La fiche prestataire consommera `ota_reviews` : décision
déjà gravée dans docs/specs/spec-prestataires-menage.md §6 — l'extrait de
propreté est montré à la prestataire, mais l'extrait SEUL, jamais le nom du
voyageur, étiqueté « retour privé » quand il en vient, et coupé par
`self_view_reviews`.

## DOC REPO — LIRE AVANT DE CODER
- docs/CALENDRIER_TECH.md (calendrier) | docs/CHANNEL_TECH.md (Channex) | pages/guide.html (guide user, alimenter à chaque feature).
- docs/kb/aujourdhui.md (accueil V5 : source de chaque chiffre, ce qui n'est PAS affiché et pourquoi ; socle UI V5 dans shared/theme.css, ui.css, icons.svg, nav.js, i18n/ — aucun hexa, aucun texte en dur, aucun emoji, `node scripts/i18n-check.js` avant commit).
- docs/kb/coeur-de-donnees.md (règle d'architecture : provider → cœur → apps ; config d'app vs config générale).
- docs/kb/cout-du-cron.md (le COUT du cron par tache et par passage : compteur pose sur `fetch` — une exception mesuree, le SDK Anthropic ; `ms` contre `ms_seul` ; table `cron_stats` purgee a 30 jours ; carte 20 du diagnostic et `scripts/classement-cron.js`).
- docs/kb/dettes-v1.md (REGISTRE des dettes datées avant la clôture V1 : 28 rouges, migrations à appliquer, vacances 2027, mobile et fermetures — chaque lot lit sa ligne avant merge).
- docs/kb/profils-et-droits.md (droits, délégation, dettes) | docs/kb/audit-user-id-front.md (identité vs compte, endpoints délégables).
- docs/kb/prix-plancher.md (garde anti nuit a 0 : `properties.prix_minimum` par bien, repli 10 € ; on FERME la date, on ne remonte jamais le prix ; `rate: 0` n'est pas applique par Channex, il garde le prix de la grille).
- docs/kb/evenements-yield.md (vacances scolaires importees/cachees par zone ; jours feries CALCULES, aucune table ; OpenAgenda ecarte de la V1, sur mesure).
- docs/kb/indicateurs-yield.md (LA SOURCE DE VERITE EST LE COEUR, jamais Excel ; « calculable » n'est pas « divisible » ; convention capacite ESTIMEE pour le passe, drapeau dans la donnee).
- docs/kb/eclatement-yield.md (socle du moteur : prix voyageur par provider/canal, repartition UNIFORME — le differentiel week-end vit dans price_display_log, pas dans l'eclatement ; pont demapped ; nuits en exception MARQUEES).
- docs/kb/capacite-yield.md (denominateur du TO : jour ouvert = intention memorisee ; absence de ligne = ferme ; « non calculable » n'est JAMAIS zero).
- docs/kb/price-log.md (journal des prix affiches : NON RETROACTIF, une ligne par changement REEL, une seule ligne courante par bien/nuit ; cle sur properties.id, exception raisonnee a la regle 10).
- docs/kb/suggestion-yield.md (`null` n'est jamais une reponse, et « je ne sais pas » n'est pas « non » — deux motifs distincts ; la grille 5 niveaux est faite de quantiles des prix REELLEMENT obtenus ; le jour de semaine est une COUCHE finale, pas un axe ; tester l'INVARIANT plutot que la ligne).
- docs/kb/restitution-yield.md (l'ecran : un `null` s'affiche « non calculable » AVEC son motif, jamais 0 ni tiret ; les 41 motifs traduits, liste DERIVEE du moteur et non recopiee ; un drapeau systematique passe en legende, pas sur chaque ligne).
- docs/kb/pickup-yield.md (le « a date » : pivot N-1 en JOURS pour une periode a venir, meme jour calendaire pour une periode commencee ; le N-1 est RECONSTRUIT donc sous-estime ; « ferme a la vente » n'est pas « n'a rien vendu », des DEUX cotes).
- docs/kb/reference-yield.md (un jour = UN segment par priorite ; cascade de repli a 4 niveaux, plancher = jour de semaine ; deux seuils, 8 nuits ET 3 resas ; `part_vendue` est une part de VENTES, on extrapole le final, on ne multiplie jamais la capacite).
- docs/kb/prix-voyageur.md (QUEL champ = prix paye par le voyageur : `amount` Channex/Airbnb est un NET HOTE (ecart +22,85 %), reconstruire via `meta.amount_type` — jamais via le nom du canal ; dates de vente : comparer les JOURS, pas les instants).
- docs/kb/avis-voyageurs.md (ota_reviews : clé Channex unique = cloisonnement par properties, dette 11/70 levée par l'historique des réservations ; classification propreté en 2 étages, règle avant IA).
- docs/specs/spec-performance-pages.md (**la mesure de chaque ecran, et l'ordre des lots** : les categories de chaque donnee affichee, les 5 tables de resume et leurs declencheurs, les deux interdits de cache, le budget par ecran. ⚠ Une decision y attend Thierry : marqueur + cron, ou recalcul immediat par le dispatcher — le lot (c) ne demarre pas sans elle.)
- docs/specs/rotation-deroule.md (**LE DÉROULÉ QUI FAIT FOI pendant une rotation de secret** : `CRON_SECRET` puis `CHANNEL_WEBHOOK_SECRET`, geste par geste, avec la vérification que je fais à chaque pas et la fenêtre de refus d'une minute).
- docs/specs/rotation-secret-webhook.md (le POURQUOI de la rotation du secret de webhook, et l'historique du piège : une version de ce document a affirmé le contraire du code. **En cas de divergence, le déroulé ci-dessus gagne, et celui-ci se corrige dans le même mouvement.**)

## VALIDATION
- `node -c fichier.js` valide la syntaxe CommonJS avant commit.
- **Lignes SQL courtes : seulement pour le collage manuel.** Du SQL collé à la
  main dans l'éditeur Supabase se coupe en lignes < 60 caractères (trois échecs
  de troncature). Une migration versionnée de `migrations/`, appliquée par
  outillage, est en **format libre** : la contrainte ne la concerne pas.
  Origine de la règle : docs/specs/spec-yieldflow-v1.md §470.
- Après push : attendre que le Deployment ID Vercel change avant de tester le cron prod.

### APRÈS CHAQUE PUSH — VÉRIFIER QU'UN DÉPLOIEMENT EXISTE POUR CE SHA

⚠⚠ **AVANT DE DIAGNOSTIQUER UN WEBHOOK PERDU : LIRE LES DEUX PAGES D'ÉTAT.**
`githubstatus.com` et `vercel-status.com`. Une sortie vide n'est pas forcément
notre dépôt, ni un réglage : le 21 octobre 2026 c'était un incident GitHub
ouvert — *Delays for Pull Requests and Webhook deliveries*, composant
**Webhooks en Degraded Performance**. Trois heures de diagnostic côté dépôt
pour une panne qui était affichée en ligne. **Ce coup d'œil coûte dix secondes
et se fait AVANT tout le reste.**

⚠ **ET UNE LIVRAISON RETARDÉE N'EST PAS UNE LIVRAISON PERDUE.** Les webhooks du
21 octobre sont tous arrivés, avec deux à trois heures de retard, et Vercel a
promu la production **dans l'ordre des pushes** : `a73b905` à 15:27, `8551264` à
15:31, `76d1791` à 15:35, `707af03` à 15:38. Conséquence à surveiller : pendant
un rattrapage, **un push ancien peut être livré après un récent** et promouvoir
un ANCIEN commit en production. Après un incident de ce type, vérifier que le
dernier déploiement de production porte bien la tête de `main`, et pas un SHA
d'avant.

**INCIDENT CLOS LE 21 OCTOBRE 2026 À 16:57, et l'alerte qui vivait ici est
retirée** — le déroulé normal est revenu : on pousse, le déploiement sort tout
seul, on vérifie le SHA. Les deux moitiés de la condition de retrait ont été
mesurées : `githubstatus.com` *All Systems Operational* (Webhooks repassé
`operational`), ET le push de `19945bd` déployé **tout seul en 33 secondes**,
la cadence d'avant l'incident.

⚠ **ET LES DEUX NE SONT PAS ARRIVÉES ENSEMBLE : le chronomètre a précédé la page
de 17 minutes.** Les livraisons étaient déjà normales (33 s) alors que la page
annonçait encore Webhooks en `degraded_performance`. « Degraded » veut dire que
CERTAINES livraisons traînent, pas toutes. Donc le vert de la page dit la fin de
l'incident, pas ce qui nous arrive : **ce qui mesure notre cas, c'est le
chronomètre sur notre propre push.** Lire la page pour savoir s'il faut chercher
chez nous ; lire le chronomètre pour savoir si on peut avancer.

**Mesuré, trois pushes de suite sur `main`, chacun bouclé 120 secondes puis
réinterrogé à 5 et 8 minutes : ZÉRO déploiement.** `981d453` (lot logements),
`a73b905` (lot i18n), `8551264` (ce document). Statut GitHub `pending`, zéro
check-run, sur les trois. La ref, elle, avançait bien à chaque fois —
`git ls-remote` le confirmait.

⚠ **ET CE N'EST PAS PROPRE À `main` — PREMIÈRE CONCLUSION, FAUSSE, CORRIGÉE UNE
HEURE PLUS TARD.** J'avais écrit ici que `main` seul était touché, parce que les
pushes de `staging` et des branches de lot avaient tous eu leurs deux
déploiements en 35 secondes. L'asymétrie était réelle, mais elle n'était pas la
cause : elle était **chronologique**. Le push de `channex-phase1` — une branche
ordinaire, pas `main` — n'a rien produit non plus.

**La vraie chronologie, telle que l'API la donne :**

| heure | ref poussée | déploiements |
|---|---|---|
| 12:01 | branche de lot (`c7be709`) | 2, en 35 s |
| 12:48 | `staging` (`34969a2`) | 2, en 35 s |
| **12:51** | `staging` (`a2ec6f1`) | **2 — le dernier qui a marché** |
| ~14:35 | `main` (`981d453`) | 0 |
| ~14:55 | `main` (`a73b905`) | 0 |
| ~15:05 | `main` (`8551264`) | 0 |
| ~15:15 | `main` **et `channex-phase1`** (`76d1791`) | 0 |

**Tout push postérieur à 12:51 n'a rien produit, quelle que soit la ref.** Ce
n'était donc pas un réglage de branche.

⚠ **ET MA DEUXIÈME CAUSE ÉTAIT FAUSSE AUSSI.** J'avais écrit ici qu'il fallait
regarder « l'installation de l'application GitHub de Vercel, puis l'état de la
plateforme Vercel, puis les limites du compte », et j'avais conclu à un ticket
Vercel. **C'était un incident GitHub**, trouvé par Thierry sur
`githubstatus.com` : *Delays for Pull Requests and Webhook deliveries*, composant
Webhooks en Degraded Performance. Ni Vercel, ni notre dépôt, ni un réglage — et
aucun ticket à ouvrir. Les livraisons sont arrivées d'elles-mêmes deux à trois
heures plus tard.

**Deux fois de suite j'ai cherché la cause dans le système que je pouvais
inspecter** — d'abord la branche, puis le dépôt et Vercel — au lieu de regarder
d'abord si le fournisseur annonçait une panne. D'où la règle en tête de cette
section. Pendant l'incident, le geste manuel est le déroulé, pas un rattrapage,
**et il vaut aussi pour `staging`** : une recette se déploie à la main elle
aussi.

⚠ **LA LEÇON DE MÉTHODE, PARCE QU'ELLE SE REJOUERA.** Trois pushes sur `main`
sans déploiement et cinq pushes d'avant avec, ça dessine une asymétrie par
BRANCHE qui saute aux yeux — et qui était un artefact. La variable cachée était
le TEMPS : tous les succès étaient avant 12:51, tous les échecs après. Le
contre-test qui l'a montré coûtait un push sur une branche ordinaire. **Avant de
conclure « c'est propre à X », pousser une fois sur non-X.**

⚠ **LA SONDE QUI TRANCHE N'EST PAS L'API, C'EST LA PRODUCTION.** `981d453`
avait sa ref en place et `https://hotesmart.vercel.app/logements` rendait **404**
alors que la route venait d'entrer dans `vercel.json`. Après le
« Create Deployment » : **200**. Interroger une URL que le lot vient d'ajouter
coûte une seconde et ne ment pas.


```bash
SHA=$(git rev-parse <branche>)      # ⚠ le SHA COMPLET, 40 caractères
gh api "repos/thierrynzaramba-stack/hotesmart/deployments?sha=$SHA" \
  --jq '.[].environment'
```

La sortie doit contenir l'environnement visé — `Production – hotesmart-staging`
pour un push sur `staging`, `Production – hotesmart` pour `main`.
**Sortie vide = aucun déploiement = webhook perdu**, et le site continue de
servir l'ancien code sans que rien ne le signale.

⚠ **ET IL FAUT LAISSER PASSER UNE MINUTE AVANT DE CONCLURE.** Le déploiement
apparaît en général en dix à quinze secondes, mais pas toujours : mesuré le
19 octobre 2026, la même commande rendait **vide à 25 secondes** et les deux
environnements à 45. Un déroulé qui fait crier au loup trop tôt se fait ignorer
— et la conclusion fausse coûte ici un commit vide sur `staging` pour rien.
Boucler jusqu'à deux minutes, puis conclure.

⚠ **LE SHA DOIT ÊTRE COMPLET.** Un SHA abrégé (7 ou 10 caractères) fait rendre
`[]` **en silence** : on lit « webhook perdu » là où le déploiement existe.
Mesuré le 19 octobre 2026, sur un déploiement bien présent.

⚠ **ET LA SORTIE NON VIDE N'EST PAS DAVANTAGE UNE PREUVE : ON ATTEND
L'ENVIRONNEMENT PAR SON NOM.** Un push sur `staging` produit **deux**
déploiements, et ils n'arrivent pas ensemble — la `Preview – hotesmart` (projet
de PRODUCTION, qui construit toutes les branches) devance le
`Production – hotesmart-staging`. Une boucle qui sort dès que la commande rend
une sortie **non vide** s'arrête donc sur le mauvais déploiement, et conclut
« il manque » pour celui qu'on attend. La règle ci-dessus — « sortie vide =
webhook perdu » — ne couvre pas ce cas, et c'est ce qui le rend coûteux : on
croit l'avoir appliquée.

```bash
SHA=$(git rev-parse <branche>)      # le SHA COMPLET, toujours
for i in $(seq 1 14); do
  OUT=$(gh api "repos/thierrynzaramba-stack/hotesmart/deployments?sha=$SHA" \
        --jq '.[].environment')
  echo "$OUT" | grep -q "hotesmart-staging" && break   # le NOM, pas la non-vacuité
  sleep 10
done
```

**Vécu le 27 octobre 2026**, push de `160fea7b` sur `staging` :
`Preview – hotesmart` créée à 09:40:25Z, `Production – hotesmart-staging` à
09:40:44Z — **19 secondes d'écart**. La première sonde, sortie à 30 secondes sur
la preview seule, a fait annoncer un webhook perdu et dire au product owner de
ne pas commencer sa recette ; la seconde, ancrée sur le nom, a trouvé les deux à
10 secondes. **Les deux pages d'état étaient au vert, et c'était le bon indice
que la cause était chez nous** — on lit la page pour savoir s'il faut chercher
chez nous, le chronomètre pour savoir si on peut avancer.

**Et la sonde qui tranche reste la production elle-même.** Avant le second
déploiement, `/pages/aujourdhui` rendait 84 635 octets — l'ANCIENNE page, en
200, sans rien qui le signale — et le `fr.json` servi n'avait pas la clé que le
lot venait d'ajouter. Après : 88 850 octets, et la page identique à l'octet à
l'arbre fusionné. **Comparer l'empreinte de ce qui est SERVI à celle de l'arbre
qu'on a poussé coûte une seconde et ne se trompe jamais** ; le compte de
déploiements, lui, dit seulement qu'un build a eu lieu.

**Vécu (19 octobre 2026).** Le push de `ddeb7cf` sur `staging` n'a produit
**aucun** déploiement, sur aucun des deux projets : zéro déploiement, zéro
statut, zéro check-run. Les quatre pushes précédents de `staging` avaient
chacun le leur, et le push *suivant* — sur une autre branche, neuf minutes plus
tard — a bien déclenché les siens. Le webhook de ce push précis n'a jamais été
reçu. Coût : six minutes à croire à un build lent, puis à un build en échec,
avant de découvrir qu'il n'y avait pas de build — et une recette qu'on allait
lancer sur l'ancien écran.

**Comment le rattraper.** Un re-push à l'identique ne met à jour aucune ref,
donc ne réveille rien.

**Le geste, c'est « Create Deployment » depuis le tableau de bord Vercel**, en
désignant la **branche** (ou le SHA). Il construit le commit de tête et le
promeut : la production rattrape, sans nouveau commit et sans toucher à
l'historique.

⚠ **PAS « Redeploy », ET C'EST LE PIÈGE** (corrigé par Thierry le 21 octobre
2026) : « Redeploy » reconstruit le déploiement qu'on a sous les yeux, donc
**l'ANCIEN commit**. On obtient un build tout neuf, vert, horodaté de l'instant
— et la production sert toujours le code d'avant. C'est le pire des résultats :
le symptôme disparaît de l'écran sans que le défaut soit réparé.

Un **commit vide** reste possible quand on veut que le webhook refasse le
chemin complet, mais ce n'est plus le premier recours. C'est un commit **direct
sur la branche**, donc soumis à la règle du clone partagé : autorisation
explicite de Thierry au cas par cas, et son message porte la mesure qui le
justifie (voir `306de95`).

**Vécu une seconde fois le 21 octobre 2026, sur `main` et donc en PRODUCTION.**
Le merge du lot logements (`981d453`) a été poussé, `git ls-remote` confirmait
la ref avancée — et **aucun déploiement**, bouclé 120 secondes puis réinterrogé
à 4 minutes : zéro. Statut GitHub `pending`, zéro check-run. La sonde qui
tranche n'est pas l'API, c'est **la production elle-même** :
`https://hotesmart.vercel.app/logements` rendait **404** alors que la route
venait d'entrer dans `vercel.json`. Après « Create Deployment » sur `main` :
déploiement `Production – hotesmart` enregistré pour le SHA complet, et
`/logements` à **200**.

⚠ **ET LA FORME DU PUSH N'Y EST POUR RIEN.** Ce push-là visait
`<SHA>:refs/heads/main` plutôt qu'un nom de branche, parce que `main` est sorti
dans le clone partagé et qu'on n'y touche pas. C'est tentant d'y voir la cause :
c'en est une fausse. GitHub ne voit que **la mise à jour de la ref** ; le
refspec du côté local ne lui est pas transmis. Ne pas perdre de temps là-dessus
le jour où ça se reproduit.
