# Étape 3 — les actions de la fiche

**Go de Thierry, 21 octobre 2026**, après la recette de l'étape 2 :

> « Go étape 3 : les actions de la fiche (édition sur place avec « Enregistré »,
> photo, assistant, mode des prix, publier avec confirmation courte, connecter,
> supprimer selon la règle serveur). Chaque action masquée par droit garde sa
> garde serveur. »

---

## Inventaire : ce que le serveur accepte DÉJÀ

Mesuré dans le code, endpoint par endpoint, avant d'écrire une ligne d'écran.
**Aucune des sept actions ne demande un endpoint neuf.**

| action | endpoint | garde serveur | ce qu'il refuse |
|---|---|---|---|
| Éditer les champs | `PATCH /api/channel-property` | `reglages:write`, **sur le bien** | plancher > prix de base (400 nommé) ; capacité sans prix de base si grille connectée (409) ; `NaN` (400) |
| Photo | `POST /api/property-photo` | `reglages:write` | > 2 Mo (413), non-JPEG |
| Assistant (pause) | `POST /api/property-automation` | `reglages:write`, sur le bien | bien pas encore synchronisé (409 neutre) |
| Mode des prix | `PATCH … rate_sync_mode` | `reglages:write`, sur le bien | retour en `keep` sur un bien à canal actif (409 qui DIT pourquoi) ; bien piloté par YieldFlow (409) ; échec de lecture des canaux (502) |
| Publier mes prix | `POST /api/calendar` `action: fullsync` | **`reservations:write`**, sur le bien | bien non connecté ; mode `keep` ; déjà publié sous 24 h (`cooldown` + `next_allowed_at`) ; déjà en file |
| Connecter | assistant existant (`components/connexions.js`), ouvert avec l'**UUID** du bien | celle de l'assistant | — |
| Supprimer | `DELETE /api/channel-property` | `reglages:write`, sur le bien | un bien encore relié à une annonce |

## ⚠ TROIS ÉCARTS ENTRE LA SPEC ET LE SERVEUR

**1. « Publier mes prix » n'est pas `reglages:write`.** La spec §5 range les sept
actions sous `reglages:write`. Le serveur garde le full sync par
**`reservations:write`**, et il explique pourquoi dans son propre commentaire :
« ce qui s'écrit dans `calendar_inventory` et se pousse en ARI relève de
`reservations` — c'est le métier du calendrier ; ce qui s'écrit dans
`properties` relève de `reglages` ». Un membre peut donc tenir le calendrier
sans pouvoir reconfigurer le bien, et l'inverse.

On s'aligne sur le serveur, **comme Thierry l'a tranché pour Supprimer le
21 octobre** : masquer sur `reglages` cacherait le bouton à qui a le droit de
publier, et le montrerait à qui recevra un 403. La spec §5 est corrigée dans le
même commit.

**2. Publier n'est pas une poussée immédiate : c'est une MISE EN FILE.**
L'endpoint rend `{ enqueued: true }` ; le travail réel (`runFullSync`, 500 jours)
est fait par le cron, un bien à la fois. L'écran ne doit donc pas dire « c'est
fait » — l'ancien écran disait déjà « vos prix seront envoyés dans les
prochaines minutes ». Et il doit savoir rendre les **refus en 200** :
`cooldown` (avec la date de la prochaine publication possible), `already_queued`,
bien non connecté, mode `keep`.

**3. L'assistant se bascule avec un paramètre nommé `provider_property_id` — qui
accepte l'UUID.** `resoudreBien` résout `id`, `provider_property_id` et
`migration_target_property_id`. L'écran envoie donc l'**UUID**, qu'il a déjà :
la fiche ne descend aucun identifiant du partenaire, et ce lot ne commencera pas
à le faire pour un nom de paramètre. Un test gardera ce point.

## Ce qui reste à écrire côté serveur

**Les nombres de la confirmation de suppression.** L'étape 2 l'annonçait comme
une dépendance de l'étape 3 : « la confirmation dit ce qui sera effacé, avec les
nombres ». Le DELETE purge réservations, messages, ménages et serrures ; rien ne
les COMPTE aujourd'hui. Ce sera une action de lecture dédiée, appelée à
l'ouverture de la confirmation — pas un champ de la fiche, qui ferait payer ce
comptage à chaque ouverture d'un écran où l'on ne supprime presque jamais.

## Règles que l'étape 3 ne rediscute pas

- **Un masquage par droit se double de sa garde serveur**, et le test qui
  tranche est « on retire le masquage, on clique, le serveur répond 403 ».
- **Le prix plancher est en CENTIMES en base, en euros à l'écran** — conversion
  aux deux bouts, comme l'ancien écran, et c'est le défaut ×100 trouvé en revue
  de l'étape 2.
- **Les champs de prix ne partent que s'ils ont changé** : toucher
  `base_price`, `capacity`, `included_guests` ou `extra_guest_fee` reconstruit
  la grille tarifaire chez le partenaire, de façon BLOQUANTE. Envoyer un champ
  inchangé, c'est reconstruire une grille pour rien.
- **La devise n'est pas modifiable** (elle ne l'était pas non plus avant).
- **Jamais le nom ni l'identifiant du partenaire à l'écran.**
