# Spec — Délai de réponse IA configurable (GuestFlow)

État : **SOUMISE À VALIDATION**, aucun code écrit.
Branche : `chantier-delai-ia` (remise au chef de file, jamais mergée ici).
Étape 0 du brief : état des lieux fait le 27 octobre 2026 sur `main` 8aae0f5f.

---

## 1. Ce que remplace ce chantier

Aujourd'hui chaque bien porte un interrupteur binaire **Mode Test / Mode Auto**,
dans `agent_alert_config.config[<ref>].mode` (`'test'` par défaut). Il décide,
au moment où le cron classe un message, entre « envoyer tout de suite » et
« ne rien envoyer, poser une tâche à valider ».

On le remplace par un **envoi différé** : le brouillon existe, il est visible,
il porte une échéance, et il part de lui-même si l'hôte ne fait rien. Le mode
binaire devient le cas limite d'un délai (0 = immédiat, ∞ = validation
manuelle).

Le gain n'est pas le réglage : c'est le **parachute**. Aujourd'hui, en Mode
Test, un hôte qui oublie une proposition laisse le voyageur sans réponse,
indéfiniment, sans que rien ne le rattrape.

---

## 2. État des lieux (étape 0)

### 2.1 Où le mode est lu — quatre points, et un seul les sert

`getPropertyMode(userId, propertyId)` — `lib/cron-shared.js:108` — lit
`agent_alert_config.config[propertyId].mode`, replie sur `'test'` en cas
d'absence **comme en cas d'erreur**. Quatre appelants :

| # | Appelant | Ce que le mode décide | Touché par ce chantier |
|---|---|---|---|
| 1 | `lib/cron-classify.js:1296` | réponse IA `sympathy` / `info_known` : envoi direct ou tâche `pending_validation` | **OUI — c'est le cœur** |
| 2 | `lib/cron-messages.js:480` | modèle programmé (`checkAndSendTemplate`) | non : reste binaire |
| 3 | `lib/cron-messages.js:690` | modèle programmé (boucle) | non : reste binaire |
| 4 | `lib/cron-arrival-code.js:573` | code d'accès du jour | non : reste binaire |

⚠ **Conséquence d'architecture, à ne pas rater.** Les points 2, 3 et 4 testent
`propMode === 'auto'`. Le brief dit que les messages programmés sont
**inchangés**, et qu'en Validation manuelle ils sont à valider comme
aujourd'hui. Donc on ne supprime pas la notion binaire : on la **dérive** du
nouveau réglage. `getPropertyMode` reste, avec sa signature et son repli, et
rend `'test'` quand le réglage dit « Validation manuelle », `'auto'` sinon.
Les trois points programmés ne changent pas d'une ligne.

C'est le point de bascule le moins coûteux et le plus sûr : un seul des quatre
appelants apprend le délai.

### 2.2 Ce que le mode NE décide pas — et c'est une surprise

**`info_unknown` et `intervention` ne lisent pas le mode du tout**
(`lib/cron-classify.js:1437-1498`). La tâche est insérée en `status: 'pending'`,
puis `sendAlertNotifications` part **dans le même tour**, inconditionnellement,
Mode Test ou Mode Auto.

