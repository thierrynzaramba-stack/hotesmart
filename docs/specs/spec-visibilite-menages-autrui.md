# Spec — Voir les ménages pris par d'autres (app ménage)

**Statut : PROPOSÉE, en attente du go de Thierry. Aucun code avant.**
Rédigée le 1er octobre 2026. Branche `spec-visibilite-menages`. Le code viendra
sur une branche et un commit séparés.

## 1. Le besoin

L'hôte peut **autoriser** une prestataire à voir, dans le calendrier de sa PWA,
les ménages **pris par d'autres**. Aujourd'hui elle ne voit que les siens, ce
qu'on lui propose, et ce que personne ne porte (la bulle).

**Par défaut, aucune visibilité — comme aujourd'hui.** Rien ne s'affiche sans
une autorisation explicite posée sur sa fiche. **Le serveur vérifie le réglage
à chaque lecture** ; l'écran n'est jamais la garde.

## 2. Les deux portées

| Portée | Ce qu'elle voit |
|---|---|
| **Par bien** | tous les ménages pris par d'autres sur les **biens dont elle reçoit les propositions** |
| **Par personne** | les ménages pris par **une ou plusieurs prestataires désignées** par l'hôte |

**« Les biens dont elle reçoit les propositions »** = ses liaisons **actives**
dans `property_cleaning_providers`, **intersectées** avec le périmètre de son
lien (`public_tokens.property_ids`, vide = tous). Pas « tous les biens du
compte » : une liaison retirée coupe la vue sur ce bien au cycle suivant.

**Par personne** : seulement les ménages de ces prestataires **sur des biens de
son périmètre de lien**. Désigner une collègue ne lui ouvre pas un bien qu'elle
ne voit pas déjà.

> **Question 1** — Les deux portées sont-elles **exclusives** (l'une OU
> l'autre) ou **cumulables** (par bien ET par personne) ? Proposition :
> **cumulables**, la vue étant l'union des deux. Le cas « voir tout le bien X,
> plus Marie partout » se règle alors sans contorsion.

## 3. Stockage du réglage

**Une table de l'app ménage, pas une colonne de `profile_permissions`.**

Raison (CLAUDE.md, « config d'app vs config générale », et le vécu du second
writer de `public_tokens`) : `profile_permissions` a un writer unique,
`api/membres.js`, gardé par le domaine **`equipe`**. Or un **membre délégué avec
les droits ménage** doit pouvoir régler cette visibilité comme l'hôte — sans le
droit `equipe`. Écrire ce réglage via `/api/membres` l'interdirait ; ouvrir un
second writer de `profile_permissions` reproduirait l'écrasement silencieux
déjà payé une fois.

```
menage_visibilite
  user_id        uuid not null  -- le compte (hôte)
  profile_id     uuid not null  -- la prestataire qui VOIT (profiles.id, access_mode = 'lien')
  par_bien       boolean not null default false
  profils_vus    uuid[] not null default '{}'   -- prestataires dont elle voit les ménages
  updated_at     timestamptz not null default now()
  updated_by     uuid            -- qui a réglé (hôte ou délégué) : trace lisible sur la fiche
  primary key (user_id, profile_id)
```

- **Absence de ligne = aucune visibilité.** Le défaut est le cas d'aujourd'hui,
  sans migration de données.
- **RLS activée** (règle du dépôt, jamais désactivée) : lecture et écriture
  `to authenticated` par `can_read` / `can_write(user_id, 'prestataires')`. La
  PWA, elle, passe par la service key derrière `api/menages-public.js`.
- **Writer unique** : un endpoint du domaine `prestataires` (proposé :
  `api/disponibilites.js`, qui gère déjà la fiche de la prestataire, ou une
  action de `api/menages.js`). Garde `requirePermission({ domaine:
  'prestataires', niveau: 'write', compteDelegue: true })` — **c'est ce qui
  donne la main au délégué** avec les droits ménage.
- **Validation serveur** : `profile_id` et chaque `profils_vus` doivent être
  des profils `lien` **de ce compte** (REVIEW.md règle 11 : un identifiant
  client se vérifie, il ne s'utilise pas) ; `profils_vus` ne contient jamais
  `profile_id` lui-même ; plafond de taille (proposé : 20).
- **Un profil désactivé** dans `profils_vus` n'est pas retiré du réglage, mais
  ses ménages cessent d'être servis (ils ne sont plus « pris par une autre »
  active).

Migration versionnée dans `migrations/`, appliquée staging puis prod, et
**prouvée par un script vérificateur** (colonnes, contrainte, policies) avant
d'écrire « appliquée ».

## 4. Serveur — `api/menages-public.js`

Le filtrage se fait **ici**, jamais seulement à l'écran.

À chaque `GET` du planning :
1. lire la ligne `menage_visibilite` de **ce profil, dans ce compte** (clé
   composite, REVIEW.md règle 1). Panne de lecture → **503**, pas une vue vide
   ni une vue pleine ;
2. sans ligne, ou ligne vide → **aucun ménage d'autrui**, et la réponse ne
   porte même pas la clé `autrui` (ou une liste vide — à figer dans un test) ;
3. sinon, lire les `menages` `status = 'accepted'` / `'started'` /
   `'completed'`, `provider_id` **non nul et différent d'elle**, dans la même
   fenêtre de dates que son planning, sur l'union des biens autorisés et des
   personnes autorisées (§2) ;
4. les rendre dans une liste **séparée** `autrui`, jamais mêlée à `bookings`
   ni à `menages` — c'est ce qui empêche structurellement qu'ils comptent comme
   « à moi ».

**Ce que contient une ligne `autrui`, et RIEN d'autre** (liste blanche,
construite champ par champ, jamais un `select('*')` filtré après coup) :

