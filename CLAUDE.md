# CLAUDE.md — HôteSmart

SaaS LCD modulaire (App Store hôtes francophones). Product owner = Thierry (non-dev, ne parle pas anglais — traduire si besoin). Claude = développeur AI.

## INTERACTION
- Répondre en français. Étape par étape. UNE action à la fois.
- Pas de postambules, récaps, félicitations, emoji. Finir sur du technique direct.
- Ne JAMAIS afficher/coller une clé, un token ou un secret — règle absolue ci-dessous.

## RÈGLE ABSOLUE — LE CLONE EST PARTAGÉ PAR PLUSIEURS SESSIONS

- **Avant de commiter : `git status --short`.** Un fichier modifié qu'on n'a pas
  touché soi-même appartient à quelqu'un d'autre. On commite **par chemins
  explicites** — `git add <fichiers>` — et **jamais** `git add -A`, `git add .`
  ni `git commit -a`.
- **Aucun `git checkout` / `switch` / `stash` sans prévenir Thierry.** L'arbre de
  travail est COMMUN : changer de branche change le sol sous les pieds de
  l'autre session, en plein milieu de son édition.
- **Un chantier long se fait dans un worktree séparé** (`git worktree add`), pas
  dans le clone principal. `/home/thierry/hotesmart-b` le fait déjà pour
  `prestataires-lot3`.
- **On se prévient par `SendMessage`** dès qu'on ouvre un fichier : lequel, et
  pour combien de temps. `ListAgents` dit qui tourne.

**Vécu (18 septembre 2026), deux fois dans la même soirée.** Une session a fait
`git add -A` pendant qu'une autre corrigeait six constats de review dans
`api/inbound-email.js` : son commit a emporté 220 lignes de correctifs de
sécurité **non re-reviewés** et les a poussées sur `main` et `channex-phase1`,
donc en production, au moment précis où l'autre retenait le push en attendant la
review. Le message du commit annonçait « aucune de code ». Le même soir, un
`checkout` pour lire un fichier a changé la branche des deux sessions.

**Pourquoi c'est une règle absolue.** Le code emporté était juste — cette fois.
Ce qui ne se répare pas, c'est la ligne de journal : elle dira faux à qui la
lira dans six mois, et l'historique est la seule chose qu'on ne peut pas
corriger sans réécrire ce que deux branches ont déjà tiré.

## RÉFLEXE MACHINE (multi-machines Mac bureau / PC portable)
- AVANT toute modif quand on change d'ordi : `git checkout main && git pull origin main`.
- Workflow commit : checkout main && pull && add && commit && push origin main && checkout channex-phase1 && merge main && push origin channex-phase1.
- Mac : repo /Users/thierry/Desktop/hotesmart, zsh, here-docs OK.
- PC : repo ~/hotesmart, Git Bash (here-docs cassent), PowerShell `;` pas `&&`. WSL2 si dispo.
- **Aucune branche dont le nom contient « staging »**, sauf la branche `staging`
  elle-même (cible du projet Vercel staging : elle reçoit la branche d'un lot
  AVANT main, pour la recette, puis main après le merge ; aucun commit n'y est
  fait directement). Une preview du projet de PRODUCTION porte le nom de branche dans
  son hostname : `hotesmart-git-<branche>-<equipe>.vercel.app`. Une branche
  `staging-xxx` y produit un hostname qui parle de staging alors que les
  fonctions `/api` tournent sur la prod. Le résolveur de `shared/config.js`
  ferme déjà ce cas par des motifs ancrés — cette règle est la seconde ligne,
  pour le jour où un domaine propre changera la forme des hostnames.

## STACK
- frontend = HTML/JS statique (/pages, /apps). Scope module ES → window.fn.
- backend = Vercel Serverless /api en **CommonJS** (require/module.exports — JAMAIS import ES6).
- DB = Supabase projet cjmrizpdyhrcurmgyrhs. RLS 28/28 actif — ne JAMAIS désactiver RLS (lecture globale = policy explicite TO authenticated USING(true)).
- auth = Supabase Auth + SMTP Brevo. ai = Claude Haiku via /api/grok.js.
- pms = DUAL-PROVIDER PERMANENT : Beds24 (hôtes équipés) + Channex (hôtes sans CM). Routage par properties.provider via lib/channels/. Marque blanche : variables CHANNEL_* jamais CHANNEX_*.
- paiements = Stripe TEST. emails = Brevo. cron = Vercel natif */5 → /api/cron (Bearer CRON_SECRET).
- deploy = hotesmart.vercel.app (Vercel Pro, 100 fonctions, auto-deploy sur push main). Branche travail = channex-phase1.

