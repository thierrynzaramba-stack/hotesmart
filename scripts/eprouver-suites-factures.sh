#!/bin/bash
# scripts/eprouver-suites-factures.sh — épreuve du trigger `fvs_suite_protegee`
# (migrations/2026-11-08-entites-juridiques.sql) sur un VRAI Postgres.
#
# Pourquoi : les tests de la suite ne lisent que le TEXTE du SQL. La review 2
# de l'étape 1 (9 nov. 2026, constat 1) a montré qu'un trigger incomplet les
# passait. Ce script applique la migration et joue 20 gestes, un par règle :
# chacun doit passer ou être refusé.
#
# ⚠ AUCUNE BASE EXISTANTE N'EST TOUCHÉE : le script crée son propre cluster
# Postgres dans un dossier temporaire (socket local, aucun port TCP ouvert), et
# le détruit à la fin. Il faut les binaires Postgres (initdb, pg_ctl, psql).
#
# Usage : bash scripts/eprouver-suites-factures.sh   → code 0 si 0 écart.
set -u
RACINE="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATION="$RACINE/migrations/2026-11-08-entites-juridiques.sql"
BIN="$(dirname "$(command -v initdb 2>/dev/null || ls /usr/lib/postgresql/*/bin/initdb 2>/dev/null | tail -1)")"
[ -x "$BIN/initdb" ] || { echo "initdb introuvable : installer Postgres pour cette épreuve"; exit 2; }

DIR="$(mktemp -d)"
PORT=5499
moi () { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/sh -c "$*"; else sh -c "$*"; fi; }
[ "$(id -u)" = 0 ] && chown postgres "$DIR"
nettoyer () { moi "'$BIN/pg_ctl' -D '$DIR/data' stop -m fast" >/dev/null 2>&1; rm -rf "$DIR"; }
trap nettoyer EXIT

moi "'$BIN/initdb' -D '$DIR/data' -A trust -U postgres" >/dev/null || exit 2
moi "'$BIN/pg_ctl' -D '$DIR/data' -o \"-p $PORT -k $DIR -c listen_addresses=''\" -l '$DIR/pg.log' -w start" >/dev/null || exit 2

P="$BIN/psql -h $DIR -p $PORT -U postgres -d postgres -v ON_ERROR_STOP=1 -qtA"
# Le socle que Supabase fournit : rôles, auth.users, properties.
$P >/dev/null <<'SQL' || exit 2
create role anon; create role authenticated;
create schema auth;
create table auth.users (id uuid primary key);
create table public.properties (id uuid primary key, user_id uuid not null);
insert into auth.users values ('11111111-1111-4111-8111-111111111111');
SQL
$P -f "$MIGRATION" >/dev/null 2>&1 || { echo "la migration ne s'applique pas"; exit 1; }
$P -f "$MIGRATION" >/dev/null 2>&1 || { echo "la migration ne se rejoue pas"; exit 1; }

A=11111111-1111-4111-8111-111111111111
E=eeeeeeee-0000-4000-8000-000000000001
E2=eeeeeeee-0000-4000-8000-000000000002
S=public.factures_voyageur_suites
W="where entite_id = '$E' and annee = 2026"
UPSERT="on conflict (entite_id, annee) do update set prefixe = excluded.prefixe, prochain_numero = excluded.prochain_numero"
ok=0; ko=0
essai () { # libellé, attendu (passe|refus), sql
  if out=$($P -c "$3" 2>&1); then r=passe; else r=refus; fi
  if [ "$r" = "$2" ]; then ok=$((ok + 1)); s="  ok "; else ko=$((ko + 1)); s="ECART"; fi
  echo "$s | attendu $2, obtenu $r | $1"
}
$P -c "insert into public.entites_juridiques (id, user_id, type, nom, regime_tva) values ('$E', '$A', 'personne_physique', 'E', 'exonere'), ('$E2', '$A', 'personne_physique', 'E2', 'exonere')" >/dev/null
essai "1. une suite naît vierge (départ 12)" passe "insert into $S (entite_id, user_id, annee, prefixe, prochain_numero) values ('$E', '$A', 2026, 'F', 12)"
essai "2. une suite ne naît pas entamée" refus "insert into $S (entite_id, user_id, annee, prochain_numero, dernier_emis) values ('$E', '$A', 2027, 10, 9)"
essai "3. réglage avant la 1re facture" passe "update $S set prefixe = 'HS', prochain_numero = 20 $W"
essai "4. 1re émission qui saute un numéro" refus "update $S set dernier_emis = 25, prochain_numero = 26 $W"
essai "5. 1re émission = le prochain numéro" passe "update $S set dernier_emis = 20, prochain_numero = 21 $W"
essai "6. saut de 20 à 40" refus "update $S set dernier_emis = 40, prochain_numero = 41 $W"
essai "7. relever le prochain (un trou)" refus "update $S set prochain_numero = 30 $W"
essai "8. changer le préfixe après émission" refus "update $S set prefixe = 'XX' $W"
essai "9. dernier émis remis à vide" refus "update $S set dernier_emis = null, prochain_numero = 1 $W"
essai "10. dernier émis en baisse" refus "update $S set dernier_emis = 19, prochain_numero = 20 $W"
essai "11. émission suivante (21)" passe "update $S set dernier_emis = 21, prochain_numero = 22 $W"
essai "12. changer d'année" refus "update $S set annee = 2027 $W"
essai "13. changer d'entité" refus "update $S set entite_id = '$E2' $W"
essai "14. supprimer une suite entamée" refus "delete from $S $W"
essai "15. upsert du writer sur une suite entamée" refus "insert into $S (entite_id, user_id, annee, prefixe, prochain_numero) values ('$E', '$A', 2026, 'X', 50) $UPSERT"
essai "16. upsert du writer, année neuve" passe "insert into $S (entite_id, user_id, annee, prefixe, prochain_numero) values ('$E', '$A', 2028, 'X', 50) $UPSERT"
essai "17. upsert du writer, suite vierge existante" passe "insert into $S (entite_id, user_id, annee, prefixe, prochain_numero) values ('$E', '$A', 2028, 'Y', 7) $UPSERT"
essai "18. supprimer une suite vierge" passe "delete from $S where entite_id = '$E' and annee = 2028"
essai "19. toucher modifie_le d'une suite entamée" passe "update $S set modifie_le = now() $W"
essai "20. le navigateur (anon) ne lit rien" refus "set role anon; select * from $S"
echo "BILAN : $ok conformes, $ko écarts"
[ "$ko" = 0 ]
