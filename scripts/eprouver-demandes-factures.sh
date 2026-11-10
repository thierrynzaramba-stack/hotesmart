#!/bin/bash
# scripts/eprouver-demandes-factures.sh — épreuve des tables et fonctions de
# migrations/2026-11-10-factures-voyageur-demandes.sql sur un VRAI Postgres.
#
# Pourquoi : les tests de la suite ne lisent que le TEXTE du SQL et simulent
# la base. Ce script applique la migration (deux fois : elle doit se rejouer)
# et joue un geste par règle : chacun doit passer ou être refusé.
#
# ⚠ AUCUNE BASE EXISTANTE N'EST TOUCHÉE : le script crée son propre cluster
# Postgres dans un dossier temporaire (socket local, aucun port TCP ouvert), et
# le détruit à la fin. Il faut les binaires Postgres (initdb, pg_ctl, psql).
#
# Usage : bash scripts/eprouver-demandes-factures.sh   → code 0 si 0 écart.
set -u
RACINE="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATION="$RACINE/migrations/2026-11-10-factures-voyageur-demandes.sql"
BIN="$(dirname "$(command -v initdb 2>/dev/null || ls /usr/lib/postgresql/*/bin/initdb 2>/dev/null | tail -1)")"
[ -x "$BIN/initdb" ] || { echo "initdb introuvable : installer Postgres pour cette épreuve"; exit 2; }

DIR="$(mktemp -d)"
PORT=5498
moi () { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/sh -c "$*"; else sh -c "$*"; fi; }
[ "$(id -u)" = 0 ] && chown postgres "$DIR"
nettoyer () { moi "'$BIN/pg_ctl' -D '$DIR/data' stop -m fast" >/dev/null 2>&1; rm -rf "$DIR"; }
trap nettoyer EXIT

moi "'$BIN/initdb' -D '$DIR/data' -A trust -U postgres" >/dev/null || exit 2
moi "'$BIN/pg_ctl' -D '$DIR/data' -o \"-p $PORT -k $DIR -c listen_addresses=''\" -l '$DIR/pg.log' -w start" >/dev/null || exit 2

P="$BIN/psql -h $DIR -p $PORT -U postgres -d postgres -v ON_ERROR_STOP=1 -qtA"
# Le socle que Supabase fournit : les rôles, et SES DROITS PAR DÉFAUT — tout
# objet neuf de `public` est accordé à anon, authenticated et service_role.
# Sans eux, les refus du navigateur passeraient pour une raison qui n'est pas
# la bonne (rien n'aurait été accordé) : c'est le REVOKE qui doit les produire.
$P >/dev/null <<'SQL' || exit 2
create role anon; create role authenticated;
create role service_role bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;
SQL
$P -f "$MIGRATION" >/dev/null 2>&1 || { echo "la migration ne s'applique pas"; $P -f "$MIGRATION" 2>&1 | tail -3; exit 1; }
$P -f "$MIGRATION" >/dev/null 2>&1 || { echo "la migration ne se rejoue pas"; exit 1; }

A=11111111-1111-4111-8111-111111111111
B=22222222-2222-4222-8222-222222222222
BIEN=bbbbbbbb-0000-4000-8000-000000000001
H1=$(printf 'a%.0s' $(seq 64)); H2=$(printf 'b%.0s' $(seq 64)); H3=$(printf 'c%.0s' $(seq 64))
H4=$(printf 'd%.0s' $(seq 64)); H5=$(printf 'e%.0s' $(seq 64))
F=public.factures_voyageur
J=public.factures_voyageur_jetons
LIEN () { echo "select r_creee from fv_nouveau_lien('$A', '$BIEN', '$1', 'fr', '$A', '$2', '$3', now() + interval '1 year')"; }
ok=0; ko=0
essai () { # libellé, attendu (passe|refus), sql
  if out=$($P -c "$3" 2>&1); then r=passe; else r=refus; fi
  if [ "$r" = "$2" ]; then ok=$((ok + 1)); s="  ok "; else ko=$((ko + 1)); s="ECART"; fi
  echo "$s | attendu $2, obtenu $r | $1"
}
vaut () { # libellé, valeur attendue, sql
  out=$($P -c "$3" 2>&1)
  if [ "$out" = "$2" ]; then ok=$((ok + 1)); s="  ok "; else ko=$((ko + 1)); s="ECART"; fi
  echo "$s | attendu « $2 », obtenu « $out » | $1"
}
DEM="(select id from $F where booking_id = 'R1' and statut <> 'sans_objet')"
JET1="(select id from $J where jeton_hash = '$H1')"
DEST="'{\"type\":\"societe\",\"nom\":\"SCI X\",\"siren\":\"123456789\"}'::jsonb"

vaut "1. un premier lien crée la demande" t "$(LIEN R1 $H1 fiche)"
vaut "2. statut de départ : lien envoyé" lien_envoye "select statut from $F where booking_id = 'R1'"
essai "3. même porte dans les 30 s : refusé (double clic)" refus "$(LIEN R1 $H2 fiche)"
vaut "4. autre porte : la MÊME demande, pas de seconde" f "$(LIEN R1 $H2 balise)"
vaut "5. une seule demande, deux jetons" "1|2" "select (select count(*) from $F where booking_id = 'R1'), (select count(*) from $J)"
essai "6. une seconde demande active à la main : refusée" refus "insert into $F (user_id, property_uuid, booking_id) values ('$A', '$BIEN', 'R1')"
vaut "7. le voyageur remplit par son jeton" ok "select fv_enregistrer_destinataire($DEM, '$A', $JET1, $DEST, 'voyageur', null, 2)"
vaut "8. statut : formulaire rempli" "formulaire_rempli|SCI X|voyageur" "select statut, dest_nom, saisi_par from $F where booking_id = 'R1'"
vaut "9. le voyageur corrige (2e envoi, plafond 2)" ok "select fv_enregistrer_destinataire($DEM, '$A', $JET1, $DEST, 'voyageur', null, 2)"
vaut "10. 3e envoi au-delà du plafond : refusé" plafond "select fv_enregistrer_destinataire($DEM, '$A', $JET1, $DEST, 'voyageur', null, 2)"
$P -c "update $J set expire_le = now() - interval '1 second' where jeton_hash = '$H2'" >/dev/null
vaut "11. jeton expiré : refusé" plafond "select fv_enregistrer_destinataire($DEM, '$A', (select id from $J where jeton_hash = '$H2'), $DEST, 'voyageur', null, 20)"
vaut "12. jeton d'une autre demande : refusé" plafond "select fv_enregistrer_destinataire($DEM, '$A', gen_random_uuid(), $DEST, 'voyageur', null, 20)"
vaut "13. l'hôte remplit à la place (sans jeton)" ok "select fv_enregistrer_destinataire($DEM, '$A', null, $DEST, 'hote', '$A', 20)"
vaut "14. un autre compte ne trouve pas la demande" introuvable "select fv_enregistrer_destinataire($DEM, '$B', null, $DEST, 'hote', '$B', 20)"
essai "15. SIREN qui n'a pas 9 chiffres : refusé" refus "select fv_enregistrer_destinataire($DEM, '$A', null, '{\"siren\":\"12AB\"}'::jsonb, 'hote', '$A', 20)"
essai "16. nom de 201 caractères : refusé" refus "select fv_enregistrer_destinataire($DEM, '$A', null, jsonb_build_object('nom', repeat('x', 201)), 'hote', '$A', 20)"
essai "17. changer la réservation d'une demande : refusé" refus "update $F set booking_id = 'R9' where booking_id = 'R1'"
essai "18. émettre (simulé) : passe" passe "update $F set statut = 'emise' where booking_id = 'R1'"
vaut "19. formulaire après émission : verrouillé" verrouillee "select fv_enregistrer_destinataire($DEM, '$A', null, $DEST, 'hote', '$A', 20)"
essai "20. destinataire d'une facture émise modifié à la main : refusé" refus "update $F set dest_nom = 'Autre' where booking_id = 'R1'"
essai "21. facture émise ramenée à « lien envoyé » : refusé" refus "update $F set statut = 'lien_envoye' where booking_id = 'R1'"
essai "22. supprimer une facture émise : refusé" refus "delete from $F where booking_id = 'R1'"
essai "23. un lien vers une facture émise : passe (même demande)" passe "$(LIEN R1 $H3 disponible)"
vaut "24. une réservation annulée : nouvelle demande possible" t "select r_creee from fv_ouvrir_demande('$A', '$BIEN', 'R2', 'en', null)"
$P -c "update $F set statut = 'sans_objet' where booking_id = 'R2'" >/dev/null
essai "25. une demande sans objet ne revit pas" refus "update $F set statut = 'lien_envoye' where booking_id = 'R2'"
vaut "26. après « sans objet », une nouvelle demande naît" t "select r_creee from fv_ouvrir_demande('$A', '$BIEN', 'R2', 'en', null)"
essai "27. un hachage mal formé : refusé" refus "$(LIEN R3 ZZZ fiche)"
essai "28. une langue hors fr/en/es : refusée" refus "select * from fv_ouvrir_demande('$A', '$BIEN', 'R4', 'de', null)"
essai "29. le navigateur (anon) ne lit pas les demandes" refus "set role anon; select * from $F"
essai "30. le navigateur (authenticated) ne lit pas les jetons" refus "set role authenticated; select * from $J"
essai "31. anon n'exécute pas la fonction d'ouverture" refus "set role anon; select * from fv_ouvrir_demande('$A', '$BIEN', 'R5', 'fr', null)"
essai "32. authenticated n'exécute pas la saisie" refus "set role authenticated; select fv_enregistrer_destinataire(gen_random_uuid(), '$A', null, '{}'::jsonb, 'hote', null, 1)"
essai "33. service_role exécute la fonction de lien" passe "set role service_role; select * from fv_nouveau_lien('$A', '$BIEN', 'R6', 'es', null, '$H4', 'fiche', now())"
essai "34. un second compte, même référence : sa propre demande" passe "select * from fv_nouveau_lien('$B', '$BIEN', 'R6', 'es', null, '$H5', 'fiche', now())"
vaut "35. deux demandes R6, une par compte" 2 "select count(*) from $F where booking_id = 'R6'"
H6=$(printf '6%.0s' $(seq 64)); H7=$(printf '7%.0s' $(seq 64)); H8=$(printf '8%.0s' $(seq 64))
essai "36. le double clic sort en FV429 (pas 55P03, qui est l'attente de verrou)" passe "do \$\$ begin perform fv_nouveau_lien('$A', '$BIEN', 'R1', 'fr', null, '$H8', 'disponible', now()); raise exception 'pas de refus'; exception when sqlstate 'FV429' then null; end \$\$"
# 37. CONCURRENCE, demande existante : la ligne est verrouillée, donc le second
# appel attend le premier, voit son jeton, et refuse. Sans `for update`, deux
# jetons (sonde de la review 1 : l'épreuve ne le gardait pas).
$P -c "select * from fv_ouvrir_demande('$A', '$BIEN', 'R7', 'fr', null)" >/dev/null
( $P -c "begin; select * from fv_nouveau_lien('$A', '$BIEN', 'R7', 'fr', null, '$H6', 'fiche', now()); select pg_sleep(1.5); commit;" >/dev/null 2>&1 ) &
sleep 0.5
essai "37a. deux liens simultanés, même porte : le second est refusé" refus "select * from fv_nouveau_lien('$A', '$BIEN', 'R7', 'fr', null, '$H7', 'fiche', now())"
wait
vaut "37b. un seul jeton pour R7" 1 "select count(*) from $J j join $F f on f.id = j.demande_id where f.booking_id = 'R7'"
DESTH="'{\"type\":\"particulier\",\"nom\":\"Léa\",\"adresse1\":\"1 rue\",\"ville\":\"Pau\",\"pays\":\"France\"}'::jsonb"
vaut "38a. la saisie de l'hôte rend « ok »" ok "select r_issue from fv_saisir_par_hote('$A', '$BIEN', 'R8', 'fr', '$A', $DESTH)"
vaut "38b. elle a ouvert la demande ET l'a remplie" "formulaire_rempli|hote|Léa" "select statut, saisi_par, dest_nom from $F where booking_id = 'R8'"
essai "39a. saisie de l'hôte sur une facture émise : refusée" refus "select * from fv_saisir_par_hote('$A', '$BIEN', 'R1', 'fr', '$A', $DESTH)"
vaut "39b. et rien n'a changé" "SCI X" "select dest_nom from $F where booking_id = 'R1'"
essai "39c. saisie de l'hôte invalide sur une réservation neuve : refusée" refus "select * from fv_saisir_par_hote('$A', '$BIEN', 'R9', 'fr', '$A', '{\"siren\":\"12\"}'::jsonb)"
vaut "39d. et aucune demande orpheline ne reste" 0 "select count(*) from $F where booking_id = 'R9'"
essai "40. anon n'exécute pas la saisie de l'hôte" refus "set role anon; select * from fv_saisir_par_hote('$A', '$BIEN', 'R10', 'fr', null, '{}'::jsonb)"
echo "BILAN : $ok conformes, $ko écarts"
[ "$ko" = 0 ]