## ARCHITECTURE — LE CŒUR DE DONNÉES D'ABORD
- Toute donnée collectée auprès d'un provider (Channex, Beds24, et ceux qui
  viendront) est **d'abord répertoriée dans le cœur de données HôteSmart** —
  les tables Supabase, écrites **par la couche sync uniquement** — puis rendue
  accessible aux apps (ménage, messagerie, yield, avis…) pour leur traitement
  particulier.
- **Aucune app ne lit un provider directement.** Aucune donnée n'existe
  seulement dans une app.
- C'est la généralisation du principe `bookings_snapshot` : un writer unique, un
  schéma commun aux deux providers, et toutes les apps qui lisent la même vérité.
- Vécu : le planning ménage appelait `/api/beds24` en direct, donc un hôte
  Channex voyait un planning **vide** (écart E1 de l'audit d'unification). Le
  correctif n'a pas été d'ajouter un second appel provider dans l'app, mais de la
  faire lire le cœur.
- Corollaire pratique : une nouvelle donnée provider se traite dans cet ordre —
  table du cœur, writer dans `lib/`, puis lecture par l'app. Jamais l'inverse.

## ARCHITECTURE — CONFIG D'APP vs CONFIG GÉNÉRALE
- **La configuration d'une APP vit DANS l'app.** Prestataires de ménage et leurs
  biens → `apps/menages/prestataires.html`. Modèles de messages → l'app
  messagerie. Réglages de tarification → l'app yield.
- **`/settings` ne porte que la configuration HôteSmart GÉNÉRALE** : identités,
  accès, droits par domaine, facturation, connexions.
- **Test qui tranche : ce réglage a-t-il un sens si l'app n'existait pas ?**
  Oui → `/settings`. Non → dans l'app.
- Corollaire : un prestataire de ménage n'a **pas accès à HôteSmart**, seulement
  à l'app ménage. Il reste un profil `access_mode = 'lien'` en base — le modèle
  de données ne bouge pas, les avis et la qualité en auront besoin — mais seul
  l'écran de l'app ménage le gère.
- Vécu : gérer les prestataires depuis `/settings` y avait introduit un second
  writer de `public_tokens.property_ids`, donc l'écrasement silencieux des biens
  réglés dans l'app ménage.

## RÈGLE ABSOLUE — REVIEW AVANT PUSH
- **Aucun push tant qu'une review est en cours.** La review fait partie du commit,
  pas de l'après-commit : on attend son retour, on la LIT, on corrige, puis on pousse.
