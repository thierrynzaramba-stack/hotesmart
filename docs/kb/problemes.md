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
