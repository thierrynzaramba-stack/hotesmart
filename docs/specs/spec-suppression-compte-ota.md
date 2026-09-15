# spec — suppression de compte et canaux OTA actifs

Domaine : résa & argent. Règle concernée : fiche `resa-argent`, **règle 11**.
Origine : décision de Thierry (hors session), confirmée par la vérification du
15 septembre 2026. Priorité : **après** le lot isolation multi-comptes.

---

## 1. La règle

> La suppression d'un compte est **REFUSÉE** tant qu'un canal OTA est actif.
> Contrôle **serveur**. Message : « Déconnectez d'abord vos canaux ».
> **Jamais** de cascade automatique chez le provider.

Le refus n'est pas une précaution technique, c'est une position produit : on ne
débranche pas le canal de vente d'un hôte à sa place. Un `DELETE /channels`
déclenché par nous couperait Airbnb ou Booking sans que personne ne l'ait
demandé, et sur une action dont le but était de partir — donc sans personne pour
le rattraper.

---

## 2. Le trou, mesuré

`supabase/functions/delete-account/index.ts` purge `messages`, appelle
`auth.admin.deleteUser`, et s'arrête. **Aucun appel réseau, aucune mention du
provider.**

**La base est saine** — vérifié, pas supposé : `profiles_legacy.id` porte
`REFERENCES auth.users(id) ON DELETE CASCADE`, et 20 tables dépendent de
`profiles_legacy`, plus 25 en FK directe vers `auth.users`. Rien n'est orphelin
côté Supabase.

**Le provider ne l'est pas.** Restent chez Channex, pour un compte qui n'existe
plus : les `properties`, `room_types`, `rate_plans`, et les **canaux OTA
actifs**. Trois conséquences :

1. Channex **facture à la propriété**.
2. Le webhook est global (`is_global: true`, `property_id: null`) : il continue
   de livrer les événements de ces biens, que plus aucun compte ne réclame.
3. Les annonces restent en vente sur les OTA, alimentées par un compte supprimé.

⚠ Le contraste est interne au dépôt : la suppression d'**un bien**
(`api/channel-property.js:632`) appelle `DELETE /properties/{id}` chez le
provider et traite le 404 comme un succès. Le chemin « un bien » nettoie, le
chemin « tout le compte » ne nettoie pas.

⚠ Le test de recette du 15 septembre ne pouvait pas le montrer : les biens du
seed (`STG-BIEN-1`, `STG-BIEN-2`) sont fictifs et n'existent pas chez Channex.
La fonction a rendu un succès légitime sur une base propre, sans jamais toucher
au cas qui pose problème.

---

## 3. Où poser le contrôle — la contrainte qui décide

**L'Edge Function n'a pas la clé Channex.** Son environnement se limite à
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (vérifié).
`CHANNEL_API_KEY` vit côté Vercel.

**Et un miroir en base ne suffit pas.** `properties.ota_connect_status` et
`property_channel_rate_plans.is_active` peuvent être périmés. Se tromper en
croyant qu'aucun canal n'est actif, c'est rouvrir exactement le trou que cette
spec ferme. La source doit être le provider.

La primitive existe déjà, `api/channel-property.js:113-117` :

```js
const r = await channelCall('GET', `/channels?filter[property_id]=${cle}`)
rows.filter(c => c.attributes?.is_active === true)
```

### Trois options

| | |
|---|---|
| **A. Endpoint Vercel de garde**, appelé par l'Edge Function | ✅ la clé ne bouge pas, primitive réutilisée — ❌ un aller-retour, et l'Edge Function doit s'authentifier |
| **B. Déplacer la suppression sur Vercel** | ✅ un seul lieu, clé et primitive sur place — ❌ il faut y refaire la vérification du mot de passe et `auth.admin.deleteUser` |
| **C. Donner `CHANNEL_API_KEY` à l'Edge Function** | ❌ un secret de plus, dans un second environnement, pour un seul appel |

**Recommandation : A.** C'est le moins de déplacement pour la garantie voulue,
et la clé reste dans un seul environnement. **C est à écarter** : dupliquer un
secret pour économiser un aller-retour est le mauvais côté du compromis.

---

## 4. Le parcours assisté

Le refus seul est une impasse : l'hôte veut partir, on lui dit non sans lui dire
comment. L'écran doit donc, dans le même refus :

- **nommer** les canaux actifs, bien par bien — la primitive rend déjà leur
  libellé (`channel` ou `ota_name`) ;
- renvoyer vers l'écran de déconnexion de chaque canal ;
- et **re-vérifier au moment du clic**, jamais sur l'état affiché : entre
  l'affichage et l'action, un canal peut avoir changé d'état.

Le message reste « Déconnectez d'abord vos canaux », la liste vient dessous.

---

## 5. Ce que le lot doit prouver

1. Compte avec un canal actif → suppression **refusée**, canaux nommés.
2. Compte sans canal actif → suppression **passe**, et la base est vide de ses
   lignes (la cascade, re-vérifiée).
3. Le refus vient du **serveur** : appeler l'endpoint directement, sans passer
   par l'écran, doit refuser aussi. La garde n'est pas dans le bouton.
4. **Contre-épreuve** : désarmer le contrôle doit faire tomber un test. Un
   correctif dont la suite reste verte des deux côtés ne prouve rien.
5. Provider injoignable au moment du contrôle → **refus**, jamais autorisation
   par défaut. Une garde qui s'ouvre sur une panne n'est pas une garde.

---

## 6. Hors périmètre

Le nettoyage des comptes **déjà supprimés** dont les biens dorment chez Channex.
Il y en a peut-être ; cette spec ferme la fuite, elle ne fait pas l'inventaire
de l'existant. À mesurer séparément, côté Channex, une fois la garde en place.