- Vécu : un push lancé pendant une review a mis en production une régression
  bloquante (l'envoi de SMS cassé ~20 min) que cette même review a signalée en
  premier point. Sur ce chantier, chaque review a trouvé au moins un défaut réel
  dans du code qui passait les tests.
- Corollaire : `npm test` au vert n'autorise pas à pousser. Les tests disent que
  ce qu'on a pensé à vérifier fonctionne, pas que le code est correct.

## RÈGLE ABSOLUE — LIRE AVANT D'ÉCRASER
- **Un fichier existant se lit avant d'être réécrit.** `ls` / `git log -- <chemin>`
  d'abord ; si le fichier existe, on l'ouvre EN ENTIER, et on édite de façon
  ciblée plutôt que de réécrire.
- Après une écriture : `git diff --stat`. Un diff de 90 lignes supprimées là où
  on croyait en ajouter 15 signale qu'on a écrasé, pas complété.
- Vécu (12 septembre 2026) : `api/yield-exceptions.js`, livré au lot 2.2 avec
  ses gardes apprises en review, réécrit sans être lu — 97 insertions,
  92 suppressions. C'est un TEST du lot 2.2 qui a refusé de passer, pas la
  prudence. L'ajout réellement nécessaire faisait 17 lignes.
- Détail et corollaire : REVIEW.md règle 14.

## RÈGLE ABSOLUE — UN SECRET NE PASSE JAMAIS PAR LE TERMINAL

- **Un secret s'écrit directement dans son fichier cible.** Il ne s'affiche pas,
  ne se colle pas dans une réponse, ne transite pas par une sortie de commande.
- Ce qu'on affiche d'un secret : le **nom de la variable** et sa **longueur**.
  Rien d'autre. `CRON_SECRET écrit (64 caractères)` est un compte rendu complet.
- Vaut aussi pour la LECTURE : `vercel env pull` écrit les valeurs en clair.
  On ne lit jamais le fichier produit en entier — on liste les NOMS
  (`vercel env ls`), et on supprime le fichier aussitôt.
- Un secret généré pour être posé dans une interface se génère **dans cette
  interface** quand elle le permet, sinon il est écrit dans un fichier local
  hors dépôt que le product owner ouvre lui-même.

**Pourquoi.** Un terminal n'est pas un canal privé : la sortie part dans
l'historique du shell, dans les transcriptions de session, et dans tout ce qui
les archive. Un secret affiché est un secret à faire tourner — le coût n'est pas
l'affichage, c'est la rotation et la fenêtre pendant laquelle l'ancienne valeur
reste valable.

**Vécu (14-15 septembre 2026).** Pendant la préparation du chantier staging,
`vercel env pull` puis la lecture du fichier produit ont exposé quatre secrets de
production en clair, dont `BREVO_API_KEY` et `CLAUDE_API_KEY` — tous deux
facturables. Le `CRON_SECRET` de remplacement, généré pour corriger la fuite, a
été affiché à son tour : le correctif a reproduit le défaut. La règle
« ne jamais afficher un secret » existait déjà en INTERACTION ; ce qui manquait
était le GESTE de remplacement — écrire dans le fichier, rendre compte par le
nom et la longueur.

## RÈGLE ABSOLUE — UNE REVIEW PAR COMMIT, PAS DE BOUCLE
- **Une review par commit.** Si elle trouve un problème de SÉCURITÉ (fuite entre
  comptes, contournement de garde, authentification), on corrige et on re-review
  **une seule fois** les correctifs.
- Tout le reste — mineur, style, durcissement optionnel — se corrige **sans
  nouvelle review**, ou se note au KB comme dette.
- **Deux reviews sans constat de sécurité = on pousse.**
- Vécu : neuf reviews enchaînées sur le même groupe d'endpoints. Les trois
  premières ont trouvé les vraies fuites ; les six suivantes n'ont plus trouvé
  que du durcissement, chaque correctif ouvrant le prétexte d'une review de plus.
  Le coût dépassait le gain, et deux régressions ont été introduites par les
  correctifs eux-mêmes.

## RÈGLES TECHNIQUES DURES (non négociables)
- api/grok.js : NE JAMAIS RENOMMER/SUPPRIMER (wrapper Haiku, legacy Lisa). Utilisé par agent-ai/index.html, messages.html, analyze.html, messagerie.html, extract-kb.js.
- api/cron.js : TOUJOURS généré en fichier COMPLET. Jamais de patch manuel partiel.
- api/simulate.js : ne pas supprimer.
- vercel.json cleanUrls=true : rewrites SANS .html dans la destination (sinon 404).
- Tout code canal via lib/channels/ (getProvider). Jamais Beds24/Channex en dur.
- properties.id = UUID ; property_id des tables enfant = TEXT (provider propId). Ne JAMAIS joindre naïvement uuid vs text.
- room_type/rate_plan Channex stockés dans properties.provider_room_type_id / provider_rate_plan_id.
- SENDVIABEDS24_ENABLED doit être 'true' en prod (sinon envoi Beds24 = DRY RUN silencieux).
- Beds24 token : refresh auto cron 5min. Généré 15 avril 2026, expire 14 juillet 2026.

## GARDE-FOUS PRODUIT
- AUCUN autre bridge CM (Smoobu, Hostaway, Lodgify) ni marque de serrure avant prospect réel.
- inventory_type : seul 'whole' codé. PWA hôte = V2 (après 10+ clients payants).
- Refonte mobile messagerie.html AVANT d'annoncer la messagerie sur la landing.

## 3 BOUSSOLES (challenger toute feature, franc, pas complaisant)
1. Mettre en ligne rapidement. 2. Produit viral et indispensable. 3. Différenciation + résolution douleurs aiguës.

## ÉTAT (fin Session #22)
Certification PMS Channex SOUMISE (formulaire Google enregistré). En attente revue live Channex.

**Chantier AVIS VOYAGEURS CLOS** (lots 1-7) : `ota_reviews` au cœur, poll
quotidien Channex (70 avis), webhook `updated_review`, classification propreté
en deux étages (règle avant IA), page `/avis`, saisie manuelle, et détection
automatique dans les messages entrants — 359 analysés, 5 signalements, 0 faux
positif, avec validation humaine avant tout comptage. Beds24 tranché : 93 avis
Booking.com importés ; les avis Airbnb de ces biens sont hors de portée de
l'API Beds24 et viendront avec leur migration Channex (doc officielle).
168 avis dans le cœur. Bilan et leçons : docs/kb/avis-voyageurs.md §10-11.

**Chantier profils et droits CLOS** (étapes 0-5) : 26/26 endpoints gardés,
10 fuites fermées, sélecteur de compte et masquage par droit livrés et validés en
production. Détail et dettes : docs/kb/profils-et-droits.md §12.
L'étape 6 (fiche prestataire) est fusionnée dans le chantier prestataires.

**Chantier HISTORIQUE DES RÉSERVATIONS CLOS** : le cœur porte le payload
provider intégral (`bookings_snapshot.raw` + empreinte), backfill one-shot
214 → 1436 lignes, 11 ménages fantômes réconciliés, rattachement des avis
5/28 → 24/28. Détail : docs/kb/bookings-snapshot.md §4 bis à §4 quater.

**Chantier RÉSERVATION MANUELLE (phase 2) CLOS** (étapes 1-4) : primitive
d'écriture CRS Channex (`ota_name: "Offline"`), verrou anti-surréservation
(`write_locks` + `inventory_units`) et alarme récurrente qui ne s'éteint que par
acquittement manuel, fiche de réservation et formulaire de saisie dans le
calendrier. **Étape 4 validée par le test réel sur Colomiers le 7 septembre
2026** : création, fiche et annulation depuis l'interface, pipeline complet
traversé. Détail, incident stop_sell et règles gravées :
docs/kb/reservation-directe.md.

Bloquants pré-lancement : (a) ~~/settings 404~~ **fait** + onboarding 2 parcours ;
(b) wiring Stripe ; (c) activation features payantes ; (d) user_id dans INSERT serrures.

**Chantier YIELDFLOW 4.5-4.6 LIVRÉ EN PROD.** 4.5 pilote tarifaire par bien
(53c06eb), 4.6.0 fenêtre glissante et trois états d'une nuit (3d2e8f2), 4.6.1
canal interne (e7cd289), 4.6.2 fermetures de l'hôte (95619a5) — une fermeture
se manipule comme une réservation, modifiée à la main par l'hôte seul, jamais
par une app ; rouvrir une nuit couverte est refusé. **4.6.3 à 4.6.5 en prod le
23 septembre 2026 (3897cb0)** : moteur d'ouverture, moteur de prix, pilote
quotidien et alarmes ; écran « Prédiction de prix » (bouton activé /
désactivé confirmé dans les deux sens), CA sur le bandeau et les tuiles.
Recette du 22 septembre en huit pièces, toutes conformes : une nuit ouverte,
pas encore ouverte, fermée ; une fermeture de l'hôte n'est jamais rouverte par
Yield ; seul l'hôte rouvre ; la fenêtre glisse d'une nuit par jour.
**Deux origines de prix, deux traitements** : les prix du calendrier sont
remplacés par les prédictions à l'activation (la confirmation dit « N nuits
ont déjà un prix au calendrier ») ; les prix posés par le ✎ (`prix_hote`) ne
sont jamais touchés, survivent à la désactivation (dette 22) et leur vie se
trace dans `prix_hote_journal`. Règle de saut du moteur, une seule :
`lib/nuits-du-moteur.js`. Migrations `pilote-fenetre`, `prix-hote`,
`prix-hote-journal` appliquées staging et prod. Aucun bien réel n'est encore
activé : lire les deux nombres de la confirmation avant la première
activation. Aussi en prod : UI calendrier et fonctions Vercel en région Paris
(`docs/kb/performance.md`). Restent au registre : dettes 20 (le calendrier dit
« fermée » une nuit pas encore ouverte), 21 (nuit rouverte à la main sans
prix — vérifier sur un bien relié ce que Channex en fait), 24 (agrandir la
fenêtre ne prévient pas), 25 (capacité non calculable : prix posés puis
« aucun prix posé »). Spec : docs/specs/spec-yieldflow-v1.md §2 ter. Dettes :
docs/kb/dettes-v1.md.

