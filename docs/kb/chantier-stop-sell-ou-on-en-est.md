# Chantier `stop_sell` non confirmé — où on s'est arrêté

**Rangé le 19 octobre 2026 sur demande de Thierry** (changement de priorité :
refonte V5 de Mes biens). Branche `fix-stop-sell-non-confirme`, commit
`4503849`, poussée. **Rien n'est en production.**

## Ce qui est fait, et qui tient

`lib/channel-availability.js` — étape 2 du chantier « 200 sans JSON » :

- sa copie de `channelCall` a reçu **les gardes de l'original** : une panne
  réseau rend `{ ok: false, status: 0 }` au lieu de remonter nue (défaut que
  `lib/calendrier-writer.js:674` documentait déjà sans le fermer) ;
- un **2xx dont le corps n'est pas exploitable** rend `ok: false`, donc la
  branche d'échec mord, donc `stop_sell_perdu` **sonne** avec les dates ;
- 6 tests neufs (`tests/stop-sell-non-confirme.test.js`), dont **3
  contre-épreuves** : une réponse confirmée ne sonne pas, un bien sans intention
  mémorisée n'appelle pas le partenaire, une intention **ouverte** qui échoue ne
  sonne pas. Le partenaire **et** la base sont simulés par `global.fetch` :
  aucune écriture, nulle part.
- Suite complète au moment du rangement : **5410 tests, 5410 verts**.

## ⚠ CE QUI RESTE OUVERT, ET POURQUOI

### a. La mesure de la forme du `POST /restrictions` (option 2, autorisée, NON FAITE)

J'exigeais d'abord un **identifiant de tâche** dans la réponse pour considérer
une fermeture confirmée. Le test **historique** du fichier a rougi : son faux
partenaire rend `{ data: {} }`, **sans identifiant**. Vérification :
`lib/calendrier-writer.js:127` et `lib/channel-fullsync.js:421` lisent bien
`data[0].id` **en tolérant `null`**, et **aucune doc ne confirme la forme
réelle**.

Si `{ data: {} }` est la vraie réponse, exiger l'identifiant ferait sonner
`stop_sell_perdu` **à chaque fermeture légitime** — l'alarme la plus grave du
système, noyée dans le bruit, avec l'anti-spam qui masquerait ensuite la vraie.
L'identifiant est donc **journalisé, pas alarmé**, en attendant la mesure.

**Thierry a autorisé la mesure (option 2), avec ses conditions, et elle n'a pas
été faite :**

- uniquement le **compte partenaire de staging**, sur un **bien de test**,
  jamais un vrai bien ;
- **avant** : un `GET` de la date pour prouver qu'elle est **déjà fermée** ;
- le `POST /restrictions` qui la referme — donc **sans effet réel** ;
- **après** : un `GET` pour prouver qu'elle l'est **toujours** ;
- et montrer à Thierry **la forme exacte de la réponse du POST**.

### b. Ses quatre questions, sans réponse

1. **La nouvelle tentative automatique après échec** — l'intention locale reste
   dans `calendar_inventory`, donc la prochaine poussée de stock la restitue.
   Mais y a-t-il une *reprise* dédiée après un échec, ou faut-il attendre le
   prochain événement ? **Non répondu.**
2. **Le canal par lequel `stop_sell_perdu` l'atteint** (SMS ? e-mail ?).
   Commencé : le libellé existe (`lib/founder-notify.js:90`), le routage des
   canaux n'a pas été lu. **Non répondu.**
3. **Délai dépassé, 5xx et 429 traités comme échec.** État lu au rangement :
   5xx et 429 rendent `res.ok === false`, donc échec et alarme — mais **cette
   copie ne réessaie pas** (l'original le fait) et **n'a aucun délai
   d'expiration**, donc un partenaire qui se tait bloque l'appelant.
   **Non répondu formellement.**
4. **Les 5 liens du relevé prod, par bien.** Mesurés plusieurs fois le
   19 octobre : La bulle et Cœur de vie 23 sur Airbnb **et** Booking, Ofuro
   Futari sur Airbnb, tous reliés ; `colomier` et `Colomiers` sans canal.

### c. La confirmation par RELECTURE, à chiffrer avant de coder

Thierry demande d'envisager : après un `stop_sell`, **relire** l'état de ces
dates par un `GET` ; si elles ne sont pas fermées → échec, nouvelle tentative et
alarme, **indépendamment de la forme du corps**.

⚠ **Et le fichier porte déjà une décision contraire, motivée** : « PAS DE
RELECTURE IMMEDIATE, ET C'EST UN CHOIX. Le POST ARI rend un ID DE TACHE :
Channex applique en **différé**. Un GET lancé dans la foulée lit donc l'état
d'AVANT et crierait « stop-sell perdu » à chaque fermeture légitime. » Un test
du dépôt la garde : `AUCUNE relecture immediate : elle crierait a tort`.

Une relecture n'est donc défendable que **différée** — et le coût en appels (les
limites de débit du partenaire) n'a pas été chiffré. C'est ce que Thierry
demande avant tout code.

## Les étapes 3 et 4, pas commencées

- `lib/calendrier-writer.js` : ne jamais supprimer les lignes locales sans
  accusé valide, et **persister** l'identifiant de tâche.
- `api/channel-mapping.js` `disconnect`/`delete` : aucune action chez le
  partenaire sur une lecture non prouvée.

Inventaire du défaut : `docs/kb/reponse-200-sans-json.md`.
