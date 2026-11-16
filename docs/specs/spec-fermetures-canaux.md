# Spec — Une fermeture de l'hôte doit arriver jusqu'aux canaux

**Lot cœur & sync.** Il tourne seul, et Thierry le date. Cette spec pose le
diagnostic **mesuré** de l'incident du 10 au 16 novembre 2026 et le périmètre
décidé. La session qui codera le lot la complète avant d'écrire une ligne.

Diagnostic : fil Calendrier, en lecture seule sur la production. Gestes en
production : Thierry, sur décision du chef de file.

## 1. L'incident

- **La bulle, nuit du 23 novembre 2026.** Thierry l'avait fermée par
  « Bloquer » (fermeture « aurelie », du 22 au 23/11, créée le 15/10 à
  17:55 UTC). Elle a été vendue sur Airbnb le 10/11 à 22:16:44 UTC : c'est la
  réservation HMB5MJ9YZH, que Thierry garde.
- **Même cause, une seconde nuit** : la nuit du 22/11 était encore vendable
  chez Airbnb et chez Booking le 14/11. Elle a été fermée le 16/11 (voir §4).
- **Aucune alerte.** La fermeture est restée « réussie » côté HôteSmart.
  Le toast de « Bloquer » ne lit pas `push_failed` ni `local_only` : c'est un
  défaut à part, dans le petit lot du fil Calendrier, pas dans celui-ci.

## 2. La cause : la fermeture s'arrête au plan de base

- `action=fermer` (api/calendar.js) crée la fermeture (lib/fermetures.js), puis
  écrit les nuits par le writer unique (`ecrireCalendrier`). Une fermeture pose
  `stop_sell` **sur le plan de base seulement** (`provider_rate_plan_id`), sans
  disponibilité à 0.
- Les canaux ne lisent pas le plan de base. La chaîne réelle, mesurée, est :

  ```
  plan de base  →  plan dérivé  →  « petit-enfant »  →  OTA
  (5d35913a)       (d16d59b7)       (cfb5840e)          Booking, La bulle
  ```

  - Le **dérivé** est celui que nomme le mapping du canal (`rate_plans` du
    canal). C'est lui que crée `creerDerive` (lib/rate-plans-derives.js),
    titre « <bien> — <canal> (dérivé) ».
  - Le **petit-enfant** porte le titre « <dérivé> - <type de canal> <titre du
    canal> ». Il n'apparaît dans aucune liste de l'interface Channex (son
    édition ne s'ouvre que par l'URL directe), et aucun appel de notre code ne
    le crée. **C'est lui que l'OTA reçoit.** Preuve : le Full Sync du canal
    « Booking.com — La bulle » du 14/11 à 23:11:38 UTC (channel_event
    0819793a) est identique à `cfb5840e` sur 500 jours sur 500, et ne diffère
    de `d16d59b7` que sur le 22/11.
- **Les réglages d'héritage avant le 14/11** :
  - dérivés : `inherit_rate`, `inherit_min_stay_arrival` et
    `inherit_min_stay_through` à true, **`inherit_stop_sell` à false**. C'est
    exactement ce que pose `creerDerive`, qui n'envoie pas `inherit_stop_sell` ;
  - petits-enfants : tout hérité, `inherit_stop_sell` compris.

  Le maillon cassé est donc le dérivé : le `stop_sell` du plan de base ne
  descendait pas plus bas.
- **Ce qui marchait quand même** : les fermetures qui passent par une
  disponibilité à 0 (retrait de fenêtre, nuits vendues) arrivent aux OTA.

## 3. Ce qui fait descendre le recalcul, et ce qui ne le fait pas (mesuré)

| geste dans Channex | dérivés | petits-enfants | envoi aux OTA |
|---|---|---|---|
| `inherit_stop_sell` passé à true sur les 4 dérivés (14/11, 22:4x–22:50 UTC) | recalculés tout de suite | **non recalculés** (le 22/11 reste ouvert sur `cfb5840e` et `f2bad0ad`) | **aucun** : aucun channel_event après le changement de réglage |
| « Save » sans modification de `cfb5840e` (14/11, 23:16:39 UTC) | — | **non recalculé** | aucun |
| Full Sync du canal Booking La bulle (14/11, 23:11:38 UTC) | — | — | envoie les valeurs du **petit-enfant**, donc le 22/11 **ouvert** |
| **Disponibilité à 0** sur le type de logement, le 22/11 seulement (16/11, 22:52:56 UTC, tâche `Property.UpdateAvailability`) | 22/11 : availability 0, stop_sell true | **recalculés** : stop_sell du 22/11 passé à true sur `cfb5840e` et `f2bad0ad` | **envoyé** à 22:52:58 UTC. Booking : BookingLimit 0 + RestrictionStatus Close, `<Success/>`. Airbnb : listing 992723390568420450, « unavailable », BLOCKED_BY_HOST, `success:true` |