Chantier prestataires EN COURS. Lot 3 (assignation par journee) : 3.1 dispos
RRULE, 3.2 `garde.js`, **3.3 le moteur consomme la garde** — `requires_ack`
remplace `rang === 1` partout, proposition posee a l'approche du depart
(7 jours) et notifiee, escalade automatique au refus et a l'expiration en
sautant qui a deja refuse, alerte sur trou de garde seulement. Restent 3.4
(ecran planning de garde) et 3.5 (jours attitres + « Mes disponibilites »).

## DETTE DATEE — 25 TESTS ROUGES PERMANENTS (a solder avant la cloture V1)

**Constat du 13 septembre 2026.** `tests/booking-changes.test.js` (6) et
`tests/booking-changes-dispatch.test.js` (2) echouent depuis la nuit du 12 au
13 septembre.

⚠️ **REPARTITION MISE A JOUR LE 14 SEPTEMBRE 2026 : les 8 sont desormais TOUS
dans `tests/booking-changes.test.js`**, et `booking-changes-dispatch.test.js`
est repasse a 20/20. Le TOTAL n'a pas bouge — la regle de comptage tient — mais
la repartition, elle, a glisse : deux tests de dispatch ont gueri pendant que
deux tests de `booking-changes` franchissaient a leur tour la garde
d'anciennete. C'est le comportement attendu d'une dette a dates FIGEES : elle se
deplace au fil des jours. La noter evite qu'on lise « dispatch est rouge » dans
six semaines et qu'on cherche une panne la ou il n'y en a pas.

