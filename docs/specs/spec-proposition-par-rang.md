# Spec — Proposer un ménage à tout un rang à la fois

**Statut : PROPOSÉE, en attente du go de Thierry. Aucun code avant.**
Rédigée le 2 octobre 2026, branche `spec-proposition-par-rang`.

## 1. Le besoin

Aujourd'hui, quand personne ne porte un ménage d'office, il est proposé à **une**
prestataire à la fois : elle a jusqu'à 48 h, puis la suivante, puis la suivante.
À Ofuro Futari, les trois prestataires sont au même rang (2) : l'ordre de passage
est fixé par un **identifiant technique** (Lola, puis Tiphaine, puis Lena), et un
ménage peut attendre plusieurs jours avant de trouver preneuse.

**Demande de Thierry** : l'hôte règle un **rang** par prestataire et par bien, et
la proposition part **en même temps** à toutes les personnes d'un même rang.
Exemple à Ofuro Futari : rang 1 = Tiphaine et Lena, rang 2 = Lola.

## 2. La règle

1. **On ne change rien quand quelqu'un porte d'office** (`requires_ack = false`) :
   le ménage est à elle, il n'y a pas de proposition.
2. Sinon, le **tour** commence par le **plus petit rang** qui a au moins une
   candidate (de garde ce jour-là, disponible, pas déjà sollicitée pour ce
   ménage). **Toutes les candidates de ce rang** reçoivent la proposition **en
   même temps**, avec **la même échéance**.
3. **La première qui accepte l'a.** Pour les autres, la proposition disparaît.
4. **Un refus ne clôt pas le tour** : les autres du rang gardent la proposition.
5. Le tour se clôt quand **toutes** les personnes du rang ont refusé, ou à
   l'**échéance** (un silence vaut refus, comme aujourd'hui). Le rang suivant est
   alors sollicité, avec une **nouvelle échéance**.
6. Quand il n'y a plus de rang : le ménage devient « sans prestataire »,
   l'hôte est alerté, et il est « à prendre » dans la bulle de toutes —
   **inchangé**.
7. Inchangés aussi : la proposition ne part qu'**à 7 jours** du départ ;
   l'échéance est de **48 h au plus**, jamais après la **veille à 18 h** (1 h si
   la veille est passée) ; on ne resollicite **jamais** qui a refusé ou laissé
   expirer ce ménage.

**Exemple, dimanche 4 octobre à Ofuro Futari, avec les rangs voulus** : Tiphaine
est absente ce jour-là, donc le rang 1 ne compte que Lena → proposée seule. Si
Lena ne répond pas, le rang 2 (Lola) est sollicité. Un ménage sans absence au
rang 1 partirait à Tiphaine **et** Lena en même temps.

## 3. Le réglage du rang (fiche de la prestataire)

Sur la fiche (`apps/menages/prestataires.html`), pour chaque bien coché, à côté
de « Elle confirme / D'office » : un sélecteur **« Rang 1 / 2 / 3 »**. Le rang
existe déjà en base (`property_cleaning_providers.rang`) mais **aucun écran ne le
règle** aujourd'hui. Writer : celui des liaisons (inchangé). Portage mobile :
cette ligne de la fiche suit la règle de la carte visibilité (44 px).

> **Question 1** — Combien de rangs proposer : 3 (ta demande) ou plus ?
> Proposition : 3.

## 4. Données — une table des propositions

Le modèle actuel ne porte qu'**une** proposition par ménage
(`menages.offered_to`, une seule personne, et ses contraintes
`menages_offre_datee`, `menages_offre_pas_a_soi`). Il faut une table :

```
menage_propositions
  id           uuid pk
  user_id      uuid not null        -- le compte
  menage_id    uuid not null -> menages(id) on delete cascade
  provider_id  uuid not null -> profiles(id)
  rang         int  not null
  propose_le   timestamptz not null
  expire_le    timestamptz not null
  etat         text not null  -- en_attente | acceptee | refusee | expiree | retiree
  repondu_le   timestamptz
  unique (menage_id, provider_id)  -- on ne sollicite jamais deux fois
```

- **Writer unique** : le moteur (`lib/cleaning/…`) pour poser, expirer et
  retirer ; `api/menages-public.js` pour accepter / refuser (la réponse de la
  prestataire). RLS activée, lecture `menages`, aucune écriture client.
- **La mémoire des refus** (aujourd'hui lue dans `menage_assignment_log`) se lit
  ici : un `unique (menage_id, provider_id)` garantit qu'on ne sollicite pas deux
  fois. Le journal reste écrit, pour l'historique.
- **`menages.offered_to`** cesse d'être écrit (il ne peut pas porter deux
  personnes). Il est conservé le temps de la bascule puis supprimé dans un lot
  ultérieur. ⚠ **Deux sources de vérité pendant la bascule seraient un piège** :
  tous les lecteurs passent à la table **dans le même lot**.
