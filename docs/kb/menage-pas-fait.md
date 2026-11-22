# KB — Ménage pas fait avant l'arrivée (PWA lot 4)

Spec : `docs/specs/spec-pwa-lot4-menage-pas-fait.md` (branche `pwa-lot-4-spec`).
Demande de Thierry du 19 novembre 2026 ; étape 1 codée le 22 novembre 2026
(go de Thierry, 19:23), branche `pwa-lot-4-menage-pas-fait`.

## 1. Ce que fait l'alerte

L'événement **`menage_pas_fait`** (lettre p, groupe et domaine « Ménages ») part
**une fois** par compte, logement et jour d'arrivée, quand :

1. une réservation **active** (`isActiveStatus`) arrive **aujourd'hui** (jour de
   Paris) sur un logement **non archivé** ;
2. l'horloge de Paris a atteint **l'heure d'arrivée du logement − 30 minutes**
   (`properties.checkin_time`) — et jusqu'à minuit : un cycle manqué rattrape ;
3. le ménage concerné — le plus récent du logement **au plus tard le jour de
   l'arrivée**, hors annulés — n'a **pas de ligne `menage_done`**.

Elle va aux destinataires du catalogue (titulaire, membres du domaine
« ménages », contacts prévenus), avec leurs canaux. Texte : « Ménage pas fait —
{logement} » / « {prénom} n'a pas marqué fait le ménage. Le voyageur arrive à
{heure}. » (ou « …et personne ne l'a pris » si le ménage n'a pas de porteuse).
Toucher la notification ouvre `/menages`.

## 2. Les décisions de Thierry

| Question | Décision |
|---|---|
| Heure de référence | **Toujours celle du logement**, jamais celle du voyageur (19 nov. 2026) |
| Rangement | Un lot à part, après le lot 3 (19 nov. 2026) |
| Heures calmes | « Configurable comme les autres » (19 nov. 2026) — voir §3 |
| Q49 — logement sans heure d'arrivée réglée | **Pas d'alerte** pour ce logement, et le guide le dit (22 nov. 2026) |

## 3. Ce qu'il faut savoir en le lisant

- **L'heure se compare à la pendule de Paris** (minutes depuis minuit), pas en
  instants : « 30 minutes avant 16:00 » est 15:30, été comme hiver. Un test le
  prouve aux deux saisons.
- **Les heures calmes** : l'alerte porte l'arrivée du jour (`sejour`), donc
  `decision.js` la fait passer tout de suite (règle 3), comme les autres alertes
  ménage. L'hôte choisit ses canaux ou la coupe ; « urgent » n'y change rien.
- **`checkin_time` est un texte libre** : « 16:00 », « 16:00:00 », « 16h »,
  « 16h30 » sont lus ; tout le reste (vide, « vers 16h », « midi », « 25:00 »)
  est illisible → pas d'alerte (Q49), compté `sans_heure` au bilan.
- **Aucun ménage dans `menages` pour ce logement → rien** : un hôte qui ne suit
  pas ses ménages dans HôteSmart ne reçoit pas une alerte à chaque arrivée.
- **Dans le doute, on ne prévient pas** : `menage_done` illisible → rien
  n'est envoyé, l'erreur va dans `results.errors` (contexte `menage_pas_fait`),
  et le cycle suivant relit.
- **La mémoire** : l'index unique de `message_sent_log`, sentinelle
  `…0000000000a5`, clé `notif:menage_pas_fait:<logement>:<jour d'arrivée>`.
  Posée **avant** l'envoi, retirée si rien n'est parti (le geste de h). Posée
  **aussi** quand le ménage est trouvé fait ou qu'il n'y a aucun ménage : elle
  veut dire « cette arrivée est tranchée pour aujourd'hui », et évite de relire
  la même arrivée toutes les cinq minutes jusqu'à minuit. Conséquence assumée :
  un « fait » annulé par l'hôte après ce moment ne déclenche plus l'alerte.
- **Le sujet est celui du ménage** (`menage:<logement>:<jour du ménage>`) : elle
  remplace un « pas vu » ou un « sans personne » du même ménage. La clé de
  mémoire, elle, porte le jour de l'**arrivée**.
- **Plafond** : 20 arrivées tranchées par cycle, les plus proches d'abord ; le
  reste attend cinq minutes (rien n'est mémorisé pour lui).

## 4. Où vit le code

| Fichier | Rôle |
|---|---|
| `lib/cleaning/menage-pas-fait.js` | l'émetteur : la règle, les lectures, le plafond, le bilan |
| `lib/notifications/evenements-menages.js` | `notifierMenagePasFait` (mémoire + envoi), `memoriserPasFait` |
| `lib/notifications/catalogue.js` | l'événement `menage_pas_fait` |
| `lib/notifications/textes.js` | ses textes fr/en/es et son exemple (bouton « Tester ») |
| `api/cron.js` | la tâche `menage_pas_fait`, après `relance_validation`, mesurée à part |

## 5. Coût

- Jour sans arrivée : **1 lecture** (`bookings_snapshot`, bornée au jour, par
  curseur sur `id`).
- Arrivées pas encore dues : **2 lectures** (+ `properties`).
- Arrivées dues : + mémoires, + une lecture `menages` par arrivée non tranchée,
  + `menage_done`, + `profiles`, puis l'envoi. Une arrivée tranchée ne coûte
  plus que sa part des deux premières lectures et de la lecture des mémoires.
- Mesuré dans `cron_stats` sous `menage_pas_fait` (docs/kb/cout-du-cron.md).

## 6. Tests

`tests/menage-pas-fait.test.js` : la règle cas par cas (échéance à la minute,
deux saisons, fait, sans heure, sans ménage, logement resté vide, personne sur
le ménage, annulée, archivé, autre jour), l'isolation entre comptes (heure,
ménage, « fait »), le doute, la mémoire retirée sur échec, le plafond et
l'ordre, le curseur au-delà d'une page, les textes. Contre-épreuves : 19
mutations, toutes attrapées.
Listes mises à jour : `tests/cron-taches.test.js` (la tâche),
`tests/notifications-reglages.test.js`, `-ecran`, `-envoi` (seize événements).

## 7. Limites connues

- Une alerte, pas de suite : marqué fait après l'alerte, rien ne dit « c'est
  fait ».
- La prestataire n'est pas prévenue par cet événement (hors demande).
- Un voyageur qui annonce une arrivée plus tôt n'avance pas l'alerte (décision).
- Staging n'a pas de cron : en recette, la tâche se lance à la main.