**Ce ne sont pas des regressions** : les fixtures portent des
dates FIGEES (sejour du 1er au 5 septembre 2026) et viennent de franchir la
garde d'anciennete `JOURS_DE_GRACE = 7` de `lib/booking-changes.js`. Au-dela,
`sejourTermine()` rend `true` et `detectChange()` rend `null` : les tests
comparent donc `null.type` et levent.

**Pourquoi ca ne peut pas rester.** Huit tests rouges en permanence, c'est une
alarme qu'on apprend a ignorer — et le jour ou un NEUVIEME echec apparait,
personne ne le voit. Une suite de tests ne vaut que si son vert veut dire
quelque chose.

**Comment les corriger** (meme famille que les 6 tests de
`cleaning-sync-menages-entite.test.js`, deja notee ci-dessous) : ces tests
n'injectent PAS `maintenant`, ils lisent l'horloge. Regle du depot : *dates
relatives si le test lit l'horloge, dates figees s'il injecte le temps.* Deux
voies, a trancher a la session dediee — rendre `detectChange` injectable comme
`sejourTermine` l'est deja, ou calculer les fixtures relativement a aujourd'hui.

**Session dediee AVANT la cloture de la V1 YieldFlow.** Ne pas les corriger a la
volee dans un commit de lot : un test a dates figees se repare avec la regle en
tete, pas en decalant les dates d'un mois.

⚠️ **COMPTE ACTUALISE LE 20 SEPTEMBRE 2026 : 21, EN TROIS FAMILLES.**
Le 18 septembre la suite etait a 8 ; le 20, a 21 — sur le MEME commit, sans
qu'une ligne ait change. Les 13 nouveaux ne sont pas des regressions : c'est la
meme maladie des dates figees, sous une autre forme. Contre-epreuve faite par
deux sessions independamment : decaler les fixtures d'un mois les remet TOUS au
vert, sans toucher une ligne de production.

