# KB — Problèmes connus & réponses (FAQ support)

<!-- TRANSVERSAL : agrège des symptômes couvrant plusieurs modules. Les détails vivent dans les kb
     de chaque thème ci-dessous ; mettre à jour ce fichier quand une nouvelle cause récurrente
     apparaît. Sources indirectes : voir connexion.md / guestflow.md / codes-acces.md / menage.md /
     tarifs.md et leurs fichiers de code. -->

| Symptôme (hôte) | Réponse |
|---|---|
| « Mon bien est créé mais ne reçoit ni résa ni message » | Le bien est provisionné mais **pas encore relié à l'annonce**. Aller dans **Mes biens → Connexions** et connecter Airbnb/Booking. En beta, la finalisation peut prendre **24-48h** (concierge). |
| « Booking me demande d'autoriser un fournisseur » | Normal : extranet Booking → *Compte → Fournisseur de connectivité* → autoriser notre partenaire technique → revenir. |
| « Booking a fermé mes dates pendant la connexion » | Comportement normal de Booking ; les dates sont **rouvertes automatiquement** à l'activation. |
| « Je veux un séjour minimum / prix différent Airbnb vs Booking » | Réglable **par canal** dans **Mes biens → Connexions**. |
| « L'IA a répondu quelque chose de faux » | L'IA répond **uniquement** depuis la base de connaissances du bien. Compléter/corriger la base ; en cas de doute, passer le bien en **mode validation**. |
| « Je veux que l'IA arrête de répondre sur ce bien » | **Couper l'IA** sur `/biens` (kill switch) : plus de réponses auto **et plus de codes créés** ; réception + synchro continuent, le code déjà posé reste valable. |
| « Mon bien s'est mis en pause tout seul » | **Coupe-circuit automatique** : une conversation a bouclé (volume anormal). L'hôte a reçu un email. Lire la messagerie, puis **réactiver en un clic** (`/biens`). Voir `alertes.md`. |
| « Je ne reçois pas les emails d'alerte » | Vérifier les **spams** et l'**adresse** dans la config GuestFlow (email = canal par défaut, activé automatiquement). |
| « Je ne reçois pas les SMS » | Le SMS est **optionnel** : vérifier la **clé Brevo dans `/connexions`**, l'**option SMS activée**, et le bouton **Tester**. Aucun SMS n'est facturé par HôteSmart. |
| « Le code d'accès n'est pas parti » | Si un **suivi ménage** existe sur le bien, le code n'est envoyé qu'**après validation du ménage** (sauf 1er voyageur) : vérifier que le ménage est marqué fait. Vérifier aussi que l'**IA n'est pas coupée / le bien pas en pause**. (Sans suivi ménage, le code part sans attendre.) |
| « Le code ne se crée pas sur ma serrure » | Vérifier : la **serrure est bien associée au bien** (Agent IA → Messages), la **clé Seam est valide et non expirée** (Serrures → Configuration, bouton Tester), et que l'**IA n'est pas coupée / le bien pas en pause**. Si tout semble correct, **contactez-nous**. |
| « Je n'ai pas fini l'onboarding » | L'onboarding **n'est pas obligatoire** : l'app est accessible, un bandeau invite à reprendre là où on s'est arrêté. |
| « Vais-je être débité ? » | **Essai gratuit 15 jours sans carte bancaire.** Ne jamais affirmer un débit (Stripe en test). Voir `tarifs.md`. |

## ⚠️ À VÉRIFIER
- Compléter au fil des retours beta : ajouter chaque cause récurrente + sa réponse validée.

## Des dates sont fermées sur Booking/Airbnb alors que je ne les ai pas fermées

**Depuis le 8 septembre 2026**, une date sans aucun prix part **fermée à la vente** vers les
plateformes. C'est voulu : le staging Channex a montré qu'une date poussée sans prix reste
vendable **au prix par défaut du plan tarifaire** — donc à un prix que l'hôte n'a pas choisi.
Entre fermer une date et la vendre au mauvais prix, on ferme.

**Comment le reconnaître** : l'hôte n'a rien fermé dans son calendrier HôteSmart, et les dates
concernées n'ont pas de prix. Le journal de synchronisation le dit :
`[fullsync] bien <id> : N/500 dates fermees faute de prix`.

**Comment le corriger** : saisir un prix (par date, ou un prix de base pour le logement). La
date **rouvre d'elle-même** à la poussée suivante — rien à rouvrir à la main. La mémoire
d'intention de l'hôte n'a jamais été touchée.

**Si beaucoup de dates sont concernées** (seuil : 30 sur 500), une alerte fondateur part
automatiquement — c'est le signe d'un amorçage de prix qui a échoué, pas d'un choix.

⚠ **Dette UI connue** : dans le calendrier HôteSmart, ces dates ne se distinguent pas encore de
celles que l'hôte a fermées lui-même. À traiter au chantier UI.
