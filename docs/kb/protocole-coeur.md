# Protocole unifié entre les apps et le cœur

> Contrat versionné. Tout changement d'action, de paramètre, de réponse ou
> d'événement se fait ici, **dans le même commit** que le code.
> Spec d'origine : `docs/specs/spec-evaluation-voyageur.md` §2 bis. Lot 1, 24 septembre 2026.

## Principe

Le cœur détient les données et les fonctionnalités transverses (réservations,
avis, profils…). Les apps (messagerie, planning, ménage, PWA prestataire) sont
des consommatrices : elles ne connaissent ni ses fichiers, ni ses tables, ni ses
endpoints. Elles lui parlent par **un seul module** : `shared/hs-bus.js`.

Ce que le recensement (`tests/protocole-recensement.test.js`) interdit dans
`apps/` : importer `/core/…` ou `/lib/…`, appeler `/api/avis` directement,
importer une autre app. Autorisé : `/shared/…` et `/components/…`.

## Le bus — version 1

```js
import { hsBus } from '/shared/hs-bus.js'

await hsBus.disponible('avis.evaluer')                         // true | false
await hsBus.ouvrir('avis.evaluer', { booking_uid })            // { ok: true, resultat } | { ok: false, raison: 'indisponible' }
await hsBus.demander('avis.statut', { booking_uid })           // { ok: true, data }     | { ok: false, raison: 'indisponible' }
const stop = hsBus.ecouter('avis.evaluation_publiee', (detail) => { … })
hsBus.emettre('menages.fait', { menage_event_id })
```

- **Trois réponses, jamais une erreur visible.** Action inconnue, droit absent,
  action « à venir », module du cœur manquant, manifeste injoignable : `indisponible`.
  L'app masque son bouton. Elle n'a pas à savoir pourquoi. Un manifeste
  injoignable n'est pas mis en cache : l'appel suivant réessaie.
- **Un paramètre déclaré qui manque** est une erreur de l'app, pas un état du
  cœur : `{ ok: false, raison: 'parametre_manquant', detail: [...] }`, tracé en
  console, sans exception. Les `params` du manifeste sont exigés.
- **Le droit se lit pour l'écran, se décide au serveur.** Le bus consulte
  `peutLire` / `peutEcrire` (`shared/compte-courant.js`) selon le `droit`
  déclaré par l'action. Le serveur (`lib/require-permission.js`) reste seul juge.
- **Identité par jeton** (PWA prestataire) : `hsBus.ouvrir(action, params,
  { identite: { jeton } })`. Aucun droit de session n'est exigé ; le jeton est
  transmis au module du cœur, qui le fait valider côté serveur, jamais cru sur
  parole. Sans jeton, l'action est indisponible.
- **Fenêtre standard** : une seule à la fois, au-dessus de tout, fermée par son
  bouton, par Échap, par un clic entamé et relâché sur le fond (une sélection de
  texte relâchée dehors ne ferme pas), ou par le module (`fermer()`). Ouvrir une
  seconde fenêtre ferme la première proprement. Si le module échoue, la fenêtre
  se ferme et le bus répond `indisponible`. Le focus entre dans la fenêtre, y
  reste (Tab), revient d'où il venait ; la page derrière ne défile plus. Le
  module reçoit `{ conteneur, params, identite, fermer, action }` et y rend ce
  qu'il veut ; le bus ne connaît pas son contenu. Feuille de bas d'écran sur
  téléphone, boîte centrée au-delà de 640 px.
- **Événements** : `CustomEvent` sur `window`, préfixés `hsbus:` (distinct du
  `hs:log` du journal), nommés `domaine.evenement` — vérifié à l'émission comme
  à l'écoute. `ecouter` rend la fonction de désabonnement.
- **Droits de session** : chargés seulement quand l'action en a besoin (jamais
  pour une identité par jeton) ; un chargement qui tombe vaut refus et se
  retente à l'appel suivant.

## Les manifestes

Le cœur déclare ses actions par domaine dans `core/<domaine>/manifest.js`. Le
bus est le seul fichier du front partagé qui connaît ces chemins.

