# Recette — information manquante, étape 1 (staging)

Branche `info-manquante-etape-1`, fusionnée dans `staging` par le chef de
file (`bbc2da741116954aeabcae640a0e268f091b9e71`). Recette menée dans le Chrome
de Thierry, Thierry présent (lot d'envoi au voyageur).

## Passe 1 — 12 novembre 2026, 22:48

Décor : une tâche `info_unknown` (`pending`, deux questions : chien, moto)
posée à la main par Thierry dans l'éditeur SQL de staging, sur la
conversation `STG-RECETTE-GARDE-1` (logement `STG-BIEN-3`, « Loft
Pilotable »). Marque : `summary = 'RECETTE chien et moto'`.

| Pièce | Résultat |
|---|---|
| La carte apparaît en fin de fil, deux lignes Oui / Non / Autre | conforme |
| Logement en pause : la carte le dit, « Rédiger » inactif | conforme |
| Pause levée (sur accord de Thierry, « Laisser partir » ; staging : ni cron ni clé d'envoi) : la carte repasse en mode normal | conforme |
| « Rédiger » inactif tant qu'une question n'a pas de choix ; « Autre » ouvre la précision ; actif ensuite | conforme |
| « Rédiger la réponse » : le texte arrive dans la saisie, rien ne part, note « relisez-la, puis envoyez » | conforme |
| **Contenu du texte rédigé** | **NON CONFORME** — voir ci-dessous |
| Bouton « IA » visible dès qu'un texte est tapé ; texte remplacé par une version fidèle au brouillon, sans ajout | conforme |
| « Annuler » rend le brouillon d'origine, puis disparaît | conforme |

**Le défaut.** Choix : chien OUI, moto AUTRE (« non dans l'appartement, mais
garage fermé à 200 m »). Texte rédigé : une réponse à la question d'ENTRÉE
du voyageur (« comment entre-t-on dans le logement demain ? »), avec le CODE
DE LA PORTE et un horaire tirés de la base de connaissance — et ni le chien ni
la moto. Le décor y aide (le voyageur de test n'a jamais parlé de chien ni de
moto), mais une réponse qui ajoute un code d'accès que personne n'a demandé
est le défaut qui finit par partir. Rien n'est parti : le texte était dans la
saisie.

**Correctif (sur la branche du lot, règle 8).** Décision de Thierry : « les
choix, plus la conversation ». Le modèle ne reçoit plus la base de
connaissance ; le texte du modèle place les décisions (ou le brouillon) en
tête comme SEUL contenu, interdit tout autre sujet et toute information non
écrite par l'hôte, et réduit la conversation à la demande, la langue, le
prénom et le ton. Les consignes de l'hôte ne servent plus qu'au ton et à la
signature.

À rejouer après le nouveau passage de la branche sur staging : le même décor,
les mêmes choix.

Non éprouvé sur staging, et c'est attendu : l'envoi réel et la clôture
`info_traitee` (Channex staging refuse les réservations de test) — en
production, Thierry présent.
