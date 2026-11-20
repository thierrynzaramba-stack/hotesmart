# Labo IA — comparer plusieurs IA (fondateur seul)

Chantier du 20 novembre 2026, demandé par Thierry : « une page qui permet de
poser une question et d'avoir la réponse de 5 IA en web service, et de comparer
le coût en tokens » (avec le bien choisi, pour la base de connaissance et la
conversation), et « une autre page qui permet de charger une facture et de
comparer la lecture et la retranscription ». Le même jour : les modèles chinois
aussi, et « on va tester sur plus de modèles » — la comparaison n'est donc pas
limitée à 5.

## Où

- Page : `/pages/labo-ia` (deux onglets : Question, Facture). Outil interne,
  comme le Diagnostic : hors de la navigation des hôtes, en français seul.
- Endpoint : `api/labo-ia.js` (`maxDuration` 120 s dans `vercel.json`).
- Règles pures : `lib/labo-ia.js`. Client : `lib/ia/openrouter.js`.
- Tests : `tests/labo-ia.test.js`.

## Décisions

| Sujet | Décision | Source |
|---|---|---|
| Fournisseur | **OpenRouter** : une seule clé, tous les modèles (Claude, GPT, Gemini, Mistral, DeepSeek, Qwen, Kimi, GLM…). Frais d'environ 5,5 % à l'achat de crédits. | Thierry, 20 nov. (« permet de faire le comparatif rapidement ») |
| Nombre d'IA | Liste à cocher sur tout le catalogue (plus de 400 modèles), sélection gardée dans le navigateur ; sélection de départ = le modèle le plus récent de 9 familles. | Thierry : « plus de modèles » |
| Accès | **Fondateur seul**, sur son compte propre. | Hypothèse annoncée, non contestée |
| Contexte d'une question | Base de connaissance du bien (celle que lit l'agent : « Hors IA » exclu, replis de la fiche compris) + consignes de l'hôte + une conversation voyageur au choix (30 derniers messages). | Hypothèse annoncée, non contestée |
| Facture | Banc d'essai pur : **rien n'est enregistré** dans Charges. Même consigne que la lecture du compte de charges (`CONSIGNE` de `lib/charges/lecture.js`), même normalisation. | Hypothèse annoncée, non contestée |
| Données des voyageurs | `data_collection: 'deny'` sur chaque appel, et le compte OpenRouter refuse aussi les hébergeurs qui entraînent sur les données (réglage Privacy fait le 20 nov.). Hébergeurs chinois exclus au premier essai ; s'il n'y en a pas d'autre, relance sans l'exclusion, **signalée à l'écran**. | Hypothèse annoncée, non contestée |

## Ce qui garde

- **La porte** : `requirePermission({ domaine: 'titulaire' })` sans ressource
  (un compte basculé est refusé) puis e-mail = `FOUNDER_EMAIL`, comme la carte
  « Coût du cron » du Diagnostic. Refus AVANT toute lecture et tout appel.
- **Le cloisonnement** : bien résolu en base sur le compte de l'appelant
  (règle 11) ; `knowledge`, `messages`, `agent_prompting` lus sur la
  RÉFÉRENCE PROVIDER (règle 10) ; un séjour d'un autre bien donne 404.
- **La clé** : `OPENROUTER_API_KEY` (Vercel, « Sensitive »), lue à chaque
  appel, envoyée seulement à `https://openrouter.ai/api/v1` (constante) ;
  toute erreur passe par `extrait` (masque `sk-…`).
- **Le coût** : chaque tentative écrit sa ligne dans `ia_appels` (fonctions
  `labo-ia-question` et `labo-ia-facture`), avec le coût FACTURÉ par OpenRouter
  (`usage.cost`), jamais le texte. Plafond du labo : 400 appels par 24 h
  (compte illisible = pas d'appel). La vraie limite est le plafond de la clé
  OpenRouter (10 $ à la création).
- **Rien n'est écrit dans le produit** et rien ne part à un voyageur : la seule
  écriture est le journal.

## Comment ça marche

- Un appel = un modèle. La page lance les modèles cinq par cinq et affiche
  chaque réponse à son arrivée : une fonction qui attendrait le plus lent de
  quinze modèles buterait sur son mur de durée.
- Avant l'envoi, la page donne un **coût estimé** (≈ 3,5 caractères par token,
  réponse de 400 tokens, 2 000 au plus) ; après, le **coût réel**.
- Facture : PDF, JPEG ou PNG, 3 Mo au plus (le corps d'une fonction Vercel est
  borné à 4,5 Mo, et le fichier voyage en base64). Le type se lit dans les
  octets. Un PDF est donné au modèle s'il sait le lire, sinon OpenRouter passe
  par son OCR (Mistral OCR, facturé dans le coût). Une image ne part qu'aux
  modèles qui voient les images. Le HEIC n'est pas pris ici (Charges le
  convertit ; le labo ne le fait pas).
- Comparaison des factures : un tableau champ par champ ; une case qui diffère
  de la valeur majoritaire est surlignée.

## Limites connues

- La liste des hébergeurs chinois (`HEBERGEURS_CHINE`, `NOMS_CHINE`) est tenue
  à la main : la page affiche toujours le nom de l'hébergeur qui a servi, donc
  un oubli se voit.
- L'estimation avant envoi est un ordre de grandeur (tokenisation différente
  d'un modèle à l'autre, images et PDF estimés grossièrement).
