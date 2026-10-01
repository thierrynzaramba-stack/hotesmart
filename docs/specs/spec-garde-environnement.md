# Spec — un garde central d'environnement

> Chantier décidé le 1er octobre 2026, après l'audit des envois sortants.
> **Spec seulement : aucun code n'est écrit tant que Thierry n'a pas tranché.**
> Audit de départ : `docs/recette/audit-envois-staging.md`.

## Le constat qui justifie ce chantier

**Aucun code serveur ne sait sur quel environnement il tourne.** `NODE_ENV` et
`VERCEL_ENV` n'apparaissent nulle part en dehors des tests. Un seul fichier
reconnaît son environnement, et depuis le 30 septembre seulement.

Ce qui protège staging aujourd'hui est donc, dans l'ordre : une clé absente de la
base, la valeur d'une variable qui aiguille sans garder, un réglage d'interface
Vercel. Trois protections hors du dépôt, donc invérifiables par un test.

Et le dépôt n'a que **trois** garde-fous fermés par défaut, chacun couvrant un
seul des chemins qui mènent au même geste. Celui de Beds24 protège le cron, pas
le bouton « envoyer ».

**La mesure qui a déclenché le chantier** : une variable de simulation avait été
posée, et l'avis est parti quand même — un déploiement déjà construit ne relit pas
ses variables. Ce n'est pas une erreur d'inattention : c'est ce que produit un
garde ouvert par défaut.

## Le principe

**Hors production, rien ne sort. La production se reconnaît positivement.**

Trois conséquences qui définissent le chantier :

1. **Fermé par défaut.** Une base inconnue, une variable absente, une
   configuration à moitié faite : tout cela ne sort pas. On échoue fermé.
2. **La production se nomme.** Pas « tout sauf staging » — un nouvel
   environnement serait alors ouvert par accident. La production est reconnue par
   une valeur explicite, et tout le reste est hors production.
3. **Ouvrir se demande.** Une variable par famille d'envoi, à poser
   explicitement, pour éprouver un vrai chemin depuis une recette.

**Et l'objection a une réponse, qui est la vraie condition du chantier.** Si la
production changeait d'identité, tout se fermerait en silence. Donc : **chaque
envoi retenu crie**, dans les journaux d'erreur, et **la réponse le dit** à
l'appelant. C'est ce qui rend l'inversion tenable, et c'est déjà éprouvé sur la
publication d'avis — l'écran affiche « publié en simulation », personne ne peut
s'y tromper.

Sans cette contrepartie, le chantier échange un risque visible contre un risque
invisible. Il ne doit pas être fait à moitié.

## Ce que le garde doit couvrir, par ordre de ce qu'un humain reçoit

L'audit classe seize points d'envoi. Le garde doit les traiter **par famille**,
pas un par un : c'est la leçon de `SENDVIABEDS24_ENABLED`, qui ne couvre qu'un
chemin sur quatre vers le même voyageur.

| Famille | Ce qui doit être retenu hors production | Variable d'ouverture proposée |
|---|---|---|
| Messages au voyageur | messagerie Beds24 et canal, e-mail voyageur — **cron ET bouton** | `ENVOIS_VOYAGEUR_REELS` |
| SMS et e-mails à l'hôte | alertes, notifications de réservation, surréservation, « simuler » | `ENVOIS_HOTE_REELS` |
| SMS aux prestataires | notification de ménage | `ENVOIS_PRESTATAIRE_REELS` |
| Serrures connectées | création et suppression de codes, cron d'arrivée | `SERRURES_REELLES` |
| Écritures chez les plateformes | disponibilités, prix, réservations, avis | `ECRITURES_PLATEFORME_REELLES` |
| Paiements et facturation | abonnements, encaissements, remboursements | `PAIEMENTS_REELS` |

**Deux cas demandent une décision de Thierry**, parce que les fermer a un coût :

- **Les disponibilités** sont ouvertes *par décision* : `lib/rate-sync.js` les
  exempte, l'anti-surbooking n'étant pas négociable. Les fermer hors production
  est sans risque pour la production, mais casse la recette du calendrier.
- **La facturation** (`lib/billing.js`) se déclenche sans geste humain, par cron
  ou webhook. Son garde actuel, `is_beta`, **échoue en mode ouvert** et la ligne
  `accounts` est absente sur staging.

## Un point de vigilance que l'audit a révélé

**Ne pas remplacer les gardes existants, les chapeauter.** Trois d'entre eux sont
fermés par défaut et corrects. Le garde central doit s'ajouter, pas se substituer
— un seul point de décision devient un seul point de défaillance.

Et **ne pas faire du garde un moyen de faire passer les tests** : un test qui
n'est vert que parce que rien ne sort ne prouve rien du chemin réel. La suite
actuelle ouvre explicitement le chemin réel là où elle l'éprouve, en tête de
fichier, avec la raison écrite. C'est le motif à garder.

## Le volet base de données

**`brevo_enabled` et `seam_enabled` naissent à `true`.** Une ligne `api_keys`
créée sans nommer ces colonnes est donc active. Le seed de staging les pose à
`false` explicitement ; l'écran Connexions, non.

Ce sont les deux interrupteurs qui, aujourd'hui, retiennent tous les e-mails, tous
les SMS et tous les codes de serrure sur staging. Ils tiennent parce que les clés
sont absentes, pas parce que le défaut est bon.

**Migration à écrire** : `DEFAULT false` sur les deux, sans toucher les lignes
existantes — la production les a explicitement à `true` et doit y rester. Une
migration qui se contenterait de changer le défaut ne suffit pas à le prouver : il
faut un contrôle qui lise les deux colonnes et compare aux valeurs attendues, base
par base.

## Ce que ce chantier ne fait pas

- Il ne touche pas la **réception** des webhooks, ni aucun chemin certifié.
- Il ne remplace pas les protections par la base : une clé absente reste la
  meilleure protection, parce qu'elle ne dépend d'aucun code.
- Il ne corrige pas les deux points de sécurité de l'audit (`api/cron.js`, traité
  à part le 1er octobre, et l'action `register` de `api/channel-webhook.js`). Ce
  sont des failles, pas des questions d'environnement.

## Comment on saura que c'est fait

Un script de preuve, sur le modèle de `scripts/prouver-simulation-avis.js` : il
tente un envoi de chaque famille depuis staging, par HTTP, avec une vraie session,
et exige que **chacun** soit retenu et le dise. Tant que ce script n'existe pas et
ne passe pas, le chantier n'est pas terminé — l'incident du 30 septembre a montré
qu'un garde qu'on croit posé et un garde qui tient sont deux choses différentes.
