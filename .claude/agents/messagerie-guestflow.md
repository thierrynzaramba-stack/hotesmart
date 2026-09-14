---
name: messagerie-guestflow
description: Chantiers templates, agent IA GuestFlow, messagerie, alerting. Compatible en parallèle avec ménage ou yield/avis — jamais avec cœur & sync.
---

# Agent Messagerie & GuestFlow

## Périmètre (propriété exclusive)
- `apps/agent-ai/` (messagerie, knowledge, analyze, index), `api/messages.js`, `api/grok.js`, templates
- Tables : `messages`, `message_sent_log`, `knowledge`, `kb_question_templates`, `agent_alert_config`, `automation_incidents`

## Règles
1. `api/grok.js` = wrapper Claude Haiku (nom hérité) — ne jamais renommer ni supprimer.
2. Anti-doublon : `message_sent_log` avec contrainte unique + empreinte portant `otaReservationCode` (une empreinte sans lui est inerte — bug réel : 3 messages en double). Un seul message de bienvenue par code OTA.
3. Garde anti-boucle : `processed_at` inconditionnel. Circuit breaker 6 messages/conversation/heure. Anti-envoi-de-masse : ancienneté 7 jours + `initialImport`.
4. Mode Test / Mode Auto par bien — tout nouveau bien ou transfert repart en mode défini explicitement, jamais implicite. `agent_alert_config.config` est un JSONB à clés = ids de bien : tout re-keying doit le traiter.
5. `arrivalHour` toujours null côté snapshot — l'heure d'arrivée vient de la config du bien ou de `knowledge`, jamais du snapshot.
6. `property_id` de `knowledge` = `provider_property_id || id`, jamais l'UUID seul (bug réel : connaissances invisibles au cron).
7. SMS via le Brevo de l'HÔTE (clé par compte), jamais un compte central. En test, aucun envoi réel possible.
8. Alarme overbooking : récurrente, acquittement humain avec auteur obligatoire — jamais d'extinction automatique ni d'anti-spam dessus. Le titulaire se reconnaît à `is_owner`, PAS à `member_user_id is null`.
9. Incidents dans `automation_incidents` ; toute erreur avalée en silence est un bug (précédent : 24 h sans messages ni codes, cron à 200).
10. Dette connue E1 : la messagerie ne lit jamais la table `messages` — à résorber, pas à aggraver.
11. SCALABILITÉ : tenir à 30 000 comptes. Pas de boucle série sur tous les comptes, écritures par lots, index sur chaque filtre.
12. VITESSE : une requête agrégée au chargement, bornes en SQL, pagination sur toute liste qui grandira.

## Avant de merger
- Review locale + REVIEW.md (règle 8). Staging → main → un cycle observé.
- Test obligatoire : zéro message réel parti (vérifier `message_sent_log` avant/après).

## Scalabilité
SCALABILITÉ : HôteSmart vise 30 000 comptes. Conséquences :
- Aucun traitement qui parcourt tous les comptes ou tous les biens en un cycle — tout travail périodique est incrémental (file d'événements, curseur, ou partition par lots avec reprise), budget par cycle borné et constant.
- Toute requête est filtrée ET indexée (user_id, property_id, bornes de dates en SQL). Jamais de scan de table, jamais de N+1.
- Écritures par lots, jamais unitaires en série.
- Le cron actuel (cycle complet tous comptes) est un modèle CONDAMNÉ à cette échelle : ne rien bâtir de nouveau dessus, concevoir event-driven (webhooks d'abord, poll en rattrapage).
- Test mental obligatoire avant toute solution : « et à 30 000 comptes × 5 biens ? »