| Champ | Source |
|---|---|
| `bien` | `properties.name` |
| `date` | `menages.departure_date` |
| `heure` | `properties.checkout_time` si renseignée, sinon `null` (voir question 2) |
| `prestataire` | prénom + nom du profil porteur |

**Jamais** : code d'accès, nom / coordonnées / nombre de voyageurs, arrivée,
`booking_id`, identifiants internes, commentaires de l'hôte
(`menage_comments`), photos, statut « fait », retards, avis.

> **Question 2** — « L'heure du ménage » n'existe pas aujourd'hui dans la PWA.
> La seule heure en base est `properties.checkout_time` (l'heure de départ du
> bien, texte, souvent vide). Proposition : afficher l'heure de départ du bien
> quand elle est renseignée, « heure non précisée » sinon.

**Aucune action** : les actions d'écriture existantes (`prendreMenage`,
`markDone`, `retirerMonMenage`, commentaires…) gardent leurs gardes actuelles,
qui exigent déjà que le ménage soit à elle ou à personne. Aucune ne reçoit
d'identifiant venant de `autrui` (il n'en porte pas).

## 5. Écran prestataire — `apps/menages/public.html`

- Un jour portant un ménage pris par une autre affiche une **marque blanche**
  (pastille fond blanc, bordure), **en plus** de ce que la case dit déjà. Elle
  ne change ni le fond du jour, ni « jour travaillé », ni la bulle.
- **Jamais « à moi »** : ni dans la pastille verte, ni dans l'infobulle « N
  ménage(s) à moi », ni dans `jourTravaille`, ni dans « Votre ménage », ni dans
  le résumé de la feuille, ni dans le ratio d'en-tête. `autrui` est une liste à
  part, lue par des fonctions à part.
- **Au toucher**, la feuille du jour montre une section « Pris par une
  autre » : par ligne, le **bien**, la **date** et l'**heure**, et le **nom de
  la prestataire**. Rien de plus — pas de bouton, pas de lien vers une fiche.
- **Légende complète** : vert = mes ménages ; [à confirmer] ; blanc = pris par
  une autre.