Donc le réglage n° 2 du brief (délai d'alerte info manquante) ne retarde pas un
chemin qui était déjà réglable : il introduit le **premier** réglage de ce
chemin. À dire à Thierry, parce que l'intuition « c'était déjà en test » est
fausse ici : en Mode Test, les alertes d'info manquante partent déjà.

### 2.3 Le chemin des alertes

`lib/alert-notify.js:25` — `sendAlertNotifications({ type, task, propertyId })` :

1. lit `agent_alert_config.config[<propertyId>][<type>]` — donc le **même blob**
   que le mode, une clé par type (`intervention`, `info_unknown`) ;
2. **SMS** par la clé Brevo de l'hôte (`api/sms.js`), destinataires parsés de
   `sms_lines` ;
3. **E-mail** par la clé plateforme `ALERT_BREVO_API_KEY` (canal universel),
   destinataires parsés de `email_lines` ;
4. rend `{ emailSent }` ; toute erreur est avalée côté appelant
   (`catch (alertErr) { console.error(...) }`).

⚠ **Dette rencontrée, hors périmètre mais à signaler** :
`PROPERTY_NAMES` (`lib/alert-notify.js:15`) code en dur `'169567'` et
`'209413'`. Tout autre bien s'annonce « Logement <id> » dans le SMS et dans
l'objet de l'e-mail. Un hôte qui reçoit l'alerte d'un troisième bien lit un
numéro. Non bloquant pour ce chantier ; à noter au KB comme dette.

### 2.4 `agent_tasks` — schéma réel

`migrations/0000-schema-initial.sql:1179` :

```
id uuid PK            created_at / updated_at timestamptz
user_id uuid          property_id text        book_id text
guest_name text       guest_message text      guest_phone text
task_type text NOT NULL   summary text        suggested_reply text
status text DEFAULT 'pending'
source_thread jsonb   sub_tasks jsonb
arrival date          departure date
lock_id uuid          battery_level int       next_reminder_at timestamptz
```

Statuts en usage : `pending` (à faire par l'hôte), `pending_validation`
(proposition à valider), `done`, `ignored`.

Index existants : `idx_agent_tasks_created_at` (`created_at`) et
`idx_agent_tasks_lock_battery` (partiel, `task_type = 'battery_low'`).
**Aucun index ne sert une lecture par échéance** — c'est l'objet de la
migration du §3.2.

`next_reminder_at` existe déjà, pour les relances de batterie. Précédent utile,
mais **on ne le réutilise pas** : deux horloges de sens différent sur la même
colonne se marchent dessus le jour où une tâche porte les deux.

### 2.5 ⚠ LE CONSTAT CENTRAL : la course cron / clic n'est PAS fermée aujourd'hui

`api/messages.js:238` — `cloreProposition` a bien un claim atomique :

```js
.update({ status: statut })
.eq('id', tache.id).eq('user_id', userId).eq('status', 'pending_validation')
.select('id')
// 0 ligne → 409 'deja_close'
```

Mais le commentaire au-dessus dit l'ordre réel, et il est inversé :

> « le client envoie d'abord par posterMessage (routage par SOURCE), PUIS cette
> action pose le statut »

**L'envoi précède le claim.** Aujourd'hui c'est inoffensif : rien d'autre
qu'un humain n'envoie une proposition, et deux onglets de la même personne sont
un cas rare qui se solde par un 409 après coup. **Dès qu'un cron peut envoyer
la même tâche, cet ordre produit le double envoi** — et c'est exactement le
test (b) du brief.

Donc la règle 4 n'est pas « ajouter un claim » : c'est **inverser l'ordre**
dans le chemin de l'écran. Claim d'abord, envoi ensuite. Détail au §4.4.

### 2.6 La réponse de l'hôte depuis l'app Airbnb — le socle existe

`lib/cron-classify.js:138` : `REPONSES_HOTE = ['host', 'ai']`, et
`nosEnvoisBeds24` rapproche nos propres envois pour ne pas les compter comme
une réponse de l'hôte. `depuisHote` (ligne 1230) sert déjà de repère temporel
pour écarter les tâches antérieures.

La règle 1 du brief s'appuie donc sur du code éprouvé, pas sur une détection à
inventer. Ce qui manque est l'**annulation** : aujourd'hui une réponse de
l'hôte écarte les propositions périmées du lot (ligne 1265) ; demain elle doit
aussi désarmer un brouillon qui n'a pas encore atteint son échéance.

### 2.7 Le cron : cadence et forme

`vercel.json` : `/api/cron` toutes les **5 minutes**, `/api/cron-messages`
toutes les 10.

`api/cron.js` enchaîne des passes nommées, chacune mesurée
(`chrono.mesure('<nom>', ...)`), **hors** de la boucle par compte. Le précédent
exact de ce qu'il faut écrire existe : `poserPropositionsDues`
(`lib/cleaning/sync-menages-entite.js:772`) — bornes de dates en SQL,
`opts.maintenant` injectable, plafond de notifications par cycle, bilan rendu.
C'est la forme à suivre, à la lettre.

⚠ `api/cron.js` est un **fichier partagé** et une règle dure de CLAUDE.md :
toujours régénéré en fichier COMPLET, jamais patché partiellement. À signaler
au chef de file comme risque de conflit (§8).

### 2.8 Le modèle IA et son coût

`lib/cron-classify.js:70` : `MODELE_PAR_DEFAUT = 'claude-haiku-4-5-20251001'`,
surchargeable par la variable Vercel `GUESTFLOW_MODEL`.

⚠ **TRANCHÉ PAR THIERRY LE 28 OCTOBRE 2026 : la production reste sur
Sonnet 5.5**, posé le 2 octobre par un choix délibéré — **Haiku annonçait des
codes d'accès non envoyés**. Tout chiffrage de ce document est donc sur
Sonnet 5.5, et **le modèle n'est pas un levier de coût** : il a été acheté pour
sa fiabilité sur un chemin qui parle au voyageur.

Prix publics au 27 octobre 2026, par million de tokens (entrée / sortie) :

| modèle | entrée | sortie |
|---|---|---|
| Haiku 4.5 (défaut du code) | 1,00 $ | 5,00 $ |
| Sonnet 5.5 (probable prod) | 2,00 $ | 10,00 $ |
| Haiku 5.5 | 0,10 $ | 0,50 $ |

Mesure de l'appel : le gabarit de prompt fait ~7 Ko, auquel s'ajoutent la base
de connaissance du bien et le fil. **Plage retenue : 2 500 à 4 000 tokens
d'entrée, ~300 de sortie** (`max_tokens: 1000`, le JSON rendu est court).
C'est une estimation à partir de la taille des chaînes, **pas une mesure par
`count_tokens`** — à refaire avant d'engager un coût réel.

Coût d'**un** appel, dans cette plage :

| modèle | par appel |
|---|---|
| Haiku 4.5 | 0,4 à 0,6 ct $ |
| Sonnet 5.5 | 0,8 à 1,1 ct $ |
| Haiku 5.5 | 0,04 à 0,06 ct $ |

⚠ **Et Haiku 5.5, dix fois moins cher que le défaut du code, N'EST PAS un
levier disponible** : la raison du passage à Sonnet 5.5 est la **qualité** (des
codes d'accès annoncés comme envoyés alors qu'ils ne l'étaient pas), pas le
hasard. Ce tableau sert à chiffrer, pas à proposer une descente en gamme.

---

## 3. Modèle de données

### 3.1 Les réglages — dans le blob d'app, pas dans `/settings`

Test qui tranche (CLAUDE.md, « CONFIG D'APP vs CONFIG GÉNÉRALE ») : « ce
réglage a-t-il un sens si l'app n'existait pas ? » Non → dans l'app. Les trois
réglages vivent donc là où vit déjà le mode : `agent_alert_config.config[<ref>]`,
écrit par le writer **existant** `/api/agent-config`.

```
config[<ref>] = {
  // existant, conservé le temps de la migration (§6), puis retiré
  mode: 'test' | 'auto',

  // NOUVEAU — bloc unique, pour que l'écran écrive une seule cible
  delais: {
    reponse_ia: null | <entier, minutes>,   // null = Validation manuelle, 0 = immédiat
    alerte_info: <entier, minutes>,         // 0 = immédiat
    sourdine: {
      active: false,                        // désactivée par défaut
      debut: '22:00',                       // heure locale du BIEN
      fin:   '08:00'
    }
  },

  // existant, inchangé
  intervention: { sms_enabled, sms_lines, email_enabled, email_lines },
  info_unknown: { ... }
}
```

**Pourquoi un sous-objet `delais` et pas trois clés à plat** : `/api/agent-config`
impose déjà « une cible par requête » (`mode` **ou** `alertes`, jamais les
deux — un 400 sinon, constat de review). Un bloc = une troisième cible
`delais_ref` / `delais`, validée champ par champ comme les alertes le sont
déjà. L'écran enregistre les trois réglages d'un geste, le serveur merge sur le
blob relu en base.

Bornes de validation, refus par 400 hors plage :
- `reponse_ia` : `null`, ou entier de 0 à 1440 (24 h) ;
- `alerte_info` : entier de 0 à 1440 ;
- `sourdine.active` : booléen strict (`=== true`) ;
- `sourdine.debut` / `.fin` : `HH:MM` exact, 00:00 à 23:59.

⚠ **La porte à fermer dans le même commit** : le POST legacy « blob entier »
(`api/agent-config.js:127`) écrase `config` sans merge. Tout écran qui l'appelle
efface les délais des autres biens. Il n'est plus appelé par `messages.html`
(qui poste des cibles), mais il reste ouvert. À **borner ou retirer**, et c'est
une correction de sécurité de la donnée, pas du style.

### 3.2 `agent_tasks` — quatre colonnes et deux index

Migration `migrations/2026-10-27-delai-reponse-ia.sql` :

```sql
alter table agent_tasks
  add column if not exists send_after    timestamptz,
  add column if not exists alert_after   timestamptz,
  add column if not exists suspendu_le   timestamptz,
  add column if not exists modifie_le    timestamptz;

-- La lecture du cron : jamais un scan. Partiel, donc petit et chaud.
create index if not exists idx_agent_tasks_send_after
  on agent_tasks (send_after)
  where status = 'pending_validation' and send_after is not null;

create index if not exists idx_agent_tasks_alert_after
  on agent_tasks (alert_after)
  where status = 'pending' and alert_after is not null;
```

- `send_after` : échéance du brouillon. `null` = pas de départ automatique
  (Validation manuelle, ou tâche d'un autre type) — **c'est le repli sûr** :
  en l'absence de valeur, rien ne part tout seul.
- `alert_after` : échéance de l'alerte info manquante. `null` = déjà alerté, ou
  rien à alerter.
- `suspendu_le` : posé quand l'hôte ouvre le brouillon (règle 2). Tant qu'il
  est non nul, l'échéance ne mord pas.
- `modifie_le` : posé quand l'hôte enregistre un brouillon qu'il a écrit
  (décision 6). Non nul = la reprise doit l'alerter ; nul = reprise silencieuse.

⚠ **Vérifier la FORME de la migration, pas son existence** : compter les
colonnes et les index après application, en staging ET en prod — un
`add column if not exists` réussit en silence sur une table qui ne les a pas.
Script de vérification livré avec la migration
(`scripts/verifier-migration-delai-ia.js`), sur le modèle de
`verifier-migration-grille-hote.js`.

---

## 4. Comportement, règle par règle

### 4.0 La réponse IA : ce qui change dans `cron-classify`

Au point `lib/cron-classify.js:1296`, pour `sympathy` / `info_known` avec
`auto_reply` non nul, et **après** les gardes existantes (kill switch, plafond,
coupe-circuit — inchangées) :

| réglage du bien | comportement |
|---|---|
| `reponse_ia === null` | tâche `pending_validation`, `send_after = null` — **exactement l'actuel Mode Test** |
| `reponse_ia === 0` | envoi immédiat — **exactement l'actuel Mode Auto** |
| `reponse_ia === N > 0` | tâche `pending_validation`, `send_after = maintenant + N min` |

Les deux cas extrêmes sont les deux comportements d'aujourd'hui, octet pour
octet. C'est ce qui rend la migration du §6 sans effet visible.

L'écran affiche « Part dans X » et trois boutons : **Envoyer maintenant** /
**Modifier** / **Ne pas envoyer**.

### 4.1 Règle 1 — « l'hôte agit » annule tout

Quatre gestes valent action : envoyer, modifier, ignorer, **ou répondre dans le
fil depuis l'app Airbnb/Booking** (le message remonte par le webhook).

Dans tous les cas : `send_after → null` et `status → done`/`ignored` selon le
geste, et `alert_after → null` pour la famille info manquante.

Le chemin webhook s'appuie sur le socle du §2.6 : un message `source: 'host'`
qui n'est pas l'un de nos envois (`nosEnvoisBeds24`) désarme les brouillons et
les alertes en attente de cette réservation.

**Test** : fil avec brouillon `send_after` à +15 min → injecter un message
`host` → le brouillon est `ignored`, `send_after` est nul, et la passe du cron
n'envoie rien.

### 4.2 Règle 2 — ouvrir pour modifier suspend le compte à rebours

Le clic **Modifier** pose `suspendu_le = maintenant`. La passe du cron ignore
toute tâche dont `suspendu_le` est non nul.

⚠ **DÉCISION DE THIERRY (27 octobre 2026) — LE COMPTE À REBOURS REPREND.**
J'avais spécifié l'inverse (suspension définitive) ; il tranche, et la raison
est juste : *une suspension sans reprise rend le parachute inutile*, puisqu'il
suffit d'ouvrir un brouillon pour que l'oubli redevienne possible.

Reprise dans deux cas :
- l'hôte **quitte l'écran sans agir** ;
- **30 minutes sans modification** dans l'éditeur.

À la reprise, l'échéance repart avec le **temps restant** au moment de la
suspension, avec un **minimum de 5 minutes** — pour qu'un brouillon suspendu à
30 secondes de l'échéance ne parte pas sous les doigts de l'hôte.

⚠ **CE QUE CETTE DÉCISION OUVRE, ET QUI N'EST PAS ENCORE TRANCHÉ : quel TEXTE
part à la reprise ?** Aujourd'hui l'édition de l'hôte ne touche pas la base —
`agent_tasks.suggested_reply` porte le texte de l'IA, et l'écran envoie le
contenu du champ au moment du clic (`api/messages.js:238`, paramètre `texte`).
Donc, en l'état, une reprise automatique enverrait **le texte de l'IA, pas la
correction de l'hôte** : le parachute livrerait au voyageur la version que
l'hôte avait justement commencé à réécrire.

⚠ **TRANCHÉ PAR THIERRY LE 27 OCTOBRE 2026.** Le brouillon en cours est
**enregistré quand l'hôte quitte l'éditeur** (action `brouillon` sur
`/api/messages`, écrivant `suggested_reply`), et **c'est son texte qui part**
à la reprise.

**Garde-fou ajouté par Thierry** : si la reprise concerne un brouillon
**qu'il a modifié**, une alerte part vers lui **au moment de la reprise**, par
le même canal que l'info manquante — pour qu'il soit prévenu avant qu'un texte
peut-être inachevé parte. **Aucune alerte** pour un brouillon jamais touché :
le cas courant reste silencieux.

Donc `agent_tasks` porte aussi, implicitement, l'information « ce brouillon a
été modifié par l'hôte ». Pas besoin d'une colonne de plus : l'écriture de
`suggested_reply` par l'action `brouillon` pose `suspendu_le` **et** un drapeau
— retenu : **`modifie_le timestamptz`**, quatrième colonne de la migration
(§3.2), non nul = l'hôte a écrit dans ce brouillon.

⚠ **ET CE GARDE-FOU ENTRE EN CONFLIT AVEC LA SOURDINE — point n° 7 du §9.**
Thierry demande « même canal **et même sourdine** que l'info manquante », *et*
« pour que je sois prévenu **avant** qu'un texte parte ». Les deux ne tiennent
pas ensemble : une reprise à 2 h du matin, sourdine 22 h-8 h, donne une alerte
à 8 h — **après** que le brouillon est parti à son échéance. L'alerte
n'avertit plus, elle raconte.

**Test** : poser `suspendu_le`, avancer l'horloge au-delà de l'échéance →
zéro envoi tant que la suspension tient ; puis déclencher la reprise (départ
d'écran, ou 30 min sans modification) → l'échéance repart au temps restant,
jamais sous 5 minutes ; et le texte envoyé est celui de l'hôte s'il en a saisi
un.

### 4.3 Règle 3 — le voyageur réécrit : UN brouillon pour tout le fil

Mécanique **déjà en place** (`lib/cron-classify.js:1265`) : les
`pending_validation` du lot passent à `ignored` avec « Remplacée : le voyageur
a écrit depuis », puis le nouveau lot est classé en entier et produit une
réponse unique.

Ce qui s'ajoute : le remplaçant **repart avec une échéance neuve**
(`send_after = maintenant + N`). Le voyageur qui précise sa question ne raccourcit
pas le délai de réflexion de l'hôte, et ne l'allonge pas indéfiniment non plus.

**Test** : brouillon à +15 min, second message voyageur à +5 min → un seul
`pending_validation` vivant, `send_after` recalculé depuis le second message.

### 4.4 Règle 4 — à l'échéance, tout est revérifié ; claim atomique

La passe `envoyerBrouillonsDus(results, opts)` (nouveau module
`lib/guestflow/brouillons-dus.js`), appelée depuis `api/cron.js` par
`chrono.mesure('brouillons_dus', ...)`, hors de la boucle par compte :

1. **Lire les échues seulement** :
   `status = 'pending_validation'` ET `send_after <= maintenant` ET
   `suspendu_le is null`, borné (`.limit(<plafond par cycle>)`), ordonné par
   `send_after`. L'index partiel du §3.2 sert cette lecture.
2. **Claim atomique, AVANT tout envoi** :
   `update({ status: 'sending' }).eq('id', …).eq('status', 'pending_validation')
   .select('id')` → 0 ligne = quelqu'un d'autre l'a prise, on passe.
3. **Revérifier sur la tâche claimée** : kill switch (`isAutomationPaused`),
   réservation annulée, séjour terminé, coupe-circuit (`gardes-des-fils`), **et
   le réglage relu en base** (l'hôte a pu repasser en Validation manuelle entre
   la pose et l'échéance).
4. **Envoyer** par `sendGuestMessage`, lire le retour, puis `done` + journal
   `conversations` + `recordMessage` (`origine: 'ia_auto'`).
   Échec → `pending_validation` restauré avec le `summary` « NON DÉLIVRÉE » et
   l'incident `send_failure`, comme le chemin Auto le fait déjà.

⚠ **Le statut intermédiaire `'sending'` est ce qui ferme la course**, et il
oblige à deux choses : une tâche restée `sending` (crash entre le claim et
l'envoi) doit être **récupérable** — une passe de reprise la rend à
`pending_validation` au-delà d'un seuil (10 min) et le dit au fondateur —, et
l'écran doit traiter `sending` comme « en cours de départ », bouton grisé.

**Et le chemin de l'écran s'inverse** (§2.5) : `cloreProposition` claime
d'abord (`pending_validation` → `sending`), **puis** l'écran envoie, puis la
clôture pose `done`. Un 409 au claim affiche « cette réponse vient de partir »
au lieu d'envoyer un doublon.

**Test (b) du brief** : deux appels concurrents — un clic et une passe de cron
sur la même tâche → **un seul** envoi, l'autre reçoit 409 / 0 ligne. À éprouver
par deux appels réellement parallèles, pas en séquence.

### 4.5 Règle 4 bis — l'info manquante et la sourdine

À l'insertion de la tâche `info_unknown` (`lib/cron-classify.js:1437`) :
la tâche est **visible tout de suite** (inchangé), et
`alert_after = maintenant + <alerte_info>`, décalé par la sourdine.

`intervention` : **inchangé**, `alert_after = null`, alerte immédiate dans le
tour, jamais de sourdine. L'urgence ne se met pas en sourdine — c'est écrit
dans le brief et c'est la bonne décision.

**La sourdine**, règle de calcul unique dans `lib/guestflow/sourdine.js` :
l'échéance tombe dans la plage `[debut, fin[` en heure locale du bien →
l'échéance est repoussée à `fin`. Plage qui enjambe minuit (22:00 → 08:00)
traitée explicitement : c'est le cas normal, pas le cas limite.

⚠ **LE FUSEAU EN V1 : `Europe/Paris` POUR TOUS LES BIENS** — décision de
Thierry du 27 octobre 2026, dans **une constante unique**
(`FUSEAU_V1 = 'Europe/Paris'` dans `lib/guestflow/sourdine.js`), et **pas** une
lecture par bien tant qu'aucun bien n'est hors de France.

La constante porte son motif en commentaire, parce que `properties.timezone`
**existe** déjà (`migrations/2026-09-08-fiche-unifiee.sql:69`, repli
`'Europe/Paris'` dans `lib/migration-provisionner.js:38`) : sans le motif
écrit, la session qui lira « Paris en dur » dans six mois y verra un oubli et
« corrigera » un choix. Le jour où un bien sort de France, le point de
changement est unique et nommé.

Ce qui reste interdit, et c'est ce que la constante garantit : calculer une
sourdine **en UTC** en silence. C'est la famille de bugs qui a dupliqué
83 messages le 14 septembre 2026.

Et la règle du dépôt sur les tests s'applique de plein fouet ici : *dates
relatives si le test lit l'horloge, dates figées s'il injecte le temps*, **et
dans le même fuseau que le code mesure**. `opts.maintenant` est injectable dans
toute la chaîne, comme `poserPropositionsDues` le fait.

**Test (c) du brief** : info manquante à 23:30 heure du bien, sourdine
22:00-08:00 → `alert_after = 08:00` le lendemain ; aucune alerte avant ;
l'alerte part au premier cycle après 08:00. Et contre-épreuve : la même à
09:00 part à 09:00 + délai.

### 4.6 Règle 5 — les délais longs : ma proposition

**Faut-il revalider le brouillon à l'échéance quand le délai est long ?**

Ma recommandation : **oui, mais seulement au-delà d'un seuil, et seulement si
le fil a bougé.** Précisément :

- délai ≤ 60 min **ou** aucun message neuf depuis la pose → **aucun appel IA**.
  Le brouillon part tel quel. C'est le cas de la quasi-totalité du trafic
  (défaut 15 min) : coût marginal **nul**.
- délai > 60 min **et** fil modifié depuis la pose → **un** appel de
  reclassification du lot entier, qui remplace le brouillon (c'est déjà la
  mécanique de la règle 3, §4.3). Pas un appel « de contrôle » en plus : le
  même appel qui existe déjà, simplement déclenché à l'échéance plutôt qu'à
  l'arrivée du message.

**Pourquoi ce choix.** Un message neuf du voyageur déclenche **déjà** une
reclassification au cycle suivant (règle 3) : dans les faits, un fil qui bouge
est revalidé sans rien ajouter. Le seul trou réel est le fil qui bouge pour une
raison que la classification ne voit pas (changement de dates, annulation) — et
ça, le §4.4 point 3 le couvre par des gardes, sans appeler l'IA.

⚠ **LA CONTRAINTE QUE CETTE SPEC AVAIT MANQUÉE, TROUVÉE EN VÉRIFIANT LE CHIFFRE
DE THIERRY : une revalidation CONSOMME un des 3 appels du fil.**
`lib/guestflow-garde.js:27` — `PLAFOND_JOUR = 3` appels IA **réussis** par fil
(réservation) sur 24 heures glissantes ; atteint, le fil **s'arrête** et un
incident dit à l'hôte de répondre à la main. La garde est née de l'incident du
8 octobre 2026 (48 appels/heure sur Sonnet 5.5 jusqu'à épuisement du crédit).

Donc une revalidation à l'échéance peut faire franchir le plafond, et alors le
fil se bloque **au moment précis où le brouillon devait partir**. Inacceptable :
le parachute existe pour que le voyageur ait une réponse.

**Règle qui en découle, et qui est ferme** : à l'échéance, si le plafond est
atteint, **on n'appelle pas l'IA et le brouillon part tel quel**. Le texte est
déjà écrit — l'envoyer ne coûte aucun appel. La revalidation est un *bonus* qui
s'efface devant la garde, jamais une condition de l'envoi.

**Coût, sur Sonnet 5.5** (décision de Thierry du 2 octobre, maintenue le
28 : Haiku annonçait des codes non envoyés). Zéro appel supplémentaire dans le
cas courant. Dans le cas long + fil modifié + plafond non atteint : **un**
appel, **0,8 à 1,1 ct $** (2 500-4 000 tokens d'entrée à 2 $/MTok, ~300 de
sortie à 10 $/MTok). Même à 30 000 comptes ce chemin est rare par construction
— il demande un délai réglé à plus d'une heure **et** un voyageur qui réécrit
dans cette fenêtre **et** moins de 3 appels déjà passés sur le fil.

**L'alternative que j'écarte** : revalider systématiquement à l'échéance.
Elle double les appels IA de GuestFlow pour corriger un cas que la règle 3
traite déjà, et elle introduit un appel sur le chemin d'envoi — donc une
latence et un mode de panne (IA indisponible) sur un geste qui doit juste
partir. **À trancher par Thierry** avant que je code quoi que ce soit.

### 4.7 Règle 6 — le cron ne lit que les échues, et le dit honnêtement

La lecture est bornée et indexée (§3.2, §4.4 point 1). **Aucun parcours de tous
les comptes ni de tous les biens** : la passe lit `agent_tasks` par échéance,
globalement, exactement comme `poserPropositionsDues` lit `menages`.

Test mental obligatoire à 30 000 comptes × 5 biens : la passe lit les tâches
**échues**, pas les tâches. Le volume dépend du trafic réel, pas du parc. Un
plafond par cycle borne le pire cas, et le reliquat part au cycle suivant —
avec un bilan rendu pour qu'une file qui s'allonge soit visible.

**La précision = la cadence du cron, et ça s'affiche.** `/api/cron` tourne
toutes les 5 minutes : un délai de 15 min part entre 15 et 20 minutes après.
L'écran ne dit donc pas « part dans 15 min » au ras de la minute mais une
formule honnête — « part dans ~15 min » avec, dans l'aide du réglage, « au
premier passage suivant, vérifié toutes les 5 minutes ». Un délai de 0 reste
« immédiat » parce qu'il part dans le tour de classification, sans attendre
une passe.

### 4.8 Règle 7 — le front, et le mobile par construction

`pages/messages.html` (1514 lignes) est **une seule page pour l'ordinateur et
le téléphone** — pas de `messages-mobile.html`, contrairement au calendrier.
La règle « LE MOBILE SUIT L'ORDINATEUR » est donc satisfaite par construction,
**à condition de vérifier le rendu à largeur téléphone** avant la remise, pas
de le supposer.

Chargement : le compte à rebours s'affiche depuis `send_after` **déjà présent**
dans la charge des tâches (une colonne de plus sur une requête qui existe),
sans requête supplémentaire, et il est **calculé côté client** — aucun
rafraîchissement périodique, aucun appel à l'horloge serveur pour l'afficher.
Les réglages se chargent par le `GET /api/agent-config` existant.

---

## 5. Les tests

Au-delà des trois tests réels exigés par le brief (§7), la suite unitaire,
`tests/delai-reponse-ia.test.js`, avec `maintenant` **injecté** (donc dates
figées, règle du dépôt) :

| règle | ce qui est prouvé |
|---|---|
| 4.0 | `null` → `pending_validation` sans `send_after` ; `0` → envoi immédiat ; `N` → échéance posée |
| 1 | les quatre gestes désarment ; le message `host` du webhook aussi |
| 2 | `suspendu_le` non nul → la passe n'envoie pas, même très au-delà de l'échéance |
| 3 | un seul brouillon vivant, échéance recalculée |
| 4 | claim : deux appels concurrents → un seul envoi ; `sending` orphelin récupéré |
| 4 | revérification : kill switch, annulation, séjour terminé, coupe-circuit, réglage changé entre-temps |
| 4 bis | sourdine : plage qui enjambe minuit, bien sans fuseau, `intervention` jamais retardée |
| 6 | la lecture est bornée et filtrée (aucune lecture sans `status` ni borne d'échéance) |

⚠ **Tout test neuf doit rougir contre le code d'avant** (REVIEW.md règle 19),
par contre-épreuve `git archive` hors de l'arbre — jamais `git show > fichier`.

⚠ **LE COMPTE DE ROUGES ATTENDU EST 0, ET `CLAUDE.md` DIT ENCORE 28** —
constat de la revue du 27 octobre 2026, et il invalide le critère que cette
spec portait.

Mesure du jour sur `main` 8aae0f5f dans ce worktree : **6507 tests, `ℹ fail 0`**
(et `tests/booking-changes.test.js` à 26/26, alors que `CLAUDE.md` l'annonce à
8 rouges). La dette datée des quatre familles a été soldée dans les 437 commits
des dix-huit derniers jours.

**Pourquoi ça compte plus qu'une ligne à rafraîchir** : une barrière réglée
trop haut ne barre plus rien. Une session qui lit « attendu 28 » et mesure
3 rouges conclut « bien en dessous, tout va bien » — et pousse une régression.
C'est le défaut exact que la règle de comptage existait pour empêcher, retourné
contre elle.

**Avant la remise : lire `ℹ fail N`, pas la couleur. 1 rouge = une régression**,
on ne pousse pas tant qu'elle n'est pas nommée. `CLAUDE.md` reste à corriger —
fichier partagé, décision de Thierry ou du chef de file.

**Test obligatoire de la fiche d'agent** : zéro message réel parti — relever
`message_sent_log` avant et après.

---

## 6. Migration de l'existant, sans changement de comportement

Un seul passage, idempotent, dans `migrations/2026-10-27-delai-reponse-ia.sql`
ou par script selon ce que Thierry préfère auditer :

| existant | devient |
|---|---|
| `mode: 'auto'` | `delais.reponse_ia = 0`, `alerte_info = 0`, `sourdine.active = false` |
| `mode: 'test'` | `delais.reponse_ia = null`, `alerte_info = 0`, `sourdine.active = false` |
| absence d'entrée | rien n'est écrit ; le repli de lecture vaut `'test'` → Validation manuelle |

`alerte_info = 0` pour tout le monde, parce que c'est le comportement actuel
(§2.2 : l'alerte part dans le tour, quel que soit le mode). Mettre 15 min ici
changerait le comportement de biens en production sous couvert de migration.

**Les défauts 15 min / 15 min du brief s'appliquent aux biens NEUFS**, à
l'onboarding (`pages/onboarding.html:305`, qui préremplit déjà
`agent_alert_config`), pas aux biens existants.

Le temps de la migration, `getPropertyMode` lit `delais.reponse_ia` s'il
existe et retombe sur `mode` sinon. **La clé `mode` n'est retirée qu'une fois
les deux chemins prouvés d'accord**, dans un second commit.

---

## 7. Recette réelle (brief, méthode)

Sur les biens de Thierry, en **canary** :

- **(a)** réponse de l'hôte depuis l'app Airbnb → brouillon annulé ;
- **(b)** clic « Envoyer » pendant que le cron prend la tâche → un seul envoi ;
- **(c)** info manquante pendant la sourdine → alerte au matin.

⚠ **(b) ne s'éprouve pas en production** : un double envoi réel part chez un
voyageur. Il s'éprouve en staging, ou sur un double qui crie. En prod, (b) se
vérifie par la **trace** (un seul `message_sent_log`, un 409 journalisé), pas en
provoquant la course.

### Deux pièces ajoutées par Thierry le 27 octobre 2026

- **(d) un envoi différé sur une réservation DIRECTE (`Offline`) part bien par
  e-mail, et la réponse apparaît dans le fil.** C'est la recette du constat 2
  **et** du constat 1 d'un seul geste : si l'objet de la réservation ne traverse
  pas jusqu'à l'envoi, le message part vers la messagerie OTA et Channex rend
  422 ; et si le journal du cœur n'est pas écrit, le fil reste muet alors que le
  voyageur a reçu. Les deux défauts se voient sur le même écran.
  **À vérifier dans cet ordre** : le voyageur reçoit l'e-mail ; la bulle de
  réponse apparaît dans le fil de `/messages` ; `messages` porte une ligne
  `outbound / sender: ai / canal: email / origine: ia_differee` ;
  `conversations` porte sa ligne.
- **(e) un envoi IMMÉDIAT Airbnb se comporte comme avant le merge.** C'est la
  contre-épreuve du module partagé : les quatre écritures du cœur ont déménagé
  dans `lib/guestflow/journal-envoi-ia.js`, donc le chemin immédiat — **en
  production depuis des semaines** — a été touché. Un envoi Airbnb immédiat doit
  produire exactement ce qu'il produisait : même bulle, même ligne `messages`
  (`origine: 'ia_auto'`, pas `ia_differee`), même ligne `conversations`, même
  fermeture d'une tâche « reçu pendant la pause » s'il y en a une.

### L'activation en production se fait par UN bien (décision de Thierry)

**`La bulle` d'abord, et elle seule.** Les autres biens restent sur leur réglage
actuel — c'est-à-dire, après la migration, `reponse_ia: 0` (immédiat) ou `null`
(validation manuelle), donc **le comportement qu'ils ont aujourd'hui**. Aucun
autre bien ne reçoit de délai avant que Thierry ait vu **un vrai envoi différé
passer de bout en bout**.

Ce que cela veut dire concrètement : la migration des données tourne sur tous
les biens (elle ne change aucun comportement, c'est son cahier des charges),
puis **Thierry seul** pose un délai sur `La bulle` depuis l'écran. Le parachute
ne protège donc qu'un bien jusqu'à son go — et c'est la bonne façon d'éprouver
un mécanisme qui envoie au voyageur sans qu'un humain relise.

⚠ **Staging n'a aucun cron** (`docs/STAGING.md:276`) : la passe se lance à la main
par `scripts/piloter-brouillons-dus.js` (à blanc, puis `--go`), sur le modèle de
`scripts/piloter-yieldflow.js`.

---

## 8. Fichiers touchés — et ce qui intéresse le chef de file

| fichier | nature | risque de conflit |
|---|---|---|
| `lib/cron-classify.js` | point 1 du §2.1 + insertion `info_unknown` | **élevé** — fichier très vivant |
| `api/cron.js` | une passe de plus | ⚠ **PARTAGÉ, régénéré en ENTIER, jamais patché** |
| `lib/cron-shared.js` | `getPropertyMode` apprend `delais` | moyen |
| `api/agent-config.js` | 3e cible `delais` + fermeture du POST legacy | faible |
| `api/messages.js` | `cloreProposition` : claim AVANT envoi | moyen |
| `pages/messages.html` | « Part dans X », 3 boutons, écran de réglage | moyen |
| `lib/alert-notify.js` | appel différé (le module ne change pas de contrat) | faible |
| `lib/guestflow/brouillons-dus.js`, `lib/guestflow/sourdine.js` | **neufs** | nul |
| `migrations/2026-10-27-delai-reponse-ia.sql` | 4 colonnes, 2 index | nul |
| `docs/kb/guestflow.md`, `docs/kb/alertes.md` | **même commit** | faible |

**Ordre des migrations à la remise** : une seule, `2026-10-27-delai-reponse-ia`,
avant le déploiement du code (les colonnes doivent exister quand le code lit).

**À observer au premier cycle de cron après merge** : la ligne
`brouillons_dus` du bilan (`results`), le compte d'envois, et
`automation_incidents` — une tâche `sending` orpheline ou une file qui
s'allonge se voient là, pas dans le code HTTP du cron (qui rend 200 même en
pleine panne : `results.errors` est le seul endroit qui dit la vérité).

---

## 9. Décisions de Thierry (27 octobre 2026) et ce qui reste ouvert

Les cinq questions du §9 d'origine sont tranchées :

| # | question | décision |
|---|---|---|
| 1 | modèle IA | **Sonnet 5.5**, choix délibéré du 2 octobre (Haiku annonçait des codes non envoyés). Chiffrage sur Sonnet. Pas un levier de coût. |
| 2 | fuseau de la sourdine | **`Europe/Paris` pour tous**, constante unique, pas de lecture par bien en v1. |
| 3 | règle 5 (revalidation) | **ma proposition du §4.6 retenue** : délai > 60 min ET fil modifié. |
| 4 | suspension du §4.2 | ⚠ **contredit ma spec** : le compte à rebours **reprend** — départ d'écran ou 30 min sans modification, temps restant, 5 min minimum. |
| 5 | plafond par cycle | **oui**, surplus au cycle suivant, compté dans `cron-stats`. Les plafonds existants restent prioritaires. |

**Sur la réponse 5, le chiffre de Thierry est exact et je l'avais sous-estimé** :
`PLAFOND_JOUR = 3` appels IA réussis par fil sur 24 h glissantes
(`lib/guestflow-garde.js:27`), plus le délai croissant après échec (5, 10, 20,
40 min… plafonné à 6 h). Ces gardes **précèdent** tout ce que ce chantier pose,
et la conséquence sur la règle 5 est écrite au §4.6 : plafond atteint à
l'échéance → **pas d'appel, le brouillon part tel quel**.

### Décision 6 (27 octobre 2026)

**Le brouillon en cours est enregistré au départ de l'éditeur, et c'est le
texte de l'hôte qui part à la reprise.** Garde-fou : une alerte prévient l'hôte
au moment de la reprise **si** le brouillon a été modifié ; rien pour un
brouillon jamais touché. Détail au §4.2. Conséquence sur le schéma : une
quatrième colonne `modifie_le` (§3.2).

### Décision 7 (27 octobre 2026) — la nuit, un brouillon MODIFIÉ ne part pas

Thierry a tranché, et sa réponse ajoute **deux règles que ma recommandation
n'avait pas** :

1. **La sourdine retarde l'alerte ET l'envoi** — mais **seulement pour un
   brouillon que l'hôte a modifié** (`modifie_le` non nul). Un brouillon
   **jamais touché n'est pas concerné par la sourdine** : il part la nuit comme
   en journée. La sourdine protège le texte incertain, pas la réponse de l'IA.
2. **Un délai de grâce de 15 minutes entre l'alerte et l'envoi** : l'alerte part
   à la fin de la sourdine, et le brouillon **au plus tôt 15 minutes après
   l'alerte**.

**Pourquoi la règle 2 change tout, et pourquoi je ne l'avais pas vue** : sans
elle, l'alerte et l'envoi tombent au même instant, et l'alerte « avertit »
d'une chose déjà faite. Quinze minutes, c'est le temps de lire le SMS et de
cliquer « Ne pas envoyer ».

⚠ **UNE LECTURE QUE JE PRENDS ET QUE THIERRY DOIT CORRIGER SI ELLE EST
FAUSSE** : j'applique le délai de grâce de 15 minutes à **tout** brouillon
modifié dont la reprise déclenche une alerte, pas seulement à ceux qui sortent
d'une sourdine. Un brouillon modifié dont l'échéance tombe à 14 h déclenche donc
l'alerte à 14 h et l'envoi à 14 h 15. Sans ça, l'alerte de journée serait
simultanée à l'envoi — exactement le défaut que la décision 7 corrige pour la
nuit.

**La chronologie complète d'un brouillon MODIFIÉ, sourdine 22 h–8 h :**

| moment | ce qui se passe |
|---|---|
| 21 h 50 | l'hôte ouvre le brouillon, le corrige, quitte sans envoyer → `suspendu_le` et `modifie_le` posés, son texte est enregistré |
| 22 h 20 | reprise (30 min sans modification) → échéance = temps restant, minimum 5 min |
| dans la sourdine | ni alerte ni envoi |
| 8 h 00 | **l'alerte part** (SMS/e-mail, canal de l'info manquante) |
| 8 h 15 | **le brouillon part**, si l'hôte n'a rien fait entre-temps |

Un brouillon **jamais touché** ignore tout ce tableau : il part à son échéance,
nuit comprise, sans alerte.

---

## 10. Découpage en lots — review à chaque commit, remise à chaque lot

| lot | contenu | dépend de la question 6 |
|---|---|---|
| **1 — socle, invisible** | migration (4 colonnes, 2 index) + vérificateur ; 3e cible `delais` dans `/api/agent-config` + bornage du POST legacy ; `getPropertyMode` dérive `test`/`auto` de `delais.reponse_ia` avec repli sur `mode`. **Aucun comportement différé, et AUCUN écran** : à la fin du lot 1, la production se comporte exactement comme avant. | non |
| **2 — le différé de la réponse IA** | `send_after` posé par `cron-classify` ; passe `envoyerBrouillonsDus` + statut `sending` + reprise des orphelines ; **inversion de l'ordre claim/envoi** dans `cloreProposition` ; **l'écran de réglage des trois délais** ; « Part dans X » et les trois boutons ; suspension et reprise (§4.2) ; revalidation du §4.6. | **oui** |
| **3 — l'alerte info manquante** | `alert_after` + sourdine (`lib/guestflow/sourdine.js`, `FUSEAU_V1`) ; `intervention` inchangé ; passe d'alertes dues. | non |
| **4 — bascule** | retrait de la clé `mode` du blob, une fois les deux chemins prouvés d'accord (§6). | non |

⚠ **LA MIGRATION DES DONNÉES (§6) N'ÉTAIT DANS AUCUN LOT — trou de cette spec,
trouvé en traitant la revue.** Elle appartient au **lot 2**, avec l'écran et le
moteur : avant eux, aucun bien n'a besoin d'un bloc `delais`, et l'écrire plus
tôt n'exposerait que le piège du constat 1 (deux clés à tenir d'accord) sans
aucun bénéfice. Conséquence pour le lot 1 : **aucun bien n'a de bloc `delais`
en production**, donc toute la machinerie de dérivation est inerte — ce qui est
exactement ce qu'on veut d'un socle.

### Le réglage de l'hôte survit au toggle (constat 5 de la seconde revue)

Tant que l'interrupteur Test/Auto coexiste avec le délai (jusqu'au lot 4), le
basculer détruisait le délai réglé : 30 minutes → Test → Auto → `0`, donc envoi
immédiat, sans trace. La dernière valeur non nulle est donc **mémorisée**
(`delais.reponse_ia_rappel`) au passage en Test et **restituée** au retour en
Auto. Sans rappel, Auto vaut `0` — le sens exact du Mode Auto d'avant. Un
champ transitoire, qui disparaît avec la clé `mode` au lot 4.

⚠ **CORRIGÉ LE 28 OCTOBRE 2026, EN DEUX POINTS — recette de Thierry.**

1. **Sans rappel, la sortie de la validation manuelle vaut `15`, plus `0`.**
   La confirmation qu'il a dictée dit « les réponses de l'IA partiront seules
   **après le délai choisi** » ; le geste posait `0`, c'est-à-dire l'envoi
   immédiat. L'écran montrait bien la pilule « Tout de suite » cerclée, donc qui
   regardait n'était pas trompé — mais qui confirmait puis enregistrait sans
   regarder armait des envois sans relecture. `0` reste atteignable, par un clic
   sur sa pilule : c'est alors un choix, plus un défaut.
2. **Et le rappel n'était plus restitué à l'hôte.** « Restitué au retour en
   Auto » décrivait l'interrupteur Test/Auto, disparu de l'écran au lot 2. Le
   lecteur existe toujours côté serveur — la branche `cible === 'mode'` de
   `api/agent-config.js` le rend — mais **plus aucun écran ne poste `mode_ref`** :
   le souvenir était rangé pour l'onboarding et les scripts, jamais pour l'hôte.
   Le geste équivalent — quitter « Je valide chaque réponse » — le lit désormais
   (`delaiDeSortieManuelle`, `pages/messages.html`), et un souvenir hors contrat
   retombe sur les 15 minutes.
3. **L'entrée en validation manuelle capture la valeur courante**
   (`basculerValidationManuelle`), parce que l'état d'édition vit avant
   l'enregistrement : l'hôte tape 30 min, clique « Je valide chaque réponse »,
   revient — sans cette capture il retombait à 15 et sa valeur, affichée deux
   secondes plus tôt, était perdue sans un mot. C'est la même asymétrie que
   `api/agent-config.js` a dû corriger de son côté (son constat 4 : « je ne lisais
   que l'ancien rappel, jamais le `reponse_ia` COURANT »). L'écran ne **poste**
   jamais ce champ : l'endpoint en reste le writer unique.

### Un bien en pause ne promet aucun envoi (recette du 28 octobre 2026)

**Constat de Thierry** : sur un bien en « Automatisation en pause », une
proposition échue affichait « Part d'un instant à l'autre » en ambre — alors
que `lib/guestflow/brouillons-dus.js` refuse la tâche dès l'entrée
(`motif: 'automatisation_en_pause'`). Rien ne partira, ni à l'échéance, ni
après.

Le bandeau dit donc **« En pause : ne partira pas seule », en gris** — l'ambre
est réservé à ce qui est en cours — et **aucun compte à rebours ne s'affiche
sur un bien en pause**, avant comme après l'échéance.

⚠ **ET LA PORTÉE EST LE MOTIF `automatisation_en_pause`.** `encoreLegitime`
(`lib/guestflow/brouillons-dus.js`) refuse un brouillon pour **onze** motifs
distincts — `reglages_illisibles`, `biens_illisibles`, `bien_introuvable`,
`automatisation_en_pause`, `reglage_introuvable`,
`repasse_en_validation_manuelle`, `reglage_hors_contrat`,
`reservations_illisibles`, `reservation_introuvable`, `reservation_annulee`,
`sejour_termine` — dont deux sont des **pannes de lecture**, pas des états de
la donnée. Le bandeau n'en **dit** qu'un : celui-là.
*(Deux chiffres faux ont vécu ici, « neuf » et « les sept autres » : ils ne
tombaient juste qu'en excluant en silence les deux pannes de lecture puis les
deux motifs traités. Relevé en revue — c'est la famille que le correctif 7 de
ce même commit existe pour fermer, et je l'avais rejouée dans la phrase qui
l'annonçait.)* Le changement de réglage, traité par
la section suivante, ne se dit pas — il **désarme**, donc le compte à rebours
disparaît au lieu d'être expliqué. Les sept autres motifs sont en **dette**,
plus bas.

### Le dernier réglage gouverne aussi les brouillons déjà en attente

**Constat, même recette.** Le réglage ne valait que pour les brouillons **à
venir** : `lib/cron-classify.js` lit le délai au moment de **créer** la tâche,
et plus rien ne la relit. Donc un brouillon armé à +60 min survivait au retour
en validation manuelle — « Part dans 59 min » en ambre pendant une heure, puis
« Part d'un instant à l'autre », et à l'échéance le cron le refusait avec
`repasse_en_validation_manuelle`. La même phrase que pour la pause, par une
autre porte.

**Décision de Thierry (28 octobre 2026), mot pour mot** : « à l'enregistrement,
les brouillons en attente du bien suivent le nouveau réglage. Validation
manuelle → désarmés, plus de compte à rebours. Autre délai → échéance
recalculée depuis la création du brouillon (si elle est déjà passée, il part au
prochain passage, c'est ce que l'hôte a demandé). **Mon dernier réglage
gouverne toujours.** »

| réglage enregistré | ce que deviennent les brouillons en attente du bien |
|---|---|
| `reponse_ia = null` | `send_after = null` **et** `suspendu_le = null` — plus de compte à rebours |
| `reponse_ia = N` | `send_after = created_at + N min` |
| `reponse_ia = 0` | `send_after = created_at`, donc échu — il part au prochain passage |
| `created_at` illisible | `send_after = maintenant + N` — le repli le plus **tardif**, compté à part (`sans_creation`) |
| hors contrat | **désarmement** — un blob illisible ne fait rien partir |

⚠ **ET L'ARRIÉRÉ DE LA VALIDATION MANUELLE SE COMPTE AVANT LE GESTE.** C'est la
moitié que la table ci-dessus, écrite au singulier, ne disait pas, et elle a
été relevée en revue.

Sous « Je valide chaque réponse », les brouillons s'accumulent **sans
échéance** : ils attendent parce que l'hôte ne les a pas validés, et il peut y
en avoir un par (réservation × type), vieux de plusieurs jours. En sortir les
réarme à `created_at + N`, donc **tout ce qui a plus de N d'âge est échu et
part dans les cinq minutes, quel que soit N**. Un hôte qui choisit 24 h *pour
être prudent* verrait partir tout son arriéré de plus de 24 h — et la
confirmation qu'il vient de lire lui a promis « après le délai choisi ».

Le dépôt a déjà gradué la règle pour les gestes de masse vers l'extérieur —
4.6.6 « exige leur **nombre** et leurs **bornes** », grille « N nuits vont
changer de prix ». Ici la cible est le téléphone d'un voyageur, donc :

- `/api/agent-config` accepte **`apercu: true`** sur la cible `delais` : même
  garde, même validation du payload, et il **sort avant l'upsert** — il ne
  compte que, sans rien écrire ;
- l'écran le demande **avant** d'enregistrer, et si `echues > 0` il annonce le
  nombre ;
- **ne pas savoir combien n'autorise pas à les libérer** : un aperçu illisible
  enregistre les réglages mais **ne propage pas**, comme 4.6.6 rétablit l'état
  d'avant quand il ne peut pas compter ;
- `0` n'est pas un cas à part : il rend tout l'arriéré échu, et le nombre
  s'affiche comme pour les autres.

⚠ **`echues` EST UNE BORNE HAUTE, ET LA PHRASE AFFICHÉE LE DIT** — ma première
version l'annonçait comme un fait (« partiront »), et c'était faux. Deux
filtres de plus vivent **en aval** : `lireLesDues` écarte les tâches
**suspendues** (`.is('suspendu_le', null)`) — or ce lot les garde suspendues
exprès au réarmement — et `encoreLegitime` rejoue onze motifs à l'échéance,
dont trois durables que le writer ne peut pas connaître sans lire d'autres
tables. Un bien **en pause** accumule des brouillons échus que le cron refuse à
chaque passage : ils comptaient, et aucun ne partirait. Donc :

- les tâches suspendues sont **exclues** du compte ;
- l'écran **ne pose pas la question** sur un bien qu'il *sait* en pause (si la
  carte des pauses n'est pas fiable, il demande — il ne suppose pas l'absence) ;
- la phrase dit « **pourraient** partir dès le prochain passage ».

La direction reste conservatrice : on sur-compte, jamais l'inverse.

**Ce que ça ne change pas** : la décision reste la sienne. L'aperçu ne refuse
rien, il chiffre. Et **refuser ne coûte pas le reste du panneau** : `delais`
porte trois réglages, donc un refus envoie `propager: false` — le blob est
enregistré, la sourdine et l'échéance d'alerte avec, et les brouillons déjà en
attente gardent leur échéance. C'est le comportement d'avant ce lot, et c'est
exactement ce que l'hôte a choisi en refusant.

**Writer unique : `lib/guestflow/appliquer-delai.js`**, appelé par
`/api/agent-config` **après** l'upsert du blob. Six choses qui ne se devinent
pas :

- **Le délai se compte depuis le message du voyageur, pas depuis le clic.** Un
  brouillon né à 14 h avec 60 min part à 15 h, que l'hôte ait réglé à 14 h 01
  ou à 14 h 50. Sans ça, chaque passage dans le tiroir repousserait l'envoi.
- **Une échéance déjà passée est posée telle quelle**, sans plancher : c'est
  littéralement ce qu'il a demandé, et la passe la prendra au tour suivant.
- **Au désarmement, `suspendu_le` tombe aussi.** C'est le constat 5 de la
  seconde revue du lot 2, rejoué : désarmer en laissant la suspension donne un
  état **sans issue** — « vous modifiez » pour toujours, sans lien de reprise
  (le pied exige une échéance) et sans reprise automatique possible.
- **Au réarmement, `suspendu_le` est GARDÉ.** La suspension protège le brouillon
  **ouvert dans la saisie** : l'effacer armerait un compte à rebours sur un
  texte en train d'être écrit. Elle ne contredit pas le réglage, elle le
  **diffère** — `send_after` suit bien le nouveau réglage.
- **Le périmètre est le bien, le compte et `pending_validation`.** L'update est
  conditionné sur le statut : une tâche que le cron a claimée en `sending`
  entre la lecture et l'écriture n'est pas ressuscitée.
- **Et ce cas-là a son propre compteur, `deja_prises`.** Zéro ligne mise à jour
  n'est pas « rien à faire » : la tâche était à valider quand on l'a lue, elle
  ne l'est plus. Le cron lit `agent_alert_config` **une fois par lot, hors de sa
  boucle** — son propre commentaire chiffre la fenêtre à « jusqu'à vingt
  secondes » — donc `encoreLegitime` peut relire un blob périmé et le message
  part **avec le réglage d'avant**. C'est le seul cas où « Enregistré » serait
  un mensonge sur le chemin du voyageur, et l'écran le nomme. La fenêtre
  elle-même est préexistante ; ce lot ne la ferme pas, il cesse de la taire.
- **`updated_at` n'est pas touché sur une tâche suspendue.**
  `reprendreSuspensionsDormantes` lit ce champ comme une mesure d'**inactivité
  de l'hôte sur ce brouillon** (son parachute de 30 min, décision 4). Or
  enregistrer le panneau est un geste sur le **bien** : le réécrire repoussait
  le parachute de 30 minutes à chaque sauvegarde, et rendait
  `send_after − suspendu_le` — « ce qui restait quand l'hôte a ouvert » —
  arbitraire. La direction était tardive, donc sans danger pour le voyageur ;
  elle affaiblissait quand même une garde de l'hôte.
- **Une `data` qui n'est pas un tableau est refusée** (`lecture_illisible`).
  PostgREST en rend toujours un sur un select : `undefined` sans erreur est une
  réponse que le vrai client ne peut pas produire. La lire comme « aucune
  ligne » avait rendu **vert** un double de test non thenable — donc muter la
  référence du bien ou le compte passés par l'endpoint ne rougissait nulle part.
- **La lecture est paginée par curseur sur `id`**, et une troncature se **dit**
  (`motif: 'trop_de_brouillons'`) au lieu de passer pour un succès. Une panne de
  lecture ne vaut pas « aucun brouillon ».

**Et l'échec se dit à l'hôte.** Le réglage est enregistré **avant** la
propagation — c'est lui qui gouverne les brouillons à venir, il n'y aurait rien
à propager s'il échouait. Si la propagation échoue, l'endpoint **ne rend pas
500** : le réglage, lui, est pris. Il redescend un bilan `brouillons`, et
l'écran en fait une partie non enregistrée **distincte** des délais —
« Enregistré en partie. Non enregistré : les propositions déjà en attente. »
L'hôte doit savoir que son ancien compte à rebours court toujours. Un bilan
**absent** compte comme un échec : un endpoint plus vieux que l'écran ne doit
pas faire croire que les brouillons ont suivi. Et quand des échéances ont
bougé, l'écran **relit les tâches** — sinon le fil garderait à l'écran le
compte à rebours d'avant, c'est-à-dire le défaut même qu'on corrige.

### Dettes du chantier, datées du 28 octobre 2026 (décisions de Thierry)

**D1 — rendre la lecture des pauses délégable.** `/api/property-automation` GET
n'honore pas `X-Compte` (il n'est pas `compteDelegue`), alors que les tâches
sont lues sur `compteCourant()`. Conséquence **acceptée** par Thierry : sur un
compte délégué, aucun bandeau d'échéance ne s'affiche, parce que l'écran ne
peut pas savoir si le bien est en pause et a cessé d'affirmer. Lever la dette
demande de rendre ce GET délégable — donc de toucher une garde, avec la
discipline qui va avec. Les deux boutons « Proposer une réponse » lisent la
même carte sans le drapeau de fiabilité : ils restent cliquables et le serveur
refuse (409 `en_pause`, `api/guestflow-proposer.js`), ce qui est acceptable — un
bouton propose, il ne promet pas.

⚠ **À RÉGLER EN MÊME TEMPS QUE D1, et c'est une conséquence qui ne se devine
pas.** Le jour où `/api/agent-config` devient `compteDelegue`, `accountUserId`
désignera le **titulaire**, et `appliquerDelaiAuxBrouillons` deviendra le chemin
par lequel un membre `reglages: write` **désarme ou libère les réponses
voyageur du titulaire**. C'est cohérent avec la garde, mais personne ne l'a
décidé : à trancher avant de lever la dette, pas en la levant. Aujourd'hui la
garde est sans `compteDelegue`, donc le writer n'écrit que les tâches de
l'appelant — et pour un membre délégué, son réglage ne fait rien.

⚠ **ET LA PROPAGATION RAPPORTE UN SUCCÈS SUR UN PÉRIMÈTRE QUI N'EST PAS CELUI
AFFICHÉ**, ce que la première version de cette dette ne disait pas. Sur un
compte délégué : l'aperçu rend `echues: 0`, l'enregistrement rend
`brouillons.ok: true` avec `desarmes: 0, rearmes: 0`, et l'écran affiche
« Enregistré » sans réserve. Les zéros sont vrais pour le compte de l'appelant
et faux pour le bien qu'il regarde. À fermer avec D1, par la même correction.

**D2 — les motifs de refus que le bandeau ne dit pas.** Sur les **onze** de
`encoreLegitime`, deux sont traités : `automatisation_en_pause` (le bandeau le
dit) et `repasse_en_validation_manuelle` (le désarmement fait disparaître le
compte à rebours). Deux autres sont des pannes de lecture, qui n'ont rien à
afficher. Restent **sept états de la donnée**, dont les deux plus
atteignables :

- `bien_introuvable` — clé migrée : la tâche porte une référence que
  `properties.provider_property_id` ne porte plus (même famille que
  « identité du bien vs clé provider ») ;
- `reservation_annulee` — la réservation a été annulée depuis la création du
  brouillon.

Dans les deux cas le compte à rebours continue de courir à l'écran et le cron
refuse à l'échéance. La voie probable est de faire lire au bandeau le **motif
de refus** calculé côté serveur plutôt que de recopier neuf règles dans la page
— ce qui suppose de descendre ce motif avec la tâche, et donc un passage par le
cœur. À cadrer avant d'être codé.

**D3 — un update par tâche, en série, dans un handler HTTP.**
`appliquerDelaiAuxBrouillons` lit une page puis écrit ligne à ligne. Le pire cas
est borné par le module lui-même (`PAGE × MAX_PAGES` = 20 000 aller-retours), et
`api/agent-config.js` n'a pas de `maxDuration` dans `vercel.json`.

**C'est un choix, pas un oubli** : la branche « validation manuelle » tiendrait
en **un** seul statement sans lecture préalable, mais c'est précisément la
lecture-puis-update-conditionnel qui permet de voir qu'une tâche nous a échappé
(`deja_prises`, ci-dessus) — et ce fait-là est sur le chemin de l'envoi au
voyageur. Le taire coûte plus cher que les aller-retours, au volume d'un bien.
À reprendre si un compte accumule des centaines de propositions en attente sur
un même bien : la voie est de grouper les réarmements par `created_at` identique
et de garder le chemin conditionnel pour le reste.

**Ce qui est fait dès maintenant, parce que ça ne pouvait pas attendre** : la
lecture `user_id + property_id + status` n'était servie par **aucun index** —
`agent_tasks` ne portait que `created_at`, `lock_battery` et les deux index
**partiels** du lot 1, lesquels exigent `send_after is not null`, condition que
ce module ne pose pas (son objet est de réarmer aussi les tâches désarmées).
C'était donc un scan filtré de tout l'historique des tâches de tous les
comptes, à chaque enregistrement de panneau.
**Migration `migrations/2026-10-28-brouillons-du-bien.sql`** — un index partiel
`(user_id, property_id, id) where status = 'pending_validation'`. Elle n'a
**aucun script de vérification, volontairement** : PostgREST n'expose pas
`pg_indexes`, et un script qui ne peut rien lire et sort vert se cite ensuite
comme preuve. La preuve est le plan de la requête, et l'en-tête du fichier
porte l'`explain analyze` à coller.

Trois conséquences qui ne se devinent pas :
- **La pause passe avant « vous modifiez ».** Les deux états sont gris et
  vrais, mais la suspension dit que le compte à rebours *attend* ; la pause dit
  qu'il n'y en a plus. Sur un bien en pause, il ne reprendra jamais.
- **« Envoyer dans X » disparaît aussi**, parce que c'est un compte à rebours :
  il **arme** une échéance que le serveur refusera. Ce qui reste à l'hôte n'est
  pas diminué — le bouton Envoyer de la saisie est là, et un envoi à la main
  n'est pas coupé par la pause.
- **Une seule cascade pour les deux places.** La bulle et le bandeau de la
  saisie décidaient chacun de leur côté : le défaut était à corriger deux fois,
  et rien n'aurait rougi si j'avais oublié le second. Les cinq états sont
  désormais jugés par `etatEcheance(x, pauses, fiables)`, et la carte des pauses
  entre en argument pour que la règle se teste sans monter l'écran. Le test
  **compte** son périmètre : `class="bulle__echeance"` ne s'écrit nulle part
  ailleurs que dans cette fonction, et les deux appelants l'appellent.

### Quand l'écran ne sait pas, il ne promet rien

Deux fois la carte des pauses ne dit pas ce que le bandeau en tirait :

- **La lecture peut échouer.** `/api/property-automation` en 503, en panne
  réseau, ou sa relecture après une bascule : le repli posait une carte **vide**,
  donc « aucun bien n'est en pause », donc le compte à rebours ambre.
- **Elle ne couvre que les biens de l'appelant.** Ce GET n'honore pas `X-Compte`
  (il n'est pas `compteDelegue`), alors que les tâches sont lues sur
  `compteCourant()`. Sur un compte **délégué**, la carte est vide pour une tout
  autre raison que l'absence de pause — et un bien en pause y affichait
  « Part dans X ».

`brouillons-dus.js` tient la règle dans le bon sens et son commentaire la
nomme : **« une panne de lecture empêche l'envoi, elle ne l'autorise pas »**
(replis `reglages_illisibles` / `biens_illisibles`). L'écran tenait l'inverse.

Il y a donc un cinquième état, `inconnu` — lecture ratée **ou** compte qui
n'est pas celui de l'appelant — et **il ne peint rien** : ni compte à rebours,
ni « Envoyer dans X ». Une pause **connue** reste dite, elle.

⚠ **Ce que ça coûte, et c'est assumé faute de décision** : sur un compte
délégué, plus aucun bandeau d'échéance ne s'affiche. Retirer une phrase qui
peut être fausse va de soi ; écrire à la place un « on ne sait pas » avec son
motif — ce que le dépôt fait pour un `null` non calculable — est une phrase
neuve à l'écran, donc une décision de Thierry. L'autre voie, plus propre,
est de rendre ce GET délégable, ce qui touche une garde.

Les deux boutons « Proposer une réponse » (`pages/messages.html`) lisent la
même carte **sans** ce drapeau : ils restent cliquables quand elle est inconnue,
et le serveur refuse. Inchangé par ce lot, noté ici parce que c'est le même
défaut sous une forme qui n'affirme rien — un bouton propose, il ne promet pas.

⚠ **L'ÉCRAN DE RÉGLAGE EST PASSÉ DU LOT 1 AU LOT 2, ET C'EST UNE CORRECTION DE
CETTE SPEC.** Je l'avais placé au lot 1. Un écran qui propose « délai de
réponse : 15 min » alors que le moteur du lot 2 n'est pas livré **promet à
l'hôte un comportement qui n'existe pas** : il réglerait 15 minutes, et sa
réponse partirait immédiatement (ou pas du tout). Le dépôt entier tient sur
l'inverse — un écran ne dit jamais ce qui n'est pas vrai, un `null` s'affiche
« non calculable » avec son motif. Le réglage arrive donc avec le moteur qui
l'honore, dans le même lot.

Conséquence : **le lot 1 ne se recette pas à l'écran**, il se prouve par le
vérificateur de migration et par les 30 tests du §5 — dont **19 sont des tests
d'ÉQUIVALENCE**, verts contre le code d'avant comme contre le neuf. C'est la
preuve que Thierry demande pour la remise.

Chaque lot : `npm test` avec le **compte** de rouges lu (`ℹ fail N`, attendu
**0** — voir §5 : `CLAUDE.md` annonce encore 28, la mesure dit 0), review
locale, KB `guestflow.md` + `alertes.md` dans le **même commit**, puis remise au
chef de file avec les cinq éléments.

### Les quatre points de la recette du 28 octobre 2026

Quatre défauts relevés par Thierry sur staging, corrigés en un commit. **Les
points 1 et 3 n'étaient qu'un seul défaut**, et c'est la partie qui vaut d'être
retenue.

**Points 1 et 3 — une écriture gelait des contrôles qui n'écrivent pas.**
Symptômes rapportés : « en sortant de *Je valide chaque réponse*, aucune
confirmation n'apparaît » et « juste après le décochage de la pause, le premier
clic sur une pilule est perdu ». Même cause : `basculerPause` pose
`etat.modeEnCours = true` pendant ses **deux** appels réseau (écriture puis
relecture), et tout le panneau se rendait `disabled` — y compris la pilule
« Je valide chaque réponse » et les pilules de délai, **qui n'écrivent rien** :
elles posent une valeur dans `etat.delaisEdit`, que le re-rendu de fin de
`basculerPause` relit. Un navigateur n'envoie **aucun** `click` sur un bouton
désarmé : pas de dialogue, pas de bascule, rien à l'écran.

⚠ **Et c'est pour ça que le test qui gardait la confirmation restait vert.**
`tests/messages-v5.test.js` cherchait la LIGNE `window.confirm(t('messages.
mode_confirm_auto'))` dans la source. La ligne y était, le gestionnaire était
branché, le texte était traduit dans les trois langues — et la garde produit du
11 octobre 2026 tombait quand même, par un attribut HTML. **Un grep prouve
qu'un texte existe ; il ne prouve pas qu'un geste le traverse.**

La règle posée : **pendant une écriture de réglage, seul ce qui ENVOIE est
gelé.** Deux drapeaux, et un seul endroit où ils se posent :

| drapeau | posé par | gèle |
|---|---|---|
| `etat.modeEnCours` | toute écriture de réglage | la réentrance, la case de pause, « Enregistrer », les tests de canal, le volet Programmes |
| `etat.panneauEnCours` | `enregistrerPanneau` **seul** | ce qui ne vit que dans `etat.delaisEdit` : pilules de délai, « Autre… » et ses champs h/min, « Je valide chaque réponse », sourdine |

`panneauEnCours` se pose et se retire sur les lignes **voisines** de
`modeEnCours`, et nulle part ailleurs : il implique donc `modeEnCours`, et les
deux ne peuvent pas diverger. Un test le tient
(`tests/guestflow-appliquer-delai.test.js`). Le gel du panneau pendant
**l'enregistrement**, lui, reste entier et c'est voulu :
`enregistrerPanneau` a **déjà lu** le formulaire, et une valeur changée après
sa lecture ferait mentir l'écran.

**Point 2 — le panneau s'ouvrait sur le mauvais logement.** `renderTiroir`
retombait sur `refs[0]`, le premier bien du compte. L'hôte réglait donc le délai
d'un **autre** logement que celui qu'il regardait, sans qu'aucun écran ne le
contredise : le sélecteur disait vrai, c'est le regard qui était ailleurs.
`ouvrirTiroir(true)` présélectionne désormais le bien du fil ouvert
(`bienDuFilOuvert()`, sur la **référence provider** — la clé de `etat.biens`,
`etat.pauses` et du sélecteur ; `properties.id` est un UUID et ne s'y joint
jamais). **À l'ouverture seulement** : recalculé à chaque rendu, il écraserait
le bien que l'hôte vient de choisir à la main, au premier clic de pilule.

**Point 4 — refuser n'est pas échouer.** Répondre NON à la question du nombre
affichait « Enregistré en partie. Non enregistré : les propositions déjà en
attente », ce qui fait croire à un échec et fait relancer un geste qui a réussi.
Or tout ce que l'hôte a demandé est fait : le réglage est enregistré
(`propager: false`) et ses propositions en attente gardent leur échéance —
exactement son choix. La note dit maintenant, en **vert** :
« Enregistré. Les propositions déjà en attente gardent leur échéance. »

⚠ **Les deux autres chemins qui posent `propager = false` restent des échecs**,
et la distinction est portée par un drapeau séparé (`refusHote`) : quand
l'écran n'a **pas pu compter**, l'hôte n'a rien choisi et ses propositions en
attente n'ont pas suivi son réglage sans qu'il l'ait voulu. Les deux cas
écrivaient le même message ; le refus était le seul à ne pas être un défaut.

### Le banc qui exécute la page

`tests/outils/banc-messages.js` évalue le **vrai** module de
`pages/messages.html` dans un DOM jsdom — imports retirés, amorce `init()`
coupée, modules partagés évalués pour de vrai dans la **même** fenêtre, et pour
seuls doubles l'authentification, le réseau, les droits et le journal. Les
`window.confirm` y sont gardés **avec leur texte**, donc un test affirme la
phrase que l'hôte lit.

`tests/messages-panneau-ia-dom.test.js` y rejoue les quatre points en
cliquant : 14 tests, dont **4 rouges** contre `9fa9ec13` (contre-épreuve par
`git archive` hors de l'arbre). Les 10 autres décrivent du comportement déjà
correct, et c'est le constat : **le code de la confirmation était juste depuis
le début.** Deux mutations rejouées pour s'en assurer — retirer la confirmation
(2 rouges), et remettre le bouton sous le gel de la pause (1 rouge).

⚠ **Le double supabase de ce banc est délibérément permissif** (il accepte
n'importe quel maillon de chaîne et rend toujours « aucune ligne, aucune
erreur »). Un double permissif valide du code qui ne pourrait pas tourner — le
dépôt l'a payé une fois — donc **aucun test de ce banc n'affirme quoi que ce
soit sur une requête supabase** : ce qui s'y mesure est le panneau. Les
requêtes du writer sont éprouvées par leur propre double, strict, dans
`tests/guestflow-appliquer-delai.test.js`.

### D4 — une bascule de pause efface la saisie non enregistrée du panneau

**Trouvé en corrigeant les quatre points, mesuré, NON corrigé dans ce commit.**

`basculerPause` appelle `renderTiroir()`, qui reconstruit `corps.innerHTML`
depuis `etat.prompting` et `etat.configIA`, c'est-à-dire **depuis la base**.
Tout ce qui n'a pas de source dans l'état y est perdu, **sans un mot** :

```
consigne tapée : « je tape une consigne toute neuve »  →  « ancien »
destinataire tapé : « nouveau@exemple.test »            →  « »
```

Les délais et la sourdine y survivent — ils vivent dans `etat.delaisEdit`. Les
**consignes de l'IA** et les **destinataires d'alerte** n'y survivent pas :
ils ne vivent que dans le DOM, et `lireLePanneau` ne les lit qu'au moment
d'« Enregistrer ».

C'est la même famille que le constat grave de la seconde revue de ce chantier
(« le formulaire se lit avant tout re-rendu ») — et le dépôt porte déjà le
geste juste à côté : `sauverTextesProgrammes()`, appelé en tête de
`renderTiroir` pour le volet Programmes.

**Pourquoi ce n'est pas corrigé ici.** Le correctif propre est une **source
unique** pour la saisie du volet IA, comme `etat.delaisEdit` l'est pour les
délais — pas une écriture des textes tapés dans `etat.prompting` /
`etat.configIA`, qui sont censés porter l'état **enregistré** et servent de
repli à `lireLePanneau` (sans clé Brevo, les destinataires SMS en viennent).
Écrire du non-enregistré dedans ferait partir des valeurs fantômes. C'est donc
un petit lot de modèle d'état, pas une retouche, et Thierry a demandé **un**
commit pour les quatre points.

⚠ **Ce qu'il faut savoir pendant la recette** : taper une consigne ou un
destinataire **puis** toucher la case de pause perd le texte. La pause est un
geste d'urgence, immédiat par décision — c'est ce qui rend la collision
possible.

---

## 11. Hors périmètre, relevé pendant l'étape 0

- `lib/alert-notify.js:15` — `PROPERTY_NAMES` en dur sur deux biens : tout
  autre bien s'annonce « Logement <id> » dans le SMS et l'objet de l'e-mail.
- `lib/cron-shared.js:149` — `parseDelay` n'a **aucun appelant de
  production**, mais il est **exporté** (`lib/cron-shared.js:181`) et stubé par
  `tests/garde-portee-au-point-d-usage.test.js:81` — donc le retirer casse ce
  test, ce n'est pas une suppression gratuite. Vestige d'un délai antérieur
  (table `'5min'…'24h'`). À assumer ou à retirer avec son stub, mais pas à
  réutiliser : son unité (minutes depuis des libellés) n'est pas celle de ce
  chantier.
- `getPropertyMode` fait **un `.single()` par bien et par passe**, sans cache
  (`lib/cron-shared.js:108`) — le blob est pourtant unique par compte. N+1
  inoffensif à 4 biens, condamné à 30 000 comptes.