- **`menages.status = 'offered'`** et `offer_expires_at` (échéance du tour)
  restent, pour l'écran de l'hôte et les filtres existants.

Migration versionnée, lignes < 60 caractères, appliquée staging puis prod par
Thierry, prouvée par un vérificateur — comme `menage_visibilite`.

## 5. Ce qui change dans le code (lecteurs de `offered_to`)

| Fichier | Changement |
|---|---|
| `lib/cleaning/assign.js` | `deciderParGarde` rend le **rang** à solliciter et **toutes** ses candidates, pas une seule |
| `lib/cleaning/sync-menages-entite.js` | poser un tour (N lignes), expirer un tour, passer au rang suivant, épuisement |
| `lib/cleaning/notifier-prestataire.js` | un SMS/e-mail **par personne du rang** |
| `api/menages-public.js` | « proposé à moi » = une ligne `en_attente` à mon nom ; **accepter = course** : écriture conditionnelle (`provider_id is null`), la perdante reçoit « déjà pris par une collègue » ; refuser = ma ligne seulement |
| `apps/menages/public.html` | inchangé dans la forme (bulle, « À confirmer ») ; le message de course perdue |
| `api/garde.js`, `apps/menages/index.html` | « proposé à Lena et Tiphaine » au lieu d'un seul nom |
| `api/menages.js` | proposition manuelle par l'hôte : à une personne (une ligne), inchangé côté écran |
| `lib/cleaning/apres-changement-regles.js` | reprise des propositions d'une personne qui change ses jours : sa ligne seulement |
| `api/cron.js` | fichier COMPLET si touché (règle du dépôt) |

> **Question 2** — Quand l'une accepte, les autres du rang **voient la
> proposition disparaître**. Faut-il en plus leur envoyer un SMS « pris par une
> collègue » ? Proposition : **non** (bruit) — la bulle s'efface à leur prochaine
> ouverture, et si elles tentent d'accepter, l'écran le dit.

> **Question 3** — Une personne **refuse** pendant que les autres du rang n'ont
> pas répondu : l'hôte reçoit-il quelque chose ? Proposition : **non**, l'alerte
> ne part qu'à l'épuisement de tous les rangs (comme aujourd'hui) ; le refus se
> lit sur l'écran de garde.

## 6. Garde-fous

- **La course** : deux acceptations simultanées → une seule réussit (écriture
  conditionnelle) ; jamais deux porteuses. Test dédié.
- **Jamais une proposition à soi-même** ni à quelqu'un qui porte déjà.
- **Une personne ne voit que SA proposition** : ni le nom des autres sollicitées
  (la PWA ne montre pas « proposé aussi à Lena »).
- **Pas d'envoi de masse** : la proposition ne part qu'à 7 jours du départ (garde
  de REVIEW.md règle 2 inchangée) ; un rang de N personnes = N messages, et le
  plafond par cycle (`MAX_NOTIFS_PAR_CYCLE`) s'applique toujours.
- **Bascule** : les ménages déjà `offered` à une personne au moment du
  déploiement sont repris tels quels (une ligne par proposition en cours) par la
  migration — aucun ménage ne perd sa proposition.

## 7. Tests (chacun rouge contre le code actuel)

1. Rang 1 de deux personnes → **deux** propositions, même échéance.
2. La première qui accepte l'a ; la seconde reçoit « déjà pris », jamais deux
   porteuses (acceptations simultanées).
3. Un refus au rang 1 ne sollicite pas le rang 2 tant qu'une autre du rang 1
   n'a pas répondu.
4. Tout le rang 1 refuse ou expire → rang 2 sollicité, nouvelle échéance.
5. Une personne absente ce jour-là ne reçoit rien (exemple du 4 octobre).
6. Personne n'est resollicitée pour un ménage qu'elle a refusé ou laissé expirer.
7. Épuisement → « sans prestataire » + alerte (non-régression).
8. D'office (`requires_ack = false`) → aucune proposition (non-régression).
9. Le réglage du rang sur la fiche s'écrit et se relit.
10. La migration reprend une proposition en cours sans la perdre.

## 8. Documentation

`docs/kb/menage.md` (nouvelle section, et la section « Qui fait le ménage »
mise à jour), `pages/guide.html` (le rang expliqué à l'hôte).

## 9. En attendant le code

Rien n'empêche de régler les rangs voulus dès maintenant… sauf qu'**aucun
écran ne le permet** : il faudrait écrire en base prod. Et avec le moteur actuel,
Tiphaine et Lena au rang 1 seraient sollicitées **l'une après l'autre** (par
identifiant), pas en même temps.

> **Question 4** — Poser les rangs en prod tout de suite (écriture en base sur
> ton go) pour profiter au moins de l'ordre voulu, ou attendre le lot ?
> Proposition : **attendre** — le sélecteur de rang arrive avec le lot.
