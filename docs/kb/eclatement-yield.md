# Éclatement réservation → nuits (YieldFlow, lot 3.1)

Module : `lib/yield/eclatement.js` — **fonctions pures**, ni base, ni réseau,
ni provider. Spec : `docs/specs/spec-yieldflow-v1.md` §6.

## 1. Le socle de tout le moteur

Chaque indicateur de l'étape 3 — CA, RevPAR, nuitées, prix moyen, délai de
réservation — se calcule sur ces nuits. **Une erreur ici les fausse tous, du
même facteur, sans qu'aucun ne paraisse aberrant.** C'est pourquoi le module est
pur : il s'éprouve sur les pièces réelles, une par une.

Validé avec Thierry le 12 septembre 2026 **avant écriture du code**, sur six
réservations réelles — une par cas provider/canal, plus le couple
démappée/jumelle.

## 2. Le prix voyageur ne se lit jamais dans `snapshot.amount`

| provider / canal | source du prix |
|---|---|
| Beds24 (tous canaux) | `raw.price` |
| Beds24 / **direct** à `price = 0` | repli sur la **somme des charges** — jamais sur un canal OTA |
| **Channex / Airbnb** | **`amount` + `Listing Cancellation Host Fee`** |
| Channex / Booking | somme des `guest_view.total` (centimes) |
| Channex / Offline | `amount` |

Mesure réelle : un séjour Channex/Airbnb à **202 €** porte `amount = 164,43 €`
— **22,85 % d'écart**. Lire `snapshot.amount` amputerait le CA Airbnb de près
d'un quart, et aucun chiffre ne paraîtrait aberrant.

⚠ **Le discriminant est `meta.amount_type`, pas le nom du canal.** « Payout
Amount » est un réglage que HôteSmart pose à la connexion : un canal repris
ailleurs peut servir un `amount` déjà brut, et y ajouter la retenue rendrait
~23 % **au-dessus** du prix payé. Le module **refuse** plutôt que de supposer.

## 3. Répartition UNIFORME — décision de Thierry, 12 septembre 2026

Channex fournit un détail par nuit (`days_breakdown`, parfois inégal :
85,04 / 85,04 / 85,03) ; **Beds24 ne le fournit pas**. L'utiliser créerait deux
précisions selon le provider — la même question aurait deux réponses. On
répartit donc uniformément partout : *l'homogénéité vaut plus que ces centimes
dans un moteur qui compare des années entre elles*.

### ⚠ La conséquence, assumée et à retenir

**Le différentiel week-end/semaine réellement payé est LISSÉ dans le réalisé
éclaté.** Un séjour vendu 85 € le vendredi et 120 € le samedi ressort à
102,50 € sur les deux nuits.

Le signal prix-par-nuit **non lissé** vit dans **`price_display_log`**, pas
ici : c'est lui qui porte ce que chaque nuit affichait, date par date.
**L'étape 4 et la couche jour-de-semaine devront le lire là.**

Le `days_breakdown` reste dans le `raw` du snapshot : si l'on veut un jour
affiner le réalisé, la matière est conservée — rien n'est perdu, seulement non
utilisé.

## 3 bis. Ce qui doit échouer bruyamment

**Un couple (provider, canal) non prévu rend `null`, avec sa raison.** La
branche « Offline » était d'abord un attrape-tout : n'importe quel `ota_name`
inconnu — Expedia, VRBO — y prenait `amount` pour un prix voyageur. Si ce canal
sert un net hôte, c'est ~23 % sous le prix payé, **sans aucun signal**. Le
routage est désormais **exact** : `airbnb`, `bookingcom`, `offline`, rien d'autre.

**Une somme partielle n'est pas un prix.** Sur une réservation Booking
multi-chambres dont une seule porte son `guest_view`, le total était compté
amputé d'une chambre entière et étiqueté valide. On refuse.

**Un `Host Fee` illisible ne produit jamais de `NaN`.** `Number('1.2.3')` rend
`NaN`, et `NaN` n'est pas `null` : le chemin « prix calculable » était pris,
chaque nuit valait `NaN`, et **une seule ligne** rendait `NaN` le CA du mois et
toute somme en aval. Un `NaN` ne se voit pas — il se propage. La regex est de
plus **ancrée sur la fin de ligne**, sinon elle *tronque* au lieu de refuser :
sur `1.2.3` elle capturait `1.2` et rendait un prix crédible mais faux.