> **Question 3 — contradiction à trancher.** La demande dit « ambre pour ceux à
> confirmer ». Or ce soir même, au vu du 4 octobre de Lena Lou, tu as décidé
> l'inverse : **pas de couleur pour une proposition, elle va dans la bulle**
> (`9e7b28c`, en prod). Proposition : la légende dit « vert = mes ménages ;
> bulle = à prendre ou à confirmer ; blanc = pris par une autre », et on ne
> ramène pas l'ambre.
>
> **Note** : la légende de la PWA a été **retirée** le 18 septembre
> (`d559ea4`, « chaque case dit déjà ce qu'elle est quand on la touche »). La
> réintroduire est une décision consciente, à graver dans `menage.md`.

## 6. Écran hôte — la fiche de la prestataire (`apps/menages/prestataires.html`)

Config d'app → elle vit dans l'app ménage, pas dans `/settings`.

Sur la fiche, une carte **« Ce qu'elle voit des autres »** :
- une case **« Les ménages des biens dont elle reçoit les propositions »**
  (liste des biens concernés, rappelée sous la case) ;
- une liste à cocher **« Les ménages de… »** avec les autres prestataires du
  compte (actives) ;
- l'état par défaut, tout décoché, est dit en clair : « Elle ne voit que ses
  propres ménages. »
- la dernière modification est tracée (« réglé par … le … »), comme les jours
  habituels.

Le réglage s'écrit **immédiatement** au changement de case (comme les
disponibilités de la fiche), avec verrou pendant l'écriture et message
d'échec.

## 7. Portage mobile de l'écran hôte

Règle « le mobile suit l'ordinateur ». `apps/menages/prestataires.html` n'a
**aucune règle `@media`** aujourd'hui : la fiche s'affiche en largeur desktop
sur un téléphone. Pour cette carte :
- cases et lignes de 44 px minimum, liste des prestataires en colonne ;
- testée à 375 px de large (pas de défilement horizontal).

> **Question 4** — Le portage mobile se limite-t-il à **cette carte**, ou on en
> profite pour rendre **toute la fiche prestataire** lisible sur téléphone ?
> Proposition : cette carte seulement dans ce lot ; la fiche entière notée au
> registre des dettes.

## 8. Tests — chacun doit rougir contre le code actuel

Contre-épreuve par `git archive` hors de l'arbre (REVIEW.md règle 19).

1. **Aucun champ sensible ne sort** : réponse du `GET` avec un réglage ouvert,
   et pour chaque ligne `autrui`, l'ensemble de ses clés est **exactement**
   `{bien, date, heure, prestataire}` — pas « ne contient pas tel champ » :
   une liste blanche d'égalité, qui rougit si un champ est ajouté.
2. **Même prestataire, avec et sans réglage** : la même requête renvoie **zéro**
   ménage d'autrui sans le réglage — ni dans `autrui`, ni dans `bookings`, ni
   dans `menages`, ni dans aucun compteur — et N avec.
3. **Jamais « à moi »** (DOM) : un ménage d'autrui le même jour qu'aucun des
   siens ne pose ni `a-moi`, ni pastille verte, ni « ménage à moi », ni
   « Votre ménage », et ne rallume pas un jour de repos.
4. **Portée par bien** : un ménage d'autrui sur un bien sans liaison active
   n'est pas servi.
5. **Portée par personne** : seuls les ménages des profils désignés sortent.
6. **Délégué** : un membre avec `prestataires: write` règle la visibilité ; un
   membre sans ce droit reçoit 403 ; un identifiant d'un autre compte reçoit
   400.
7. **Panne de lecture du réglage** : 503, jamais une vue pleine.
8. **Aucune action** : `prendreMenage` / `markDone` sur un ménage d'autrui
   restent refusés (non-régression).

Le compte des rouges de la suite reste **28** avant tout push.

## 9. Documentation

- `docs/kb/menage.md` : nouvelle section (portées, stockage, liste blanche, la
  légende réintroduite et pourquoi), dans le même commit que le code.
- `docs/kb/profils-et-droits.md` : le réglage relève du domaine
  `prestataires`, accessible au délégué.
- `pages/guide.html` : un paragraphe pour l'hôte.

## 10. Ordre proposé

1. Migration `menage_visibilite` + vérificateur, staging.
2. Writer (fiche hôte) + tests 6.
3. Lecture `api/menages-public.js` + tests 1, 2, 4, 5, 7, 8.
4. PWA + test 3, légende.
5. Carte de la fiche hôte + portage mobile.
6. Review, staging (recette), prod sur ton feu vert.

## 11. Hors périmètre

- Toute action sur un ménage d'autrui (prise, échange, remplacement).
- Le voir dans les notifications.
- Les ménages **proposés** à une autre (non acceptés) : ils restent invisibles
  aux collègues — seul le pris est montré.
