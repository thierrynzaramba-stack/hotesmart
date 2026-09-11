# Prix voyageur — rapport d'ecart (etape 0 YieldFlow)

Spec : `docs/specs/spec-yieldflow-v1.md` §3 et §9.
Script : `node scripts/audit-prix-voyageur.js --detail` — **lecture seule,
n'ecrit rien**, ni en base ni chez le provider.
Mesure du 11 septembre 2026 : 1 464 lignes `bookings_snapshot`, 1 463 avec `raw`.

## 1. Le constat qui commande tout le reste

`lib/bookings-snapshot.js` documente son champ `amount` ainsi :

> `amount` — total facture au VOYAGEUR, jamais le net hote

Et le mapper Channex commente `amount: nombreOuRien(b.amount)` par
« Channex sert deja le total voyageur ».

**C'est faux sur le canal Airbnb.** Channex l'ecrit lui-meme dans le payload :

```
meta.amount_type = "Payout Amount"   -> 33 lignes sur 33
```

Le controle arithmetique le confirme sur les memes 33 lignes, exemple reel :

| grandeur | source | valeur |
|---|---|---|
| `amount` servi par Channex | payload | **82,21** |
| `Listing Cancellation Host Fee` | `notes` | 18,79 |
| **prix voyageur = somme** | reconstruit | **101,00** |

`Listing Cancellation Host Fee` est lisible sur **33/33** lignes.
**Ecart median : +22,85 %** entre le prix voyageur et ce que le coeur
enregistre. Ce n'est pas une derive de quelques lignes : le ratio est
rigoureusement constant (22,85 % sur les deux biens migres), donc systematique
et non aleatoire.

Cote Beds24 la meme retenue Airbnb se lit a **18 % de mediane** sur 867 lignes
(le meme prelevement, exprime en part du brut au lieu du net : 18,6/100 contre
18,79/82,21). Les deux providers voient la meme realite commerciale ; ils n'en
exposent pas la meme face.

## 1 bis. La preuve : le meme sejour vu par les deux providers

Deux reconstructions etaient plausibles, et il fallait trancher par les faits,
pas par le raisonnement. Les 5 reservations Airbnb dedoublonnees a la bascule
portent **le meme sejour reel des deux cotes** (`demapped` cote Beds24,
`confirmed` cote Channex) :

| code OTA | `beds24.price` | `amount` + Host Fee | `Base Price` + `Cleaning Fee` |
|---|---|---|---|
| HMADA4CMQR | 134 | **134** ✓ | 125 ✗ (−9) |
| HMEA8PYCPM | 485 | **485** ✓ | 413 ✗ (−72) |
| HMXJPMDJEN | 130 | **130** ✓ | 130 ✓ |
| HMYSC3QK8X | 160 | **160** ✓ | 160 ✓ |
| HM4TMX5QXQ | 119 | **119** ✓ | 119 ✓ |

**5/5 contre 3/5.** La lecture « tarif d'annonce + menage » aurait passe un test
sur trois reservations bien choisies et menti jusqu'a 14,8 % sur les deux
autres (−9 sur 134, −72 sur 485) :
`Listing Base Price` est le tarif **affiche**, pas le prix **paye** — remises,
supplements voyageurs et frais additionnels n'y figurent pas. Seul le couple
(net verse, retenue) se recompose exactement.

Les doublons etaient une anomalie de la bascule ; ils se sont reveles le seul
instrument de mesure disponible. Le controle est desormais dans
`scripts/audit-prix-voyageur.js` : s'il cesse de dire 5/5, la regle est fausse.

## 2. Tableau par (provider, canal)

Grave au §9 de la spec — ne pas le dupliquer ici. Resume operationnel :

- Beds24, trois canaux : `raw.price`. **Homogene**, l'hypothese de la spec tient.
- Channex Airbnb : **`amount` + `Listing Cancellation Host Fee`**. `amount` seul
  est un net hote. Ne pas passer par `Listing Base Price`.
- Channex Booking : `guest_view.total`. `amount` coincide sur les confirmees
  mais suit la penalite sur les annulees.
- Channex Offline : `amount` (c'est nous qui l'ecrivons).

## 3. Ecart chiffre sur les biens migres

Les deux biens bascules vers Channex portent, **sous une seule cle**, un
historique Beds24 en brut et un present Channex en net :

| bien | historique beds24 (brut) | present channex (net) | CA channex enregistre | manque pour etre comparable |
|---|---|---|---|---|
| La bulle | 573 resas airbnb | 3 resas | 332,92 € | **76,08 € (22,85 %)** |
| Cœur de vie l 23 | 273 resas airbnb | 2 resas | 503,86 € | **115,14 € (22,85 %)** |

Le taux est identique sur les deux biens, ce qui est attendu : la retenue Airbnb
est un pourcentage unique, pas une negociation par annonce. Un taux qui
divergerait d'un bien a l'autre serait le signe d'une erreur de formule — c'est
d'ailleurs ce qu'affichait la premiere version de ce rapport (6,78 %) avant que
la validation croisee du §1 bis ne corrige la reconstruction.

