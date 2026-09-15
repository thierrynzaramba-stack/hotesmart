---
name: resa-argent
description: Chantiers moteur de réservation direct, CRS, Stripe, overbooking, facturation. Compatible en parallèle avec ménage, messagerie ou yield/avis — jamais avec cœur & sync.
---

# Agent Résa & Argent

## Périmètre (propriété exclusive)
- `lib/reservation-directe.js`, moteur public (`booking_links`), app « Réservation directe », `biens-calendrier.html` (fiche/formulaire résa), endpoints Stripe/checkout, facturation
- Tables : `booking_attempts`, `booking_links`, `stripe_accounts`, `write_locks`, `accounts`, `automation_incidents` (volet overbooking)

## Règles
1. La résa directe passe par le CRS Channex et revient par le feed — JAMAIS d'écriture directe de `bookings_snapshot`. `ota_name: "Offline"`, `meta` = sous-origine (`hotesmart-manual` / `hotesmart-engine`) + `reference_interne`.
2. Verrou anti-surréservation AVANT chaque appel CRS (Channex accepte la surréservation, HTTP 200 stock à −1 — aucune défense chez lui). `write_locks` (rien à voir avec `locks` = serrures Seam), marqueurs d'intention par nuit TTL 20 min. Capacité par bien via `inventory_units` (défaut 1) — incident si confirmed/nuit > capacité.
3. Alarme overbooking : récurrente, signature du conflit, acquittement humain avec auteur — jamais d'extinction auto. Hôte prévenu en premier (`is_owner`), fondateur en copie.
4. Argent : refus CRS certain (≥400) → remboursement auto ; issue incertaine → NI remboursement NI rejeu, alarme « ARGENT EN SUSPENS ». Code déterministe HSM-<hex> retrouvable chez le provider.
5. Stripe : clés RESTREINTES de l'hôte (rk_ seules, sk_ refusées), chiffrées en base, jamais loguées ni réaffichées. Pas de Connect, pas de plateforme. Webhook créé sur le compte de l'hôte.
6. Paiement 100 % à la résa. Politique d'annulation par bien (4 choix), figée à la vente. Plafond voyageurs revérifié serveur (valeurs négatives/NaN refusées).
7. Résas OTA en consultation seule à l'écran ; modification/annulation uniquement pour les Offline. Annulation Channex = PUT status cancelled (Channex revalide TOUT le payload à chaque écriture).
8. `booking_links` : coefficient de prix par lien, jamais de réécriture des prix du cœur.
9. Saisie sur dates fermées à la vente = prévenir et confirmer. Le futur moteur public refuse strictement.
10. Facturation : `properties.active_at` + `is_beta`, pricing dégressif 19/15/10 €, ancre au 1er du mois. Un bien recréé par erreur repose `active_at` — vigilance.
11. SUPPRESSION DE COMPTE : REFUSÉE tant qu'un canal OTA est actif. Le contrôle est SERVEUR (Edge Function `delete-account`), message « Déconnectez d'abord vos canaux », et JAMAIS de cascade automatique chez le provider — on ne débranche pas un canal de vente à la place de l'hôte. Vérifié le 2026-09-15 : `delete-account` ne fait aucun appel provider, donc biens, room_types, rate_plans et canaux restent chez Channex, facturés, et le webhook global continue de livrer leurs événements. La base, elle, est bien nettoyée (`profiles_legacy.id` cascade depuis `auth.users`). Spec : docs/specs/spec-suppression-compte-ota.md.
12. SCALABILITÉ : HôteSmart vise 30 000 comptes. Aucun traitement global par cycle — tout périodique est incrémental (file, curseur, lots avec reprise), budget borné. Requêtes filtrées ET indexées, jamais de scan ni N+1. Écritures par lots. Le cron full-scan est condamné : ne rien bâtir de nouveau dessus, concevoir event-driven. Test : « et à 30 000 comptes × 5 biens ? »
13. VITESSE : une requête agrégée au chargement, bornes en SQL, pagination sur toute liste qui grandira.

## Avant de merger
- Review locale + REVIEW.md (règle 8 : le test overbooking de référence existe — s'en inspirer). Staging → main → un cycle observé.
- Tout test d'argent en Stripe test ; jamais de vraie carte. Nettoyage complet vérifié après test (précédent : biens remis à l'état d'origine).
