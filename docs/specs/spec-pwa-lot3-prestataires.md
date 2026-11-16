# PWA lot 3 — les notifications de la prestataire de ménage

Spec du 15 novembre 2026, sur `main` à `f7b72ed7` (lot 2 en production le
12 novembre). Fil PWA. KB : `docs/kb/pwa.md` (§8 à §12 pour le lot 2).
Spec du lot 2 : `docs/specs/spec-pwa-lot2-notifications.md` (Q10 : « les
prestataires, dans la foulée, au lot 3 » ; §8 : « la même paire de clés servira
à l'appli prestataire »).

## 0. En bref

- **La prestataire reçoit sur son téléphone une notification** quand un ménage
  lui est attribué, quand un ménage lui est proposé (à confirmer avant
  l'échéance), quand on attend son « Vu » (la veille et le jour même, 9 h), et
  — c'est nouveau — **quand un de ses ménages est annulé ou change de date**,
  et **quand l'hôte le lui retire**.
- **Elle l'active elle-même**, dans sa page (`apps/menages/public.html`), par un
  bouton « Recevoir les notifications sur ce téléphone ». Sur iPhone, il faut
  d'abord avoir installé la page sur l'écran d'accueil — la page le dit.
- **La notification remplace le SMS** dès qu'un de ses appareils l'a reçue. Si
  aucun ne l'a reçue (pas abonnée, abonnement mort), le SMS part comme
  aujourd'hui, sur la clé Brevo de l'hôte. L'e-mail ne change pas.
- **À toute heure**, comme les SMS d'aujourd'hui.
- **L'hôte voit sur sa fiche**, dans `/menages`, si elle reçoit les
  notifications et sur combien d'appareils.
- Fichiers d'interface touchés, avec l'accord de Thierry du 12 novembre :
  `apps/menages/public.html`, `apps/menages/sw.js`, `pages/menages.html`.
  Rien d'autre dans `pages/`, `apps/` ou `shared/ui.css`.

## 1. État des lieux (mesuré sur `main` `f7b72ed7`)

**Qui est la prestataire.** Un profil `access_mode = 'lien'`, rattaché au
compte d'un hôte (`profiles.account_user_id`), avec son jeton
(`profiles.pwa_token`). Elle n'a pas de compte Supabase Auth : son lien est sa
seule identité, et `api/menages-public.js` la reconnaît par une garde unique
(`profilActifDuJeton` : profil actif, `access_mode = 'lien'`, jeton exact).
Une prestataire qui travaille pour deux hôtes a deux profils et deux liens.

**Son appli.** `apps/menages/public.html` (5 655 lignes), installable : son
manifeste est dynamique (`/api/manifest?token=…`, `start_url` porteur du
jeton, `scope: /apps/menages/`, un `id` par lien), et son service worker
`apps/menages/sw.js` (portée `/apps/menages/`) ne fait que du cache
(`network-first`, coquille hors ligne). **Aucun gestionnaire `push`.** La page
range son jeton dans `localStorage` (`hotesmart-clean-token`, une seule clé) ;
en aperçu de l'hôte (`apercu=1`), elle ne range rien et n'installe rien.

**Ce qu'elle reçoit aujourd'hui** (`lib/cleaning/notifier-prestataire.js`) —
par SMS (clé Brevo de l'HÔTE, `api/sms.js`) et par e-mail (clé de la
plateforme), chacun s'il a une coordonnée ET si l'hôte ne l'a pas décoché sur
sa fiche (`notify_sms`, `notify_email`) :

| événement | fonction | appelée par | quand |
|---|---|---|---|
| ménage attribué | `notifierAssignation` | `api/menages.js` (geste de l'hôte) | à l'instant |
| ménage à confirmer | `notifierProposition` | `lib/cleaning/sync-menages-entite.js` (moteur, 3 endroits), `api/menages.js`, `api/menages-public.js` | à toute heure ; échéance 48 h au plus |
| « touchez Vu » | `notifierValidationAttendue` | `lib/cleaning/relance-validation.js` | à partir de 9 h de Paris, la veille et le jour même |

**Ce qu'elle ne reçoit pas.** L'annulation d'un ménage : le moteur
(`synchroniserMenages`, `sync-menages-entite.js` l. 627-650) passe en
`cancelled` les ménages dont la réservation a disparu **ou dont la date de
départ a bougé** — le journal dit « Réservation annulée ou date de départ
déplacée » —, et ne prévient personne. Une date déplacée produit donc DEUX
choses : l'ancien ménage annulé, et un nouveau ménage qui suit son propre
chemin (attribution ou proposition, donc sa propre notification).

**Le lot 2, côté hôte**, a posé ce que le lot 3 réutilise : les clés VAPID
(`lib/push/envoyer.js`, `clesVapid`), le message déclaratif
(`messageDeclaratif`, format `web_push: 8030`, lu par Safari sans service
worker et par les autres navigateurs via le gestionnaire `push`), l'envoi
par appareil avec purge des abonnements morts (`envoyer`, `apresEnvoi`), et la
règle « la notification remplace le SMS quand un appareil l'a reçue » (Q11).
Sa table `push_abonnements` est **par utilisateur Auth** (`user_id` non nul,
référence `auth.users`) : elle ne peut pas porter une prestataire.

## 2. Décisions de Thierry (12 novembre 2026)

| # | question | réponse |
|---|---|---|
| Q40 | Ce que couvre la notification | Les trois d'aujourd'hui **+ l'annulation ou le changement de date** |
| Q41 | La notification et le SMS | **La notification remplace le SMS** ; le SMS repart seul si aucun appareil ne l'a reçue |
| Q42 | La nuit | **À toute heure**, comme les SMS d'aujourd'hui |
| Q43 | Les fichiers d'interface | Accord pour `apps/menages/public.html`, `apps/menages/sw.js`, `pages/menages.html` |
| Q44 | L'annulation sans appareil abonné | **SMS et e-mail aussi**, même règle que les trois autres avis (décision du 17 novembre) |
| Q45 | Un ménage que l'hôte lui retire | **Elle est prévenue** : « ne vous est plus confié », mêmes canaux (décision du 17 novembre) |

## 3. Ce que voit la prestataire

1. **Un bloc « Notifications »** dans sa page, discret (pas un bandeau à
   l'ouverture) : « Recevoir les notifications sur ce téléphone ». Un geste
   d'elle, toujours : un navigateur ignore une demande d'autorisation qui ne
   suit pas un toucher (iPhone en particulier).
2. **Sur iPhone, pas encore installée** : le bouton est remplacé par
   l'explication « Ajoutez cette page à votre écran d'accueil (Partager → Sur
   l'écran d'accueil), puis ouvrez-la depuis l'icône ». Safari n'offre les
   notifications qu'aux pages installées.
3. **Abonnée** : « Ce téléphone reçoit les notifications » et « Ne plus
   recevoir sur ce téléphone ». L'état est celui que le SERVEUR connaît : la
   page compare son abonnement local à la liste que lui rend le GET (empreinte
   de l'adresse, jamais l'adresse elle-même).
4. **Refusée par le téléphone** (autorisation bloquée) : la page le dit et
   explique où la rouvrir ; elle ne redemande pas.
5. **La notification** : titre « HôteSmart », texte court, logement et date,
   jamais le nom d'un voyageur. Un toucher ouvre sa page
   (`/apps/menages/public.html`), sans jeton dans l'adresse : l'appli
   installée a déjà le sien.
6. **En aperçu de l'hôte**, le bloc n'existe pas, et le serveur refuse
   l'abonnement d'une requête marquée `apercu`.

## 4. Ce que voit l'hôte

Sur la fiche de la prestataire (`/menages`, fenêtre de configuration, section
« Notifications », sous les bascules SMS et e-mail) : « Reçoit les
notifications sur N téléphone(s) » ou « N'a pas activé les notifications »,
et une ligne d'aide : « Quand elle les reçoit, le SMS ne part pas. »
Lecture seule : l'abonnement est le geste de la prestataire, sur son
appareil. L'hôte coupe tout en désactivant la personne ou en lui donnant un
nouveau lien (§7.4).

## 5. Les événements et leurs textes

| événement | texte (notification) | qui |
|---|---|---|
| attribué | « Nouveau ménage : {jour} - {bien}. » | la porteuse |
| à confirmer | « Ménage à confirmer : {jour} - {bien}. Répondez avant le {échéance}. » | chaque prestataire sollicitée |
| « Vu » attendu | « Ménage du {jour} à {bien} : ouvrez votre page et touchez Vu. » (+ « C'est aujourd'hui. » le jour même) | la porteuse |
| annulé ou déplacé | « Ménage du {jour} - {bien} annulé : la réservation est annulée ou son départ a changé. » | la porteuse, et chaque prestataire à qui il était proposé |
| retiré par l'hôte | « Le ménage du {jour} - {bien} ne vous est plus confié. » | celle qui le portait, ou à qui la proposition est retirée |

Le SMS garde ses textes actuels (GSM-7, tiret simple, au mot près pour le
« Vu », texte de Thierry). L'annulation, quand elle part par SMS, suit les
mêmes règles d'écriture. Un même ménage ne produit qu'une notification
visible à la fois : la suivante remplace la précédente (`tag` = le ménage,
comme Q12 du lot 2).

## 6. La règle d'envoi

Pour chacun des cinq événements, dans `notifier-prestataire.js` :
1. **La notification**, à tous ses appareils abonnés.
2. **Le SMS seulement si aucun appareil ne l'a reçue** (aucun abonné, tous
   morts, tous en échec), et toujours sous les deux conditions d'aujourd'hui :
   un numéro, et `notify_sms` non décoché par l'hôte.
3. **L'e-mail inchangé** (adresse et `notify_email`).

Le bilan rendu à l'appelant gagne `push: n` à côté de `sms` et `email`, pour
que l'écran de l'hôte dise ce qui est réellement parti (« Elle a été
prévenue ») — la promesse centrale de ce module.

## 7. Architecture (technique)

1. **Table `push_abonnements_prestataires`** (migration, staging puis prod sur
   go) : `id`, `profil_id` (référence `profiles(id)`, `on delete cascade`),
   `compte_id` (l'hôte), `endpoint`, `cle_p256dh`, `cle_auth`, `appareil`,
   `cree_le`, `dernier_envoi_le`, `dernier_echec`. Unicité sur
   `(profil_id, endpoint)` et non sur `endpoint` seul : sur Android, deux
   appli installées de la même prestataire (deux hôtes) partagent la portée
   `/apps/menages/`, donc le même abonnement. RLS active, aucune politique :
   le serveur seul l'écrit et la lit.
2. **Le module `lib/push/abonnements-prestataires.js`** : `enregistrer`,
   `retirer`, `lister` (empreintes), `pourEnvoi`, `apresEnvoi` — la même forme
   que `lib/push/abonnements.js`, et la même validation de l'abonnement
   (adresse `https:` d'un service de push connu, clés présentes) partagée,
   jamais recopiée.
3. **Les gestes, dans `api/menages-public.js`**, derrière sa garde unique
   (`profilActifDuJeton`) : `POST action=push_abonner` (abonnement +
   libellé de l'appareil) et `POST action=push_retirer` ; refus en aperçu ;
   `private, no-store` avant le premier refus. Le GET existant ajoute
   `push: { pret, cle_publique, appareils: [empreintes] }` — aucun appel de
   plus pour la page.
4. **Sécurité du lien.** Un **nouveau lien** (geste « Nouveau lien » de
   l'hôte) supprime les abonnements de la personne : l'ancien téléphone, peut-
   être perdu, ne reçoit plus rien. Un **profil désactivé** ne reçoit rien
   (`profilNotifiable` le refuse déjà) et ses abonnements sont supprimés. Le
   jeton n'entre jamais dans le message ni dans l'adresse ouverte au toucher.
5. **Le service worker `apps/menages/sw.js`** gagne `push`,
   `notificationclick` et `pushsubscriptionchange`, avec la même lecture du
   message que le service worker de l'hôte : le code commun vit dans un
   fichier partagé (`shared/pwa/push-sw.js`, chargé par `importScripts`),
   jamais recopié (règle « deux copies divergent »). Son `CACHE_VERSION` est
   bumpé (la coquille change).
6. **L'envoi** : `envoyerAPrestataire({ profilId, message })` dans
   `lib/push/envoyer.js`, jumeau d'`envoyerAPersonne` sur l'autre table ;
   `notifier-prestataire.js` l'appelle d'abord, puis applique §6.
7. **L'annulation** : dans `synchroniserMenages`, après l'`update` réussi en
   `cancelled`, une notification par ménage annulé à sa porteuse et aux
   prestataires sollicitées — **seulement pour un ménage à venir** (départ
   aujourd'hui ou plus tard) : un ménage passé annulé par une correction de
   l'historique ne réveille personne. Best-effort : un envoi en échec ne
   défait pas l'annulation.
8. **Le retrait par l'hôte** (Q45) : dans `api/menages.js`, aux gestes
   « Retirer la proposition », « Personne » et à toute attribution qui change
   la porteuse, après l'écriture réussie, une notification « ne vous est plus
   confié » à celle qui perd le ménage — seulement pour un ménage à venir, et
   jamais à celle qui le reçoit (elle a déjà son « attribué » ou son « à
   confirmer »). Le moteur, lui, ne retire rien sans annuler : son cas est §7.7.
9. **Hôte** : `fichePrestataire` (`api/menages.js`) rend `appareils: n`,
   lu en parallèle des lectures existantes.

## 8. Case PERFORMANCE (CLAUDE.md, huit points)

1. **Un écran = un endpoint** : la page de la prestataire garde son unique
   GET (`/api/menages-public`), qui porte l'état des notifications ; la fiche
   de l'hôte garde le sien. Aucun appel ajouté à l'ouverture.
2. **Donnée non urgente** : sans objet (l'état d'un abonnement est lu tel
   quel, une ligne par appareil).
3. **Cache navigateur** : sans objet ; l'état d'abonnement n'est jamais
   affiché depuis un cache (il se relit, comme un code).
4. **`private, no-store`** sur les deux nouvelles actions, posé avant le
   premier refus, 405 compris.
5. **Statiques versionnés** : `shared/pwa/push-sw.js` est chargé par le
   service worker ; le bump de `CACHE_VERSION` fait arriver la nouvelle
   coquille.
6. **Lectures tronquées** : la liste des abonnements d'une personne est
   bornée (dix appareils au plus, comme au lot 2) ; aucune lecture de plus de
   1 000 lignes.
7. **Budget** : un test compte les requêtes du GET de la page avant/après
   (+1 lecture, en parallèle) et celles de la fiche (+1).
8. **Mesure AVANT / APRÈS** : appels, requêtes, octets du GET de la page de la
   prestataire et de la fiche, **mesurés sur staging avant la première ligne
   de code**, puis à la recette. Inscrits ici.

## 9. Inventaire (la forme ne supprime jamais le fond)

Rien n'est retiré. Les bascules SMS et e-mail de la fiche restent, avec leur
sens (« peut-on la prévenir par ce canal »). Les textes des SMS ne changent
pas. Le cache hors ligne de la page reste tel quel.

## 10. Questions ouvertes (à Thierry)

Aucune : Q44 et Q45 sont tranchées (§2, 17 novembre 2026).

## 11. Étapes

0. Mesure AVANT sur staging (§8.8).
1. Migration + module des abonnements + actions de `api/menages-public.js` +
   GET (tests : garde, aperçu refusé, nouveau lien et désactivation qui
   purgent, unicité `(profil, endpoint)`, `no-store`).
2. Service worker et page de la prestataire (bouton, iPhone non installé,
   refusé, abonnée) + code partagé du service worker.
3. Envoi : `envoyerAPrestataire`, règle §6 dans les trois fonctions, bilan
   `push`.
4. Annulation (§7.7) et retrait par l'hôte (§7.8).
5. Fiche de l'hôte (§4), guide utilisateur (`pages/guide.html`, si Thierry
   l'accorde), KB.
Une review par étape, une re-review des seuls correctifs sur constat de
sécurité ; suite aux deux horloges à zéro rouge avant chaque push.

**Recette (staging, Thierry et un téléphone de prestataire)** : s'abonner,
recevoir une attribution, une proposition, un « Vu », une annulation, un
retrait par l'hôte ; le SMS
qui ne part pas quand la notification est reçue, et qui part quand
l'abonnement est retiré ; nouveau lien → plus rien ; iPhone installé.
⚠ Staging n'a ni cron ni clé Brevo : la proposition et le « Vu » se
déclenchent par script, le SMS ne part pas (la notification, si).

## 12. Limites connues

- **Deux hôtes, un même téléphone Android** : les deux appli installées
  partagent la portée, donc le même abonnement ; le toucher ouvre la page du
  dernier lien utilisé. Rare ; à revoir si une prestataire travaille pour
  deux hôtes HôteSmart.
- **iPhone** : il faut iOS 16.4 au moins et l'appli installée sur l'écran
  d'accueil.
- **Le manifeste** `/api/manifest?token=` est servi en `public, max-age=300`
  avec le jeton dans l'adresse — antérieur au lot, relevé ici, hors périmètre.