| famille | fichier | rouges | ce qui se declenche |
|---|---|---|---|
| 1 | `tests/booking-changes.test.js` | **8** | garde d'anciennete `JOURS_DE_GRACE = 7` (sejour termine) |
| 2 | `tests/avis-endpoint.test.js` | **3** | fenetre glissante de 30 jours de `api/avis.js` (`periodeNormalisee` → `borneDepuis`) : AVIS_B du 20 aout vient d'en sortir |
| 3 | `tests/messages-classify.test.js` | **10** | meme fenetre : le message du 20 aout est ecarte AVANT la garde de panne DB, donc la garde n'est jamais appelee — elle mord toujours |
| 4 | `tests/menages-public-filtre-presta.test.js` | **4** | fenetre glissante de 14 jours du fil d'actualites (`api/menages-public.js`, « on remonte aussi les 14 derniers jours ») : le menage `b1` du 6 septembre en est sorti le 21 (constate le 21 septembre 2026, contre-epreuve +1 mois : 20/20) |

Les familles 2 et 3 franchissent une FENETRE DE LECTURE, pas une garde
d'anciennete — c'est ce qui les rend penibles : elles se declenchent a des
dates qu'aucun de nous n'a en tete. La regle du depot vaut pour les trois :
*dates relatives si le test lit l'horloge, dates figees s'il injecte le temps.*
**La session dediee pour solder les TROIS familles reste due avant la cloture
V1.** Un chiffre qui bouge tout seul avec le calendrier est un mauvais
garde-fou : l'actualiser n'est qu'un sursis.

