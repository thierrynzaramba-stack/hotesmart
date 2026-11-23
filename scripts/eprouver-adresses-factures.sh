#!/bin/bash
# scripts/eprouver-adresses-factures.sh — épreuve de la migration
# 2026-11-23-charges-adresses-email (lot 5, spec §14.24) sur un VRAI Postgres.
#
# Pourquoi : les tests de la suite ne lisent que le TEXTE du SQL. Ce script
# applique la migration et joue un geste par règle : chacun doit passer ou être
# refusé. Il joue aussi le CONTRÔLE avant et après : il doit rendre au moins un
# false avant, et cinq true après — un contrôle qui ne peut pas échouer ne
# contrôle rien.
#
# ⚠ AUCUNE BASE EXISTANTE N'EST TOUCHÉE : le script crée son propre cluster
# Postgres dans un dossier temporaire (socket local, aucun port TCP ouvert), et
# le détruit à la fin. Il faut les binaires Postgres (initdb, pg_ctl, psql).
#
# Usage : bash scripts/eprouver-adresses-factures.sh   → code 0 si 0 écart.
set -u
RACINE="$(cd "$(dirname "$0")/.." && pwd)"
ENTITES="$RACINE/migrations/2026-11-08-entites-juridiques.sql"
MIGRATION="$RACINE/migrations/2026-11-23-charges-adresses-email.sql"
CONTROLE="$RACINE/migrations/2026-11-23-controle-charges-adresses-email.sql"
BIN="$(dirname "$(command -v initdb 2>/dev/null || ls /usr/lib/postgresql/*/bin/initdb 2>/dev/null | tail -1)")"
[ -x "$BIN/initdb" ] || { echo "initdb introuvable : installer Postgres pour cette épreuve"; exit 2; }

DIR="$(mktemp -d)"
PORT=5498
moi () { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/sh -c "$*"; else sh -c "$*"; fi; }
[ "$(id -u)" = 0 ] && chown postgres "$DIR" && chmod 755 "$DIR"
nettoyer () { moi "'$BIN/pg_ctl' -D '$DIR/data' stop -m fast" >/dev/null 2>&1; rm -rf "$DIR"; }
trap nettoyer EXIT

moi "'$BIN/initdb' -D '$DIR/data' -A trust -U postgres" >/dev/null || exit 2
moi "'$BIN/pg_ctl' -D '$DIR/data' -o \"-p $PORT -k $DIR -c listen_addresses=''\" -l '$DIR/pg.log' -w start" >/dev/null || exit 2

P="$BIN/psql -h $DIR -p $PORT -U postgres -d postgres -v ON_ERROR_STOP=1 -qtA"
A=11111111-1111-4111-8111-111111111111
B=22222222-2222-4222-8222-222222222222
# Le socle que Supabase fournit (rôles, auth.users, properties), une table
# `charges` réduite à sa clé, et l'ANCIENNE table de Q16, vide comme en prod.
$P >/dev/null <<SQL || exit 2
create role anon; create role authenticated;
create schema auth;
create table auth.users (id uuid primary key);
create table public.properties (id uuid primary key, user_id uuid not null);
create table public.charges (id uuid primary key default gen_random_uuid());
create table public.charges_adresses (user_id uuid primary key, version int not null default 1);
insert into auth.users values ('$A'), ('$B');
SQL
$P -f "$ENTITES" >/dev/null 2>&1 || { echo "la migration des entités ne s'applique pas"; exit 1; }

ok=0; ko=0
note () { if [ "$1" = "$2" ]; then ok=$((ok + 1)); s="  ok "; else ko=$((ko + 1)); s="ECART"; fi; echo "$s | attendu $1, obtenu $2 | $3"; }
essai () { # libellé, attendu (passe|refus), sql
  if $P -c "$3" >/dev/null 2>&1; then r=passe; else r=refus; fi
  note "$2" "$r" "$1"
}

# ── Le contrôle AVANT : il doit pouvoir dire false ───────────────────────────
avant=$($P -F'|' -f "$CONTROLE" 2>/dev/null | cut -d'|' -f2 | tr '\n' ' ')
if echo "$avant" | grep -q f; then r=faux; else r=vrai; fi
note faux "$r" "0. le contrôle AVANT la migration n'est pas tout vrai ($avant)"

# ── La migration ─────────────────────────────────────────────────────────────
if $P -f "$MIGRATION" >/dev/null 2>&1; then r=passe; else r=refus; fi
note passe "$r" "1. la migration s'applique (ancienne table vide)"
if $P -f "$MIGRATION" >/dev/null 2>&1; then r=passe; else r=refus; fi
note passe "$r" "2. la migration se rejoue"
apres=$($P -F'|' -f "$CONTROLE" 2>/dev/null | cut -d'|' -f2 | tr '\n' ' ')
[ "$apres" = "t t t t t " ] && r=vrai || r=faux
note vrai "$r" "3. le contrôle APRÈS rend cinq true ($apres)"

E=eeeeeeee-0000-4000-8000-000000000001
E2=eeeeeeee-0000-4000-8000-000000000002
EB=eeeeeeee-0000-4000-8000-00000000000b
L=bbbbbbbb-0000-4000-8000-000000000001
LB=bbbbbbbb-0000-4000-8000-00000000000b
L2=bbbbbbbb-0000-4000-8000-000000000002
T=public.charges_adresses_email
$P -c "insert into public.entites_juridiques (id, user_id, type, nom, regime_tva) values ('$E', '$A', 'personne_physique', 'E', 'exonere'), ('$E2', '$A', 'personne_physique', 'E2', 'exonere'), ('$EB', '$B', 'personne_physique', 'EB', 'exonere')" >/dev/null
$P -c "insert into public.properties values ('$L', '$A'), ('$L2', '$A'), ('$LB', '$B')" >/dev/null

essai "4. adresse d'une entité du compte" passe "insert into $T (locale, user_id, entite_id) values ('thierry-nzaramba.p7x2m9qa', '$A', '$E')"
essai "5. adresse d'un logement du compte" passe "insert into $T (locale, user_id, property_uuid) values ('la-bulle.k2j9x7q4', '$A', '$L')"
essai "6. une 2e adresse pour la même entité" refus "insert into $T (locale, user_id, entite_id) values ('autre.aaaaaaaa', '$A', '$E')"
essai "7. une 2e adresse pour le même logement" refus "insert into $T (locale, user_id, property_uuid) values ('autre.bbbbbbbb', '$A', '$L')"
essai "8. entité ET logement" refus "insert into $T (locale, user_id, entite_id, property_uuid) values ('deux.cccccccc', '$A', '$E2', '$L2')"
essai "8b. contre-épreuve : la même entité seule passe" passe "insert into $T (locale, user_id, entite_id) values ('deux.cccccccc', '$A', '$E2')"
essai "9. ni entité ni logement" refus "insert into $T (locale, user_id) values ('rien.dddddddd', '$A')"
essai "10. l'entité d'un autre compte" refus "insert into $T (locale, user_id, entite_id) values ('vol.eeeeeeee', '$A', '$EB')"
essai "11. le logement d'un autre compte" refus "insert into $T (locale, user_id, property_uuid) values ('vol.ffffffff', '$A', '$LB')"
essai "12. une majuscule" refus "insert into $T (locale, user_id, entite_id) values ('La-bulle.k2j9x7q4', '$B', '$EB')"
essai "13. sans point" refus "insert into $T (locale, user_id, entite_id) values ('la-bulle-k2j9x7q4', '$B', '$EB')"
essai "14. un code de 7 caractères" refus "insert into $T (locale, user_id, entite_id) values ('la-bulle.k2j9x7q', '$B', '$EB')"
essai "15. un tiret en tête" refus "insert into $T (locale, user_id, entite_id) values ('-bulle.k2j9x7q4', '$B', '$EB')"
essai "16. 51 caractères" refus "insert into $T (locale, user_id, entite_id) values ('$(printf 'a%.0s' $(seq 1 42)).k2j9x7q4', '$B', '$EB')"
essai "17. 50 caractères" passe "insert into $T (locale, user_id, entite_id) values ('$(printf 'a%.0s' $(seq 1 41)).k2j9x7q4', '$B', '$EB')"
essai "18. changer d'adresse : la clé se remplace" passe "update $T set locale = 'la-bulle.zzzz9999', cree_le = now() where property_uuid = '$L'"
essai "19. l'ancienne adresse n'existe plus" passe "do \$\$ begin if exists (select 1 from $T where locale = 'la-bulle.k2j9x7q4') then raise exception 'encore là'; end if; end \$\$"
essai "20. déplacer une adresse vers le logement d'un autre compte" refus "update $T set property_uuid = '$LB' where property_uuid = '$L'"
essai "21. authenticated ne lit rien" refus "set role authenticated; select * from $T"
essai "22. anon n'écrit rien" refus "set role anon; insert into $T (locale, user_id, entite_id) values ('x.aaaaaaaa', '$A', '$E')"
essai "23. un sujet de 300 caractères" passe "insert into public.charges (email_sujet) values (repeat('s', 300))"
essai "24. un sujet de 301 caractères" refus "insert into public.charges (email_sujet) values (repeat('s', 301))"
essai "25. un texte de 2 000 caractères" passe "insert into public.charges (email_texte) values (repeat('t', 2000))"
essai "26. un texte de 2 001 caractères" refus "insert into public.charges (email_texte) values (repeat('t', 2001))"
essai "27. le logement supprimé emporte son adresse" passe "delete from public.properties where id = '$L'; do \$\$ begin if exists (select 1 from $T where property_uuid = '$L') then raise exception 'orpheline'; end if; end \$\$"

# ── L'ancienne table NON VIDE arrête la migration ────────────────────────────
$P -c "create table public.charges_adresses (user_id uuid primary key, version int not null default 1); insert into public.charges_adresses values ('$A', 1)" >/dev/null
if $P -f "$MIGRATION" >/dev/null 2>&1; then r=passe; else r=refus; fi
note refus "$r" "28. une ligne dans l'ancienne table : la migration s'arrête"
if $P -c "select 1 from public.charges_adresses" >/dev/null 2>&1; then r=passe; else r=refus; fi
note passe "$r" "29. et l'ancienne table est toujours là"

echo "---- $ok ok, $ko écart(s)"
[ "$ko" = 0 ]