```js
export default {
  domaine: 'avis', version: 1,
  actions: {
    'avis.evaluer': { type: 'fenetre' | 'requete', droit: { domaine, niveau: 'read' | 'write' } | undefined,
                      identite: 'jeton' | undefined, module: '/core/avis/…', etat: 'a_venir' | undefined, params: [...] },
  },
  evenements: { 'avis.evaluation_publiee': { detail: [...] } },
}
```

Un module d'action exporte `ouvrir(ctx)` (type `fenetre`) ou `demander(params,
ctx)` (type `requete`). Une entrée `etat: 'a_venir'` est déclarée mais
indisponible : les apps peuvent écrire leur bouton avant que le cœur ne livre.

## Domaine `avis` — version 1

| Action | Type | Droit / identité | Paramètres | État |
|---|---|---|---|---|
| `avis.evaluer` | fenêtre | `avis: write` | `booking_uid` | à venir (lot 4) |
| `avis.statut` | requête | `avis: read` | `booking_uid` | à venir (lot 3) |
| `avis.questions_prestataire` | fenêtre | jeton | `menage_event_id` | à venir (lot 4) |
| `avis.reglages_prestataire` | requête | `avis: write` | `profile_id` | à venir (lot 3) |

Événements : `avis.evaluation_publiee` — détail `{ booking_uid, published_at }`
(lot 3, côté serveur : journal d'événements du cœur, à créer au lot 2).

## Tester

- `tests/protocole-bus.test.js` : le bus avec ses dépendances injectées
  (droits, import, fenêtre, cible d'événements) — sans navigateur.
- `tests/protocole-fenetre.test.js` : la fenêtre standard dans un DOM (jsdom).
- `tests/protocole-recensement.test.js` : balaie `apps/` (imports absolus,
  relatifs, dynamiques, `/api/avis` sous toute forme, lecture directe des
  tables du cœur des avis) ; se prouve sur un extrait et sur un dossier d'app
  fautif, puis exige zéro écart. Exemption explicite à la règle 19 : vert sur
  le code d'aujourd'hui par construction.

## Côté serveur — le journal d'événements du cœur

Le pendant serveur du bus : `core_events` (migration
`2026-09-25-core-events.sql`, lot 2). Le cœur y inscrit ce qui s'est passé ; les
consommateurs (archivage de la messagerie, notifications) le lisent. Même
vocabulaire que le bus : `type` vaut `domaine.evenement`, contraint par un CHECK.

| Colonne | Rôle |
|---|---|
| `user_id` | le compte **propriétaire** de l'événement, jamais l'appelant (règle 11) |
| `type` | `domaine.evenement`, ex. `avis.evaluation_publiee` |
| `subject_type` / `subject_id` | ce que l'événement désigne (texte : un sejour, un bien, un ménage) |
| `payload` | le contenu, versionné par ce contrat |
| `processed_at` / `processing_errors` | le contrat du dispatcher |

Les gardes sont celles de `booking_change_events`, reprises telles quelles —
elles ont été payées cher (79 350 faux `menage_events`) :

- `processed_at` est posé **même si un consommateur échoue** ; l'échec va dans
  `processing_errors` ;
- **jamais de rejeu automatique** : un rejeu se fait à la main, `processed_at`
  remis à `null` ;
- lots bornés et budget mur côté dispatcher.

`booking_change_events` reste **intouchée** : c'est le journal des réservations,
avec son CHECK fermé et ses trois consommateurs. Deux journaux, deux contrats
(décision de Thierry, 25 septembre 2026).

Écriture : sous clé de service uniquement, par le writer du cœur. La RLS donne
au client une **lecture** de son compte, aucune écriture — un front capable
d'inscrire un événement déclencherait des conséquences métier (archivage,
notifications) sans passer par aucune garde.

## Historique

- v1, 24 septembre 2026 (lot 1) : bus, manifeste `avis` (quatre actions à
  venir, un événement), recensement. Aucune fonctionnalité métier.
- v1.1, 25 septembre 2026 (lot 2) : le journal serveur `core_events` et son
  contrat. Aucun changement au bus ni aux actions déclarées.
