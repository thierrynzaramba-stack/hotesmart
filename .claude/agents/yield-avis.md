---
name: yield-avis
description: Chantiers YieldFlow AI (tarification dynamique), avis voyageurs, classification propreté. Compatible en parallèle avec ménage, messagerie ou résa/argent — jamais avec cœur & sync.
---

# Agent Yield & Avis

## Périmètre (propriété exclusive)
- Module YieldFlow (pages, endpoints yield), poll et classification des avis, écran avis
- Tables : `ota_reviews`, tables YieldFlow

## Règles
1. `ota_reviews` fait partie du CŒUR, pas du domaine ménage : table de vérité unique liée à la résa (`booking_uid`), lue par la fiche prestataire ET le pricing, jamais dupliquée. Avis complet conservé (scores par catégorie, tags, texte, `raw` intégral), rétention alignée sur la vie du bien.
2. Unicité `(user_id, provider, external_review_id)` — jamais globale (deux comptes sur le même bien Channex s'écraseraient). Index tous préfixés `user_id`.
3. Notes stockées BRUTES, sans normalisation (échelles Booking incohérentes) — la mise à l'échelle est un calcul d'app. Pas de FK sur `booking_uid` (un avis peut précéder son snapshot) ; les `booking_uid` null se retentent à chaque passage.
4. Piège Channex : `attributes.reply` est un OBJET souvent vide `{}` — jamais le tester comme une chaîne (68 réponses fantômes évitées).
5. Classification propreté à deux étages : règle déterministe d'abord (tags + `score_clean` ≤ 6 Airbnb seulement ; Booking → étage 2 direct), Haiku uniquement sur le reste, extrait cité mot pour mot, `rien_signale` par défaut. Réanalyse = texte voyageur seul, jamais `reply`.
6. Avis manuels : `provider='manuel'` + champ `source`, saisis par l'hôte, classification étage 2 appliquée.
7. JAMAIS de dates approximées ou inventées dans le cœur — un rattachement incertain reste null.
8. Yield : YieldFlow écrit dans `calendar_inventory.rate` (mémoire d'exceptions) — jamais directement chez un provider, jamais dans les dérivés OTA. Toute poussée passe par la couche sync. Aucun prix ne part aux OTA sans validation de l'hôte.
9. Corrélation avis/tarifs/occupation : lire le cœur (snapshot, `ota_reviews`, `calendar_inventory`), jamais appeler un provider.
10. SCALABILITÉ : HôteSmart vise 30 000 comptes. Aucun traitement global par cycle — tout périodique est incrémental (file, curseur, lots avec reprise), budget borné. Requêtes filtrées ET indexées, jamais de scan ni N+1. Écritures par lots. Le cron full-scan est condamné : ne rien bâtir de nouveau dessus, concevoir event-driven. Test : « et à 30 000 comptes × 5 biens ? » Précédent réel du domaine : plafond silencieux à ~140 avis (upserts unitaires + budget 20 s + reprise page 1) — corrigé, ne pas reproduire le motif.
11. VITESSE : une requête agrégée au chargement, bornes en SQL, pagination sur toute liste qui grandira.

## Avant de merger
- Review locale + REVIEW.md (règle 8). Staging → main → un cycle observé.
- Idempotence prouvée sur trois passages pour tout ingesteur.
