# Facture du voyageur — la demande et son lien

Spec : `docs/specs/spec-facture-voyageur.md` §2, §4 bis (P1-P5), §5.3, §11.1
(décisions de Thierry du 8 novembre 2026). Migration :
`migrations/2026-11-10-factures-voyageur-demandes.sql`, éprouvée sur un vrai
Postgres par `scripts/eprouver-demandes-factures.sh` (45 gestes).
L'émetteur, lui, vit dans `docs/kb/entites-juridiques.md`.

Étape 2a (10 novembre 2026) : la base, le lien envoyé dans la conversation, la
page du voyageur, la saisie par l'hôte. L'étape 2b ajoutera le bouton et l'état
sur la fiche de réservation ; l'étape 3, l'émission.

## Les pièces

| pièce | rôle |
|---|---|
| `factures_voyageur` | une ligne par DEMANDE ; elle deviendra la facture à l'émission (étape 3) |
| `factures_voyageur_jetons` | un jeton par ENVOI d'un lien, stocké haché, avec l'issue du message |
| `lib/factures-voyageur.js` | writer unique ; ne garde rien, reçoit un compte déjà vérifié |
| `api/factures-voyageur.js` | les gestes de l'HÔTE : `envoyer_lien` (porte 1), `saisir` (Q12) |
| `api/facture-publique.js` | la page du VOYAGEUR, par son jeton : `lire`, `enregistrer` |
| `pages/facture.html` | la page publique, servie sur `/facture#<jeton>` |

## Les règles, et pourquoi

⚠ **UNE SEULE DEMANDE ACTIVE PAR RÉSERVATION.** C'est un index unique partiel
de la base, pas une discipline du code : les trois portes (fiche, balise,
GuestFlow) passent par `fv_ouvrir_demande` / `fv_nouveau_lien`, qui retrouvent
la demande active au lieu d'en créer une seconde. Seules `annulee_par_avoir` et
`sans_objet` libèrent la place (une nouvelle facture après un avoir est une
nouvelle demande).

⚠ **LA TABLE DES JETONS N'EN GARDE QUE LE SHA256** — 32 octets aléatoires
(256 bits). Un lien perdu ne se relit pas dans cette table : il se renvoie, et
chaque envoi crée un jeton neuf ; les précédents restent valables jusqu'à leur
propre expiration, `max(départ, envoi) + 1 an` (Q13).
⚠ **ET LE LIEN N'EST JAMAIS ÉCRIT EN CLAIR DANS LA CONVERSATION** (décisions
de Thierry du 10 novembre 2026, P2 bis puis P2 ter). Le lien est une CLÉ : il
ouvre — et permet de réécrire — les coordonnées du voyageur. Le cacher à
l'affichage ne suffisait pas (la base le laissait lire, l'IA le recopiait).
Le writer unique du fil, `lib/record-message.js`, le remplace par « [lien de
facture] » AVANT d'écrire, pour tout le monde, l'hôte compris : l'envoi, l'écho
de la synchronisation et une réponse du voyageur qui le cite passent tous par
lui, et la comparaison des échos se fait sur le texte masqué. L'hôte qui envoie
reçoit le lien dans la réponse de l'endpoint (« Copier » sur la fiche, 2b) ; il
peut aussi le renvoyer. Le lien reste dans la conversation de la PLATEFORME
(ou l'e-mail), pour qui a accès à ce compte-là. Motif unique :
`masquerLiensFacture` (lib/factures-voyageur.js) — il échoue fermé (43
caractères pris sans regarder la suite) et reconnaît `\_`, `%2F…%23`, `&#35;`.

⚠ **LE JETON VOYAGE DANS LE FRAGMENT** (`/facture#<jeton>`). Un fragment n'est
envoyé à aucun serveur : le jeton n'entre ni dans les journaux de Vercel, ni
dans un Referer. La page le poste dans le CORPS d'un `POST` — même pour lire.

⚠ **DEUX DROITS POUR ENVOYER LE LIEN** (P1) : `reservations` ET `messages` en
écriture, parce que le geste fait partir un message. Remplir le formulaire à la
place du voyageur (Q12) n'envoie rien : `reservations` en écriture suffit ; la demande s'ouvre et
se remplit en UNE transaction (`fv_saisir_par_hote`), sans demande orpheline. La
réservation désigne le compte et le bien ; un membre hors périmètre est refusé
avant tout geste.

⚠ **L'ENVOI PASSE PAR LE CHEMIN COMMUN** (`sendGuestMessage`), qui route par la
source : messagerie du canal, e-mail pour une directe. L'issue est notée sur le
jeton (`livre`, `refus`, `incertain`, `permanent`, `sans_canal`, `differe`) et
**le fil de la conversation ne reçoit le message que s'il est livré** — pas de
faux vert. Quand le message n'est pas sûrement arrivé, l'endpoint rend le lien
en clair pour que l'hôte le transmette lui-même (P5 : réservation Offline sans
e-mail).

