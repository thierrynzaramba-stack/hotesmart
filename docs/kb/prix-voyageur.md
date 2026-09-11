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

- **Beds24** : `raw.bookingTime` present sur **1 423/1 423**, delai median
  **13 jours**. Seules **2 lignes** sont reellement posterieures a l'arrivee —
  deux annulations `direct` de 2022, sejours d'une nuit, `bookingTime` au
  lendemain. Negligeable.

  ⚠ **Piege de mesure, corrige en cours d'etape 0.** La premiere version de ce
  rapport annonçait **164** lignes corrompues et prescrivait de les ecarter.
  C'etait un artefact : `bookingTime` porte une heure
  (`2026-09-12T09:00:00Z`) tandis que `arrival` est un jour nu (`2026-09-12`)
  que `new Date()` place a minuit UTC. Toute vente faite le matin meme de
  l'arrivee etait donc declaree posterieure. Ces lignes sont en realite les
  **162 ventes a delai 0**, soit 11 % de l'historique — les ecarter aurait
  retire de la courbe de pickup precisement les ventes de derniere minute que
  le yield existe pour mesurer. **Comparer les jours, jamais les instants.**
- **Channex** : `raw.inserted_at` present sur 40/40, mais c'est la date
  d'insertion **chez Channex**, pas la date de vente. Sur les **22 lignes**
  `meta.is_imported = true`, elle vaut la date de migration : 15 lignes datees
  du 11 septembre 2026, 5 du 10 septembre. La preuve est dans les delais :
  **11 jours** de delai apparent median pour les importees contre **2 jours**
  pour les 18 reservations nees dans Channex. Les importees n'ont pas ete
  vendues plus tot — elles ont ete inserees plus tard.

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

6. **`meta.amount_type` est un reglage HoteSmart, pas une constante Airbnb.**
   `api/channel-airbnb-connect.js` pose `booking_amount_settings: 'Payout
   Amount'` a la creation du canal — mais la branche `reuseChannelId` reutilise
   un canal existant sans le garantir, et le reglage peut changer cote Channex.
   Un canal servant un `amount` deja brut ferait rendre a la reconstruction
   ~23 % **au-dessus** du prix paye, sans erreur. C'est pourquoi la regle du §9
   se branche sur `meta.amount_type` lu dans le payload et non sur le nom du
   canal. Aucune ligne dans ce cas aujourd'hui (33/33 en « Payout Amount »).

## 5 bis. Ce que la review a corrige dans ce rapport

Deux chiffres publies par la premiere version etaient faux, et tous deux
allaient dans le sens d'un moteur qui jette de la donnee saine :

| affirmation initiale | apres verification |
|---|---|
| « 164 dates de vente corrompues, a ecarter » | **2** corrompues ; les 162 autres sont des ventes a delai 0 |
| « ecart 6,78 % sur Cœur de vie l 23 » | **22,85 %**, identique a l'autre bien — la premiere formule etait fausse |

La lecon vaut d'etre gardee : sur ce chantier, une mesure qui **disqualifie** de
la donnee doit etre verifiee deux fois plus qu'une mesure qui la valide. Se
tromper en jetant est silencieux ; se tromper en gardant se voit.

## 6. Ce que l'etape 1 doit retenir

Le journal des prix affiches (§4 de la spec) enregistre un prix **pousse par
nous**, donc un brut par construction : il echappe a tout ce rapport. C'est
justement ce qui en fait la reference la plus sure du dispositif — et la raison
de le livrer en premier, puisqu'il n'est pas retroactif.
