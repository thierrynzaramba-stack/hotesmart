#!/bin/bash
# scripts/eprouver-charges-sans-entite.sh — épreuve de la migration
# 2026-11-24-charges-sans-entite (lot 5 bis, spec §14.25) sur un VRAI Postgres.
#
# Pourquoi : les tests de la suite ne lisent que le TEXTE du SQL. Ce script
# applique la VRAIE chaîne des migrations du compte de charges (entités, charges,
# résumé, périodes, crédits, exercice, tableau, adresses), pose des données, puis
# applique celle du lot 5 bis — deux fois, elle est rejouable — et joue un geste
# par règle. Il joue aussi le CONTRÔLE avant et après : un contrôle qui ne peut
# pas échouer ne contrôle rien. Et il joue les DEUX courses entre une
# validation et un rattachement, dans deux sessions réelles.
#
# ⚠ AUCUNE BASE EXISTANTE N'EST TOUCHÉE : le script crée son propre cluster
# Postgres dans un dossier temporaire (socket local, aucun port TCP ouvert), et
# le détruit à la fin. Il faut les binaires Postgres (initdb, pg_ctl, psql).
#
# Usage : bash scripts/eprouver-charges-sans-entite.sh   → code 0 si 0 écart.
set -u
RACINE="$(cd "$(dirname "$0")/.." && pwd)"
M="$RACINE/migrations"
CHAINE="2026-11-08-entites-juridiques 2026-11-09-compte-de-charges 2026-11-09-entites-sans-defaut
2026-11-10-charges-resume-categorie 2026-11-13-charges-periode 2026-11-17-charges-avis-impot
2026-11-19-charges-credits 2026-11-19-charges-exercice-mois 2026-11-19-charges-heic
2026-11-19-charges-periode-longue 2026-11-20-charges-tableau 2026-11-23-charges-adresses-email"
MIGRATION="${MIGRATION_EPREUVE:-$M/2026-11-24-charges-sans-entite.sql}"   # contre-épreuve : une copie sabotée
CONTROLE="$M/2026-11-24-controle-charges-sans-entite.sql"
BIN="$(dirname "$(command -v initdb 2>/dev/null || ls /usr/lib/postgresql/*/bin/initdb 2>/dev/null | tail -1)")"
[ -x "$BIN/initdb" ] || { echo "initdb introuvable : installer Postgres pour cette épreuve"; exit 2; }

DIR="$(mktemp -d)"
PORT=5497
moi () { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/sh -c "$*"; else sh -c "$*"; fi; }
[ "$(id -u)" = 0 ] && chown postgres "$DIR" && chmod 755 "$DIR"
nettoyer () { moi "'$BIN/pg_ctl' -D '$DIR/data' stop -m fast" >/dev/null 2>&1; rm -rf "$DIR"; }
trap nettoyer EXIT

moi "'$BIN/initdb' -D '$DIR/data' -A trust -U postgres" >/dev/null || exit 2
moi "'$BIN/pg_ctl' -D '$DIR/data' -o \"-p $PORT -k $DIR -c listen_addresses=''\" -l '$DIR/pg.log' -w start" >/dev/null || exit 2

P="$BIN/psql -h $DIR -p $PORT -U postgres -d postgres -v ON_ERROR_STOP=1 -qtA"
A=11111111-1111-4111-8111-111111111111
B=22222222-2222-4222-8222-222222222222
E1=e1e1e1e1-0000-4000-8000-000000000001
E2=e2e2e2e2-0000-4000-8000-000000000002
E3=e3e3e3e3-0000-4000-8000-000000000003
X=0000000a-0000-4000-8000-00000000000a   # rattaché à E1
Y=0000000b-0000-4000-8000-00000000000b   # sans entité
Z=0000000c-0000-4000-8000-00000000000c   # sans entité
V=0000000d-0000-4000-8000-00000000000d   # sans entité, sera supprimé
W=0000000e-0000-4000-8000-00000000000e   # rattaché à E3, archivée
Q=0000000f-0000-4000-8000-00000000000f   # course 1
R=00000010-0000-4000-8000-000000000010   # course 2
T=00000011-0000-4000-8000-000000000011   # rattaché à E1 APRÈS un e-mail

# Le socle que Supabase fournit : rôles, auth.users, storage.buckets, properties.
$P >/dev/null <<SQL || exit 2
create role anon; create role authenticated; create role service_role;
create schema auth; create schema storage;
create table auth.users (id uuid primary key);
create table storage.buckets (id text primary key, name text, public boolean,
  file_size_limit bigint, allowed_mime_types text[]);
create table public.properties (id uuid primary key, user_id uuid not null, name text);
insert into auth.users values ('$A'), ('$B');
insert into public.properties (id, user_id) values
  ('$X','$A'),('$Y','$A'),('$Z','$A'),('$V','$A'),('$W','$A'),('$Q','$A'),('$R','$A'),('$T','$A');
SQL
for f in $CHAINE; do
  $P -f "$M/$f.sql" >/dev/null 2>"$DIR/err" || { echo "la migration $f ne s'applique pas :"; cat "$DIR/err"; exit 1; }
done

ok=0; ko=0
note () { if [ "$1" = "$2" ]; then ok=$((ok + 1)); s="  ok "; else ko=$((ko + 1)); s="ECART"; fi; echo "$s | attendu $1, obtenu $2 | $3"; }
essai () { # libellé, attendu (passe|refus), sql
  if $P -c "$3" >/dev/null 2>&1; then r=passe; else r=refus; fi
  note "$2" "$r" "$1"
}
val () { $P -c "$1" 2>/dev/null; }
charge () { # id, statut, entité ('null' ou uuid), bien ('null' ou uuid), jour
  echo "insert into public.charges (id, user_id, statut, origine, categorie, montant_ttc_cents, jour, entite_juridique_id, bien_id)
    values ('$1', '$A', '$2', 'email', 'menage', 1000, '${5:-2026-11-10}', $3, $4);"
}

# Les entités et les liens d'AVANT le lot : X → E1, W → E3 (archivée ensuite).
$P >/dev/null <<SQL || exit 2
insert into public.entites_juridiques (id, user_id, type, nom, regime_tva) values
  ('$E1','$A','personne_physique','Un','exonere'),
  ('$E2','$A','personne_physique','Deux','exonere'),
  ('$E3','$A','personne_physique','Trois','exonere');
insert into public.biens_entites (property_uuid, entite_id, user_id) values ('$X','$E1','$A'), ('$W','$E3','$A');
update public.entites_juridiques set archivee_le = now() where id = '$E3';
SQL
# Les factures reçues par e-mail AVANT le lot (lot 5) : une sur T, sans entité
# (T sera rattaché à E1 avant la migration) ; une sur W, sans entité (entité
# archivée, §14.24).
C_T=aaaaaaaa-0000-4000-8000-0000000000a1
C_W=aaaaaaaa-0000-4000-8000-0000000000a2
$P >/dev/null <<SQL || exit 2
$(charge $C_T a_verifier null "'$T'")
$(charge $C_W a_verifier null "'$W'")
insert into public.biens_entites (property_uuid, entite_id, user_id) values ('$T','$E1','$A');
SQL
note "$C_T|" "$(val "select id || '|' || coalesce(entite_juridique_id::text, '') from public.charges where id = '$C_T'")" "0. avant le lot : la facture reçue sur T reste sans entité après le rattachement de T"

# ── Le contrôle AVANT ────────────────────────────────────────────────────────
avant=$($P -F'|' -f "$CONTROLE" 2>/dev/null | cut -d'|' -f2 | tr '\n' ' ')
if echo "$avant" | grep -q f; then r=faux; else r=vrai; fi
note faux "$r" "1. le contrôle AVANT la migration n'est pas tout vrai ($avant)"
essai "2. avant : une facture validée sans entité est refusée (l'ancienne contrainte)" refus \
  "$(charge aaaaaaaa-0000-4000-8000-0000000000ff validee null "'$Y'")"

# ── La migration, deux fois ──────────────────────────────────────────────────
$P -f "$MIGRATION" >/dev/null 2>"$DIR/err" || { echo "la migration ne s'applique pas :"; cat "$DIR/err"; exit 1; }
$P -f "$MIGRATION" >/dev/null 2>"$DIR/err" || { echo "la migration n'est pas rejouable :"; cat "$DIR/err"; exit 1; }
apres=$($P -F'|' -f "$CONTROLE" 2>/dev/null | cut -d'|' -f2 | tr '\n' ' ')
note "t t t t t " "$apres" "3. le contrôle APRÈS dit cinq fois vrai"

# ── Le rattrapage ─────────────────────────────────────────────────────────────
note "$E1" "$(val "select entite_juridique_id from public.charges where id = '$C_T'")" "4. rattrapage : la facture de T prend E1"
note "" "$(val "select entite_juridique_id from public.charges where id = '$C_W'")" "5. rattrapage : la facture de W (entité archivée) reste sans entité"

# ── La garde ──────────────────────────────────────────────────────────────────
C1=bbbbbbbb-0000-4000-8000-0000000000b1
C2=bbbbbbbb-0000-4000-8000-0000000000b2
C3=bbbbbbbb-0000-4000-8000-0000000000b3
C4=bbbbbbbb-0000-4000-8000-0000000000b4
C5=bbbbbbbb-0000-4000-8000-0000000000b5
essai "6. validée sans entité, logement SANS entité (Y) : passe" passe "$(charge $C1 validee null "'$Y'")"
essai "7. validée sans entité, logement AVEC entité (X) : refusée" refus "$(charge $C2 validee null "'$X'")"
essai "8. validée sans entité, logement d'une entité ARCHIVÉE (W) : refusée" refus "$(charge $C2 validee null "'$W'")"
essai "9. validée sans entité ni logement : refusée" refus "$(charge $C2 validee null null)"
essai "10. à vérifier sans entité ni logement : passe (pas validée)" passe "$(charge $C2 a_verifier null null)"
essai "11. … puis validée sans entité ni logement : refusée" refus "update public.charges set statut = 'validee' where id = '$C2'"
essai "12. validée avec E1, sans logement : passe" passe "$(charge $C3 validee "'$E1'" null)"
essai "13. … puis entité retirée : refusée" refus "update public.charges set entite_juridique_id = null where id = '$C3'"
essai "14. à vérifier sans entité sur X (rattaché) : passe (la garde porte sur les validées)" passe "$(charge $C4 a_verifier null "'$X'")"
essai "15. … puis validée sans entité : refusée" refus "update public.charges set statut = 'validee' where id = '$C4'"
essai "16. validée sans entité sur Z, avec une autre facture validée E1 sur Z : passent" passe \
  "$(charge $C5 validee null "'$Z'") $(charge bbbbbbbb-0000-4000-8000-0000000000b6 validee "'$E1'" "'$Z'")"

# ── Les totaux « sans entité » ────────────────────────────────────────────────
note "5" "$(val "select public.charges_totaux('$A','2026-01-01','2026-12-31',null)->'total'->>'nb_factures'")" \
  "17. charges_totaux(NULL) : les 5 factures comptées sans entité de A (C1, C5 validées ; C_W, C2, C4 à vérifier)"
note "3" "$(val "select public.charges_totaux('$A','2026-01-01','2026-12-31',null)->'total'->>'nb_non_verifiees'")" \
  "18. charges_totaux(NULL) : dont 3 non vérifiées (l'estimation le dira)"
note "2026-11-10" "$(val "select public.charges_exercices_bornes('$A', null)->>'premier'")" "19. charges_exercices_bornes(NULL) : bornes des factures sans entité"
note "$C1 $C5 " "$(val "select string_agg(e->>'id', ' ' order by e->>'id') || ' ' from jsonb_array_elements(public.charges_detail_mois('$A','2026-11-01','2026-11-30',null)) e where e->>'statut' = 'validee'")" \
  "20. charges_detail_mois(NULL) : les validées sans entité seules (C1, C5)"
note "0" "$(val "select count(*) from jsonb_array_elements(public.charges_detail_mois('$A','2026-11-01','2026-11-30',null)) e where e->>'entite_juridique_id' is not null")" \
  "21. charges_detail_mois(NULL) : aucune facture d'une entité"

# ── Les factures suivent le logement ──────────────────────────────────────────
essai "22. rattacher Y à E2 : passe" passe "insert into public.biens_entites (property_uuid, entite_id, user_id) values ('$Y','$E2','$A')"
note "$E2" "$(val "select entite_juridique_id from public.charges where id = '$C1'")" "23. la facture validée de Y a pris E2"
note "1" "$(val "select public.charges_totaux('$A','2026-01-01','2026-12-31','$E2')->'total'->>'nb_factures'")" "24. les totaux de E2 la comptent"
note "4" "$(val "select public.charges_totaux('$A','2026-01-01','2026-12-31',null)->'total'->>'nb_factures'")" "25. les totaux sans entité ne comptent plus C1 : C5, C_W, C2, C4"
essai "26. rattacher Z à E2 : passe" passe "insert into public.biens_entites (property_uuid, entite_id, user_id) values ('$Z','$E2','$A')"
note "$E2|$E1" "$(val "select (select entite_juridique_id from public.charges where id = '$C5') || '|' || (select entite_juridique_id from public.charges where id = 'bbbbbbbb-0000-4000-8000-0000000000b6')")" \
  "27. sur Z : la facture sans entité prend E2, celle d'E1 garde E1"
essai "28. passer W de E3 (archivée) à E1 : passe" passe "update public.biens_entites set entite_id = '$E1' where property_uuid = '$W'"
note "$E1" "$(val "select entite_juridique_id from public.charges where id = '$C_W'")" "29. la facture de W, sans entité, prend E1"
essai "30. détacher Y : passe" passe "delete from public.biens_entites where property_uuid = '$Y'"
note "$E2" "$(val "select entite_juridique_id from public.charges where id = '$C1'")" "31. détacher ne vide l'entité d'aucune facture"
note "0" "$(val "select count(*) from public.charges_resume where user_id = '$A' and entite_juridique_id is null and bien_id = '$Y'")" \
  "32. le résumé n'a plus de cellule sans entité pour Y"

# ── La suppression d'un logement ──────────────────────────────────────────────
C6=bbbbbbbb-0000-4000-8000-0000000000b7
essai "33. validée sans entité sur V : passe" passe "$(charge $C6 validee null "'$V'")"
essai "34. supprimer le logement V : passe (on delete set null)" passe "delete from public.properties where id = '$V'"
note "validee||" "$(val "select statut || '|' || coalesce(entite_juridique_id::text,'') || '|' || coalesce(bien_id::text,'') from public.charges where id = '$C6'")" \
  "35. la facture reste validée, sans entité ni logement"
essai "36. on peut encore la toucher (signal tranché)" passe "update public.charges set signal_tranche = true where id = '$C6'"
essai "37. et lui donner une entité" passe "update public.charges set entite_juridique_id = '$E1' where id = '$C6'"
essai "38. mais pas la lui retirer de nouveau" refus "update public.charges set entite_juridique_id = null where id = '$C6'"

# ── Les deux courses ──────────────────────────────────────────────────────────
C7=cccccccc-0000-4000-8000-0000000000c1
C8=cccccccc-0000-4000-8000-0000000000c2
$P -c "$(charge $C7 a_verifier null null) $(charge $C8 a_verifier null null)" >/dev/null || exit 2
# Course 1 : la validation sans entité (sur Q) tient le verrou ; le rattachement
# de Q arrive pendant. Attendu : il attend, puis déplace la facture validée.
( $P -c "begin; update public.charges set statut = 'validee', bien_id = '$Q' where id = '$C7'; select pg_sleep(2); commit;" >/dev/null 2>&1 ) &
sleep 0.7
$P -c "insert into public.biens_entites (property_uuid, entite_id, user_id) values ('$Q','$E1','$A')" >/dev/null 2>&1
wait
note "validee|$E1" "$(val "select statut || '|' || coalesce(entite_juridique_id::text,'') from public.charges where id = '$C7'")" \
  "39. course 1 (validation d'abord) : la facture validée est déplacée vers E1"
# Course 2 : le rattachement de R tient le verrou ; la validation sans entité
# sur R arrive pendant. Attendu : elle attend, puis elle est refusée.
( $P -c "begin; insert into public.biens_entites (property_uuid, entite_id, user_id) values ('$R','$E1','$A'); select pg_sleep(2); commit;" >/dev/null 2>&1 ) &
sleep 0.7
if $P -c "update public.charges set statut = 'validee', bien_id = '$R' where id = '$C8'" >/dev/null 2>&1; then r=passe; else r=refus; fi
wait
note refus "$r" "40. course 2 (rattachement d'abord) : la validation sans entité est refusée"
note "a_verifier|" "$(val "select statut || '|' || coalesce(entite_juridique_id::text,'') from public.charges where id = '$C8'")" \
  "41. course 2 : la facture est restée à vérifier"

# ── L'autre compte n'est pas touché ───────────────────────────────────────────
note "0" "$(val "select public.charges_totaux('$B','2026-01-01','2026-12-31',null)->'total'->>'nb_factures'")" "42. un autre compte : rien sans entité"
note "t t t t t " "$($P -F'|' -f "$CONTROLE" 2>/dev/null | cut -d'|' -f2 | tr '\n' ' ')" "43. le contrôle à la fin dit encore cinq fois vrai"

echo "—— $ok ok, $ko écart(s)"
[ "$ko" = 0 ]