**Consequence directe pour YieldFlow** : le jour de la bascule, un moteur qui
lirait `snapshot.amount` verrait le CA Airbnb de ces biens chuter de ~19 %
**sans qu'aucune vente ne soit perdue**, et suggererait mecaniquement de baisser
les prix pour « rattraper » une perte qui n'existe pas. C'est le pire mode de
defaillance possible pour un moteur de yield : silencieux, chiffre, et
directionnellement faux.

## 4. Date de vente

- **Beds24** : `raw.bookingTime` present sur **1 423/1 423**. Mais **164 lignes**
  le portent posterieur a la date d'arrivee, reparties sur 2022 a 2026. Sur
  **42 d'entre elles** `bookingTime` est identique a `modifiedTime` a la seconde
  (la date de creation a ete ecrasee par une modification) ; pour les 122 autres
  la cause n'est pas etablie a ce stade. Dans les deux cas la date est
  inexploitable pour une courbe de delai : ces lignes doivent etre **ecartees du
  calcul**, pas corrigees — 11,5 % de l'historique Beds24.
- **Channex** : `raw.inserted_at` present sur 40/40, mais c'est la date
  d'insertion **chez Channex**, pas la date de vente. Sur les **22 lignes**
  `meta.is_imported = true`, elle vaut la date de migration : 15 lignes datees
  du 11 septembre 2026 et 5 du 10 septembre, pour des sejours deja passes
  (10 « ventes » posterieures a leur propre arrivee).

Donc le « a date » / pickup de l'etape 3 **ne peut pas remonter avant la
bascule** sur les biens migres. A assumer dans la restitution plutot qu'a
masquer : la courbe de delai demarre a la premiere vente nee dans Channex.

## 5. Anomalies constatees — signalees, NON corrigees

Etape 0 = lecture seule. Rien de ce qui suit n'a ete modifie.

1. **`property_id` n'est pas `properties.id`.** Les 1 464 lignes portent un UUID,
   mais c'est le `provider_property_id` **Channex**, pas la cle HoteSmart. La
   cle provider Channex etant elle-meme un UUID, elle est indiscernable a l'oeil
   d'un `properties.id` — un `join` naif sur `properties.id` rend **zero ligne,
   sans erreur**. Confirme la decision E6 (§2) : les tables YieldFlow se clent
   sur `properties.id`, et le pont passe par `provider_property_id`.
   (Note : `CLAUDE.md` decrit `property_id` comme « TEXT provider propId » — la
   convention est respectee, c'est bien la cle provider ; c'est sa *forme* UUID
   cote Channex qui trompe.)

2. **Le re-keying d'hier a place l'historique Beds24 sous la cle Channex.**
   Les 637 lignes beds24 de « Cœur de vie l 23 » et les 786 de « La bulle »
   portent la cle provider du bien **Channex**. C'est le comportement voulu
   (l'historique suit le bien, pas le provider) et c'est ce qui rend la serie
   continue — mais c'est aussi exactement ce qui rend la rupture de semantique
   du §3 invisible : meme bien, meme cle, deux definitions du prix.

3. **Statut `demapped` hors canon.** 5 lignes le portent, alors que les statuts
   canoniques sont `confirmed | cancelled | blocked | request`. Tout lecteur
   qui filtre par `status !== 'cancelled'` les comptera comme des ventes. Les
   5 lignes sont les doublons Beds24 des resas Airbnb reprises par Channex
   (`HMADA4CMQR`, `HMEA8PYCPM`, `HMXJPMDJEN`, `HMYSC3QK8X`, `HM4TMX5QXQ`) :
   chaque code OTA est porte par exactement 2 lignes, 1 beds24 `demapped` +
   1 channex `confirmed`, sous le meme bien. Le dedoublonnage a donc bien
   opere ; c'est le **vocabulaire de statut** qui n'a pas suivi. YieldFlow doit
   filtrer sur une liste blanche (`confirmed`), jamais sur une liste noire.

4. **Le bien `coeur de vie 23 [beds24/169567]` existe encore avec 0 ligne de
   snapshot.** Son historique est parti sous la cle Channex (point 2). Si un
   cycle Beds24 rencontre encore ce bien, le writer recreera des lignes sous
   `property_id = '169567'` : l'historique existerait alors sous deux cles, et
   toute agregation le compterait deux fois. A verifier avant l'etape 3.
   Meme observation pour `colomier [channex/8232ff8a…]`, deja connu comme bien
   de test non provisionne.

5. **1 ligne channex `cancelled` sans `raw`.** Marginal, mais le moteur doit
   traiter `raw` absent comme « prix inconnu », jamais comme zero.

## 6. Ce que l'etape 1 doit retenir

Le journal des prix affiches (§4 de la spec) enregistre un prix **pousse par
nous**, donc un brut par construction : il echappe a tout ce rapport. C'est
justement ce qui en fait la reference la plus sure du dispositif — et la raison
de le livrer en premier, puisqu'il n'est pas retroactif.