**REGLE DE COMPTAGE, POSEE LE 14 SEPTEMBRE 2026 (demande de Thierry).**
Le nombre attendu est **25, et exactement 25** (8 + 3 + 10 + 4, au 21 septembre
2026 — il etait 8 jusqu'au 18, 21 le 20). Avant tout push : lire le compte,
pas la couleur. **26 rouges = une regression, on ne pousse pas** tant qu'on ne
l'a pas nommee ; 24 rouges = une dette s'est refermee, on met ce nombre a jour
ici pour qu'elle reste protegee. Et un compte qui MONTE sur un commit inchange
se contre-eprouve avant d'etre pris pour une regression : decaler les fixtures
d'un mois, relancer, restaurer l'arbre — si tout repasse au vert, c'est le
calendrier, et on l'ajoute au tableau ci-dessus avec sa cause. C'est la meme discipline que le `ATTENDU` de
`tests/bookings-snapshot-troncature.test.js` : une exemption se COMPTE, elle ne
se decrit pas.

Vecu le jour meme : le correctif de la garde des cles migrees a fait passer la
suite a 9 rouges. Le neuvieme etait une vraie rechute — une lecture de
`bookings_snapshot` ajoutee sans borne dans un script neuf, donc tronquee a
1000 lignes sans erreur. Sans le comptage, elle se serait noyee dans « les 8
rouges habituels ».

Prochain chantier (court, avant la phase 3) : **audit stop_sell** —
docs/specs/spec-audit-stop-sell.md. Principe grave : le coeur memorise
l'INTENTION commerciale de l'hote par jour et par bien, toute poussee
d'inventaire la restitue, seul un geste volontaire de l'hote la met a jour ;
le stop_sell est une decision MEMORISEE, le stock une consequence CALCULEE.
La memoire est `calendar_inventory` (writer unique : api/calendar.js POST) mais
elle est vide d'intention (0 ligne stop_sell=true, 1 bien sur 4) — la rendre
vraie est l'etape 0. Inclut le fix des 6 tests a dates figees de
tests/cleaning-sync-menages-entite.test.js.

Ensuite : prestataires (fiche + convergence des deux populations +
les 5 dettes du §12). La fiche prestataire consommera `ota_reviews` : décision
déjà gravée dans docs/specs/spec-prestataires-menage.md §6 — l'extrait de
propreté est montré à la prestataire, mais l'extrait SEUL, jamais le nom du
voyageur, étiqueté « retour privé » quand il en vient, et coupé par
`self_view_reviews`.

## DOC REPO — LIRE AVANT DE CODER
- docs/CALENDRIER_TECH.md (calendrier) | docs/CHANNEL_TECH.md (Channex) | pages/guide.html (guide user, alimenter à chaque feature).
- docs/kb/coeur-de-donnees.md (règle d'architecture : provider → cœur → apps ; config d'app vs config générale).
- docs/kb/dettes-v1.md (REGISTRE des dettes datées avant la clôture V1 : 25 rouges, migrations à appliquer, vacances 2027, mobile et fermetures — chaque lot lit sa ligne avant merge).
- docs/kb/profils-et-droits.md (droits, délégation, dettes) | docs/kb/audit-user-id-front.md (identité vs compte, endpoints délégables).
- docs/kb/prix-plancher.md (garde anti nuit a 0 : `properties.prix_minimum` par bien, repli 10 € ; on FERME la date, on ne remonte jamais le prix ; `rate: 0` n'est pas applique par Channex, il garde le prix de la grille).
- docs/kb/evenements-yield.md (vacances scolaires importees/cachees par zone ; jours feries CALCULES, aucune table ; OpenAgenda ecarte de la V1, sur mesure).
- docs/kb/indicateurs-yield.md (LA SOURCE DE VERITE EST LE COEUR, jamais Excel ; « calculable » n'est pas « divisible » ; convention capacite ESTIMEE pour le passe, drapeau dans la donnee).
- docs/kb/eclatement-yield.md (socle du moteur : prix voyageur par provider/canal, repartition UNIFORME — le differentiel week-end vit dans price_display_log, pas dans l'eclatement ; pont demapped ; nuits en exception MARQUEES).
- docs/kb/capacite-yield.md (denominateur du TO : jour ouvert = intention memorisee ; absence de ligne = ferme ; « non calculable » n'est JAMAIS zero).
- docs/kb/price-log.md (journal des prix affiches : NON RETROACTIF, une ligne par changement REEL, une seule ligne courante par bien/nuit ; cle sur properties.id, exception raisonnee a la regle 10).
- docs/kb/suggestion-yield.md (`null` n'est jamais une reponse, et « je ne sais pas » n'est pas « non » — deux motifs distincts ; la grille 5 niveaux est faite de quantiles des prix REELLEMENT obtenus ; le jour de semaine est une COUCHE finale, pas un axe ; tester l'INVARIANT plutot que la ligne).
- docs/kb/restitution-yield.md (l'ecran : un `null` s'affiche « non calculable » AVEC son motif, jamais 0 ni tiret ; les 41 motifs traduits, liste DERIVEE du moteur et non recopiee ; un drapeau systematique passe en legende, pas sur chaque ligne).
- docs/kb/pickup-yield.md (le « a date » : pivot N-1 en JOURS pour une periode a venir, meme jour calendaire pour une periode commencee ; le N-1 est RECONSTRUIT donc sous-estime ; « ferme a la vente » n'est pas « n'a rien vendu », des DEUX cotes).
- docs/kb/reference-yield.md (un jour = UN segment par priorite ; cascade de repli a 4 niveaux, plancher = jour de semaine ; deux seuils, 8 nuits ET 3 resas ; `part_vendue` est une part de VENTES, on extrapole le final, on ne multiplie jamais la capacite).
- docs/kb/prix-voyageur.md (QUEL champ = prix paye par le voyageur : `amount` Channex/Airbnb est un NET HOTE (ecart +22,85 %), reconstruire via `meta.amount_type` — jamais via le nom du canal ; dates de vente : comparer les JOURS, pas les instants).
- docs/kb/avis-voyageurs.md (ota_reviews : clé Channex unique = cloisonnement par properties, dette 11/70 levée par l'historique des réservations ; classification propreté en 2 étages, règle avant IA).

## VALIDATION
- `node -c fichier.js` valide la syntaxe CommonJS avant commit.
- **Lignes SQL courtes : seulement pour le collage manuel.** Du SQL collé à la
  main dans l'éditeur Supabase se coupe en lignes < 60 caractères (trois échecs
  de troncature). Une migration versionnée de `migrations/`, appliquée par
  outillage, est en **format libre** : la contrainte ne la concerne pas.
  Origine de la règle : docs/specs/spec-yieldflow-v1.md §470.
- Après push : attendre que le Deployment ID Vercel change avant de tester le cron prod.