**Ce que le lot doit retenir de ce tableau** : un changement de réglage d'un
plan tarifaire ne recalcule que ce plan-là, et n'envoie rien aux canaux. C'est
une **écriture d'inventaire** sur la date (ici la disponibilité) qui fait
redescendre le recalcul jusqu'aux petits-enfants et part chez les OTA. Une
écriture de `stop_sell` sur le plan de base n'a pas été mesurée : la bascule
false → true a été écartée par le chef de file le 15/11.

La poussée nocturne d'HôteSmart de 23:00:33 UTC le 16/11 n'a rien rouvert :
le 22/11 restait à availability 0 et stop_sell true sur les cinq plans de
La bulle à 23:05:13 UTC.

## 4. L'état laissé en production le 16/11

- **Réglage** : `inherit_stop_sell` à true sur les 4 dérivés : 97462698 et
  bc2eadea (Cœur de vie 23), 6b34530e et d16d59b7 (La bulle). Le reste de leur
  réglage n'a pas bougé.
- **Audit après réglage**, sur 500 jours (14/11/2026 → 27/03/2028), Channex
  comparé à `calendar_inventory` :
  - dérivés mappés identiques au plan de base, jour par jour, sur les deux
    biens ;
  - 0 nuit fermée chez l'OTA alors qu'elle est ouverte dans HôteSmart ;
  - 0 nuit vendable chez l'OTA alors qu'elle est fermée ou pas encore ouverte
    dans HôteSmart ;
  - petits-enfants identiques au plan de base, sauf le 22/11 de La bulle,
    corrigé le 16/11.
- **Ofuro Futari** : mappé sur Airbnb directement par son plan de base
  (efb50c04), donc non concerné. 0 écart mesuré le 15/11. Ses dérivés ne sont
  mappés nulle part. Colomiers non plus.
- **Écart connu et assumé** : La bulle, 22/11, est à `avail 1` / `stop_sell
  true` dans `calendar_inventory`, mais à availability 0 chez Channex. Le
  stop_sell des petits-enfants garde la nuit fermée même si HôteSmart repousse
  availability 1.

## 5. Le périmètre du lot (décidé par le chef de file)

1. **`creerDerive` pose `inherit_stop_sell: true`**, et le lot traite **toute
   la chaîne** des biens existants, petits-enfants compris : vérifier, et
   corriger là où il le faut.
2. **Piste B, garde principale** : une fermeture de l'hôte écrit aussi une
   **disponibilité à 0** sur ses nuits. C'est le seul chemin mesuré qui arrive
   jusqu'aux OTA sans dépendre de l'héritage, et qui fait recalculer les
   petits-enfants (§3).
3. **Les petits-enfants non mappés** : b56feb44 et 9d739f60 (Cœur de vie 23),
   f2bad0ad et cfb5840e (La bulle), 7cfcc078 (Ofuro Futari). Établir qui les
   crée et ce qu'ils deviennent quand un mapping change.

## 6. Questions à trancher avant de coder

- **La piste B touche un principe gravé.** spec-audit-stop-sell.md §1 :
  `stop_sell` est l'intention mémorisée de l'hôte, le stock est **calculé** à
  la poussée, jamais une source. Fermer par une disponibilité à 0, c'est faire
  porter l'intention par le stock. Il faut dire comment les deux cohabitent :
  qui remet la disponibilité à 1 quand l'hôte rouvre, et ce que devient
  `calendar_inventory.avail`. Le même document rapporte aussi l'incident du
  7 septembre : écrire la disponibilité seule chez Channex avait **levé** le
  stop_sell. Le 16/11, ce n'est pas arrivé (§3), mais le geste ne passait pas
  par notre writer.
- **Le contrôle de ce que les OTA ont reçu.** Les channel_events et leurs logs
  (`GET /channel_events?filter[channel_id]=…`, puis
  `/channel_events/<id>/logs`) donnent la requête réellement envoyée à chaque
  OTA. C'est ce journal qui a montré que le 22 était parti ouvert. À décider :
  une vérification automatique « ce que l'OTA a reçu = le cœur », ou rien.
- **Un full_sync « System » observé** le 16/11 à 22:17:38 UTC sur le canal
  Airbnb, scope rate_plans, `b56feb44` (Cœur de vie 23). Ce n'est ni HôteSmart
  ni un geste manuel. Cœur de vie 23 avait le 22/11 ouvert dans le cœur, donc
  c'était conforme. Origine à établir si le lot touche aux petits-enfants.

## 7. Comment le lot se prouve

- **Avant / après sur un bien de test** (staging) : fermer une nuit par
  « Bloquer », puis lire le petit-enfant (`GET /restrictions`) et le
  channel_event envoyé pour cette date. Le test passe si le log porte la
  fermeture, pas si le plan de base la porte.
- **Contre-épreuve** : le même geste sur le code d'avant doit laisser le
  petit-enfant ouvert. C'est ce que le §3 a mesuré en production.
- **Envoi aux voyageurs, argent, authentification : non concernés.** Mais une
  nuit vendue sur une fermeture se voit chez l'hôte : recette avec Thierry
  présent.