**Le statut se lit par `readStatus`, jamais en brut.** Les lignes écrites avant
l'unification portent le vocabulaire brut du provider : un snapshot Beds24
`status: 'new'` **signifie confirmé**. Le lire en brut l'écartait comme « hors
liste blanche » — la réservation disparaissait du CA **et** des nuitées, sans
erreur. Même règle pour `provider` absent, qui doit pouvoir être fourni par
l'appelant (`defaultProvider`).

**La clé du pont porte le compte.** `provider_property_id` n'a aucune unicité
globale : deux hôtes d'un même property manager partagent l'espace de
numérotation. Sans le compte, ils mélangent leurs lignes dans un même groupe —
appariement croisé, ou groupe de trois qui fait perdre un pont valide.

## 4. Liste blanche, jamais liste noire

Seul **`confirmed`** compte. Un filtre `status !== 'cancelled'` ferait entrer
`blocked`, `request` et `demapped` dans les ventes.

Ce qui est écarté l'est **avec sa raison**, jamais en silence. Mesure sur les
1 465 réservations : 1 271 comptées, 194 écartées — 188 annulées, 5 démappées,
1 bloquée.

## 5. Une nuit sans prix reste une nuitée occupée

**79 réservations Beds24 réelles ont `price = 0`.** Elles occupent le logement :
elles comptent au **taux d'occupation**, jamais au **CA**.

⚠ Conséquence pour l'agrégation : un prix moyen calculé bêtement en
`CA ÷ nuitées` serait biaisé vers le bas. `ventilationMensuelle` expose donc
**`nuits_avec_prix`** — sans lui, `{nuits: 2, prix: 0}` est indiscernable de
« 2 nuits vendues 0 € », et l'agrégat ne donnait aucun moyen de s'en garder.

Le repli sur la somme des charges (Beds24 direct) en a récupéré **5** : elles
étaient comptées sans CA alors que le montant était là.

## 6. Le pont `demapped` — emprunter une date, jamais un montant

Une réservation reprise par la migration existe en **deux exemplaires** : la
Beds24 `demapped` (qui porte le vrai `bookingTime`) et la Channex `confirmed`
(comptée, mais dont `inserted_at` vaut la date de **migration**).

Mesure réelle sur `HMEA8PYCPM` : vraie vente le **2 mars 2026**, `inserted_at`
au **10 septembre**. **Six mois d'écart**, sur la mesure même que le « à date »
existe pour produire.

Le moteur **compte la jumelle** et lui **emprunte la date** de la démappée. La
démappée n'est jamais comptée.

**Deux gardes, exigées par la spec :**

| garde | pourquoi |
|---|---|
| même **bien** en plus du même code OTA | un code partagé par deux biens n'apparie rien |
| **refus** si plus de deux lignes par code | au-delà, on ne sait plus laquelle est la jumelle de laquelle ; apparier au hasard donnerait une date fausse à une vraie réservation |

Mesure : 5 dates empruntées, 0 refus.

## 7. Les nuits en exception sont MARQUÉES, pas supprimées

Une nuit hors référence **reste une nuit vendue** : elle compte au réalisé, et
n'est écartée que du calcul de la **référence**. La supprimer à l'éclatement la
retirerait aussi du CA réel — ce qui serait faux.

Chaque nuit porte donc `hors_reference: true|false`, et l'agrégation décide.

## 8. Dates de vente : en JOURS, jamais en instants

`bookingTime` porte une heure, `arrival` est un jour nu. Les comparer comme des
instants déclarait « postérieures à l'arrivée » les **162 ventes faites le matin
même** — le délai 0, soit 11 % de l'historique, et précisément ce que la courbe
de pickup existe pour mesurer.

Une date réellement postérieure à l'arrivée est rendue **marquée non fiable**,
pas supprimée.

## 9. Longs séjours : marqués, ventilés au prorata

Au-delà de **24 nuits**, le séjour est marqué `long_sejour` et sa ventilation
mensuelle répartit le CA au prorata des nuits de chaque mois — un séjour de deux
mois ne verse pas tout son CA au mois de son arrivée.

⚠ **Jamais rencontré en données réelles au 12/09/2026.** Les 1 465 réservations
du cœur n'en contiennent aucun : ce calcul est éprouvé sur données
**construites** uniquement. Le premier séjour long réel doit déclencher une
vérification contre la facture du voyageur — le test porte ce marqueur
explicite.

## 10. Mesure de référence au 12 septembre 2026

```
1 465 réservations →  1 271 comptées,  194 écartées (dont 74 sans prix)
                      2 035 nuitées
                      226 154,01 € de CA voyageur
```

Ce sont les chiffres à retrouver après toute modification du module.