⚠ **ANTI-DOUBLE-CLIC EN BASE** : un second jeton de la même porte dans les
30 secondes est refusé (code dédié `FV429` → 429 `trop_rapproche` ; pas
`55P03`, qui est aussi l'attente de verrou expirée), la ligne de la demande
étant verrouillée pendant le contrôle — l'épreuve Postgres le prouve avec deux
sessions simultanées, et rougit sans le verrou.

⚠ **BIEN ARCHIVÉ (P3)** : aucune NOUVELLE demande. Une demande DÉJÀ en cours y
va au bout — l'hôte peut encore remplir le formulaire, et renvoyer le lien.
⚠ **SEULE UNE RÉSERVATION CONFIRMÉE SE FACTURE** : annulée, `demapped`
(ancienne copie d'un séjour migré), `blocked`, `request` — aucun geste. La page
du voyageur dit « sans objet » dès qu'une réservation est annulée, sans attendre
la passe du cron. **Une facture émise** ne reçoit plus le lien « remplissez ».

⚠ **L'ISSUE D'UN ENVOI, CLASSÉE PRUDEMMENT** : un envoi simulé (Beds24 sans
`SENDVIABEDS24_ENABLED`, donc toute la recette staging) est `differe`, jamais
`livre` ; un e-mail qui échoue sans cause sûre est `incertain` (le chemin commun
ne transmet pas ce drapeau du moteur e-mail) — seuls « permanent » et « quota »
sont sûrs. Une saisie directe Beds24 n'a aucun fil : `sans_canal`, rien ne part.
Une réservation Channex classée « sans canal » (source `direct`) passe quand même,
par l'identifiant : c'est Channex qui tranche.

⚠ **LA PAGE NE REÇOIT QUE SA DEMANDE** : langue, état, destinataire saisi, nom
du logement et dates du séjour. Ni l'identité de l'hôte avant l'émission, ni
aucune référence interne (compte, bien, réservation). Le départ est RELU dans le
cœur à chaque lecture. Un jeton mal formé est refusé sans requête ; un jeton
expiré se dit comme tel (« demandez un nouveau lien à votre hôte »).

⚠ **LE DESTINATAIRE** : requis — type, nom, adresse, ville, pays ; SIREN à
9 chiffres et TVA intracommunautaire pour une société, facultatifs ; un
particulier n'en a pas (ce qu'un champ caché aurait gardé est jeté). Bornes de
taille en base. **Verrouillé à l'émission** : un trigger refuse tout changement
de destinataire d'une facture émise, toute suppression d'une facture, tout
retour en arrière d'un état terminé. **20 formulaires au plus par jeton.**

⚠ **PAS DE CLÉ ÉTRANGÈRE vers `properties` ni `auth.users`** (précédent :
`taxes_sejour`) : une demande, puis une facture, ne doit jamais disparaître avec
un bien ou un compte supprimé.

⚠ **RLS ACTIVE, AUCUNE POLICY, REVOKE** sur les deux tables, et `revoke
execute` des trois fonctions pour `public`, `anon` et `authenticated` (Supabase
leur accorde EXECUTE nominativement). L'épreuve Postgres le vérifie avec les
droits par défaut de Supabase rejoués — sans eux, les refus du navigateur
passeraient pour la mauvaise raison.

## Limites connues

- **Le lien nomme le domaine** `hotesmart.vercel.app` tant qu'un domaine propre
  n'existe pas : le texte du message ne nomme pas HôteSmart, l'URL si.
- **Beds24, comptes gratuits** : le chemin commun ajoute la signature GuestFlow
  au message — comportement de tous les messages Beds24, pas de ce lot.
- **`differe`** (canal e-mail coupé, envoi simulé) : rien ne relance l'envoi ;
  le lien revient à l'hôte, qui le transmet.
- **Routage par le provider du BIEN** (chemin commun) : pendant une migration,
  une réservation peut partir par l'autre provider — même règle que le cron.
- **Deux envois du lien à moins de 10 minutes** : le fil n'en montre qu'un —
  masqués, leurs textes sont identiques, et la déduplication des sortants de
  `recordMessage` les confond. Les deux jetons, eux, sont en base.

## Les langues

La langue du voyageur vient de la réservation (`customer.language` du payload
brut, puis le snapshot) ; hors fr/en/es, ou inconnue : **anglais** (P5). Le
message du lien est celui validé par Thierry (§11.1), au nom de l'hôte, sans
nommer HôteSmart. La page publique porte ses trois langues en ligne, comme
`pages/book.html`, et le voyageur peut en changer.
