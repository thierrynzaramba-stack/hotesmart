#!/usr/bin/env node
// scripts/verifier-migration-canaux-du-bien.js
// La migration migrations/2026-10-19-canaux-du-bien.sql est-elle appliquee ?
//
// ⚠ IL NE SUFFIT PAS DE DEMANDER « la table existe-t-elle ? ». Une table peut
// exister sans sa RLS, sans son unicite ou sans sa cle etrangere : l'appel
// passerait, et la premiere ecriture reelle ferait la difference — en
// production, sur les canaux de quelqu'un. `create table if not exists`
// reussit en silence sur une table a la forme differente.
//
// ON L'INTERROGE DONC PAR SON COMPORTEMENT :
//   1. la table se lit, et ses 16 colonnes sont la ;
//   2. la RLS est posee : la cle PUBLIQUE ne lit rien (elle n'est le
//      proprietaire d'aucune ligne) et ne peut pas ecrire ;
//   3. la cle etrangere refuse un bien inconnu ;
//   4. l'unicite refuse deux fois le meme canal sur le meme bien ;
//   5. `mappe_pour_ce_bien` accepte `null` — c'est tout le sujet.
// Les points 3 a 5 ECRIVENT : ce script REFUSE donc la production, et nettoie
// ce qu'il a pose.
//
//   ENV_FILE=/home/thierry/hotesmart/.env.staging \
//     node scripts/verifier-migration-canaux-du-bien.js

require('dotenv').config({ path: process.env.ENV_FILE || '.env.staging' })
const { createClient } = require('@supabase/supabase-js')
const { REF_PRODUCTION, nomDeLaBase, refDuProjet } = require('../lib/empreinte-base')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
const ANON = process.env.SUPABASE_ANON_KEY
if (!URL || !KEY) {
  console.error('SUPABASE_URL et SUPABASE_SERVICE_KEY sont requis.')
  process.exit(2)
}
// ⚠ LA REFERENCE SE LIT PAR LE MODULE, PAS PAR UN MOTIF A LA MAIN — et c'est
// une CORRECTION DE SECURITE du 26 octobre 2026 (constat GRAVE de la re-review).
// Ce fichier lisait la reference par un motif maison, EN POSITION DECIDANTE.
// Le motif n'etait ni ancre, ni insensible a la casse, et n'acceptait que
// `https:` — donc il rendait une chaine VIDE sur `http://`, sur `HTTPS://` et
// sur une URL a identifiants, et la comparaison a la reference de production
// devenait fausse : LA GARDE DE PRODUCTION LAISSAIT PASSER.
// Mesure de la re-review, bout en bout avec un client factice : 6, 6, 3 et 6
// ECRITURES TENTEES sur les quatre scripts concernes, avec `http://` au lieu de
// `https://` dans le fichier d'environnement. Et la ligne imprimee annoncait
// « (production refusee) » au moment ou elle ne l'etait pas.
// Le modele de menace n'est pas un attaquant : c'est une faute de frappe dans
// un `.env`.
const PROJET = refDuProjet(URL) || ''
// ⚠ LA REFERENCE DE LA PRODUCTION VIENT DU MODULE COMMUN, elle ne se recopie
// plus (constat MINEUR de la review du 26 octobre 2026 : elle etait en dur
// dans 21 fichiers hors du module qui s'annonce « regle partagee »).
const PROD = REF_PRODUCTION
if (nomDeLaBase(URL) === 'PRODUCTION') {
  console.error(`REFUS : ${PROJET} est la PRODUCTION. Ce script ecrit — staging seulement.`)
  process.exit(2)
}
const sb = createClient(URL, KEY)

const COLONNES = ['id', 'user_id', 'property_id', 'provider', 'provider_property_id',
  'provider_channel_id', 'ota', 'titre', 'actif', 'mappe_pour_ce_bien',
  'mappings_pour_ce_bien', 'listing_url', 'vu_le', 'disparu_le', 'cree_le', 'mis_a_jour_le']
const FAUX_UUID = '00000000-0000-0000-0000-000000000000'
const MARQUE = 'VERIF-MIGRATION'

;(async () => {
  console.log(`Projet Supabase : ${PROJET} (production refusee)`)
  let ko = 0
  let bien = null

  // 1. La table et ses colonnes.
  {
    const { error } = await sb.from('canaux_du_bien').select(COLONNES.join(', ')).limit(1)
    if (error) {
      console.error('✗ table absente ou colonnes manquantes :', error.message)
      ko++
    } else console.log(`✓ la table existe, et ses ${COLONNES.length} colonnes repondent`)
  }

  // Un vrai bien d'abord : il sert a eprouver l'ecriture publique sur une
  // ligne que SEULE la RLS peut refuser.
  {
    const { data } = await sb.from('properties').select('id, user_id').limit(1).maybeSingle()
    if (data) bien = data
    else console.log('· aucun bien sur cette base : plusieurs points non eprouves')
  }

  // 2. La RLS.
  if (ANON) {
    const pub = createClient(URL, ANON)
    const { data, error } = await pub.from('canaux_du_bien').select('id').limit(1)
    // ⚠ UNE TABLE ABSENTE N'EST PAS UNE RLS QUI MORD. Sans ce cas, le script
    // annoncait « la cle publique LIT des lignes : 0 » sur une base ou la
    // migration n'est tout simplement pas passee — un message faux, sur un
    // point de securite. Un verificateur qui crie a tort finit ignore.
    if (error && /schema cache|does not exist/i.test(error.message)) {
      console.error('✗ RLS non eprouvee : la table est absente')
      ko++
    } else if (error && /permission|denied|rls/i.test(error.message)) {
      console.log('✓ la cle publique est refusee en lecture')
    } else if (!error && (!data || !data.length)) {
      console.log('✓ la cle publique ne lit aucune ligne (RLS par droit)')
    } else {
      console.error('✗ la cle publique LIT des lignes :', (data || []).length)
      ko++
    }

    // ⚠ L'ECRITURE S'EPROUVE SUR UNE LIGNE VALIDE (constat de la revue de
    // 21e0794). La premiere version inserait un `property_id` bidon : la cle
    // etrangere la refusait AVANT que la RLS n'ait son mot a dire, et le
    // script imprimait « la cle publique ne peut pas ecrire » meme si les
    // `revoke` n'avaient jamais ete appliques. Il ne prouvait rien.
    if (!bien) {
      console.log('· ecriture publique non eprouvee : aucun bien sur cette base')
    } else {
      const { error: eW } = await pub.from('canaux_du_bien').insert({
        user_id: bien.user_id, property_id: bien.id, provider: 'channex',
        provider_property_id: MARQUE + '-PUB', provider_channel_id: MARQUE + '-PUB' })
      if (eW && /schema cache|does not exist/i.test(eW.message)) {
        console.error('✗ ecriture publique non eprouvee : la table est absente')
        ko++
      } else if (eW && /permission|denied|rls|row-level|policy/i.test(eW.message)) {
        console.log('✓ la cle publique ne peut pas ecrire (refus de DROIT)')
      } else if (eW) {
        console.error('✗ refus obtenu, mais pas pour un motif de droit :', eW.message)
        ko++
      } else {
        console.error('✗ la cle publique a ECRIT')
        ko++
        await sb.from('canaux_du_bien').delete().eq('provider_channel_id', MARQUE + '-PUB')
      }
    }
  } else {
    console.log('· SUPABASE_ANON_KEY absente : RLS non eprouvee')
  }

  // 2 bis. Les colonnes du partenaire sortent de la lecture client.
  //
  // ⚠ IL FAUT UNE SESSION AUTHENTIFIEE, PAS LA CLE PUBLIQUE. Le privilege est
  // accorde au role `authenticated` ; la cle anonyme, elle, n'a AUCUN acces a
  // cette table. L'eprouver avec elle rendait trois « ✓ » qui ne prouvaient
  // rien d'autre que « anon ne lit pas » — le faux vert deja paye une fois sur
  // ce meme script.
  if (ANON && process.env.TEST_EMAIL && process.env.TEST_PASSWORD) {
    const client = createClient(URL, ANON)
    const { data: session, error: eAuth } = await client.auth.signInWithPassword({
      email: process.env.TEST_EMAIL, password: process.env.TEST_PASSWORD })
    if (eAuth || !session || !session.session) {
      console.error('✗ colonnes non eprouvees : connexion de recette impossible',
        eAuth ? '(' + eAuth.message + ')' : '')
      ko++
    } else {
      for (const col of ['provider', 'provider_property_id', 'provider_channel_id']) {
        const { error } = await client.from('canaux_du_bien').select(col).limit(1)
        if (error && /permission denied/i.test(error.message)) {
          console.log(`✓ la colonne ${col} est hors de portee d un client authentifie`)
        } else {
          console.error(`✗ la colonne ${col} est LISIBLE par un client authentifie :`,
            error ? error.message : '(aucune erreur)')
          ko++
        }
      }
      // ⚠ ET LES COLONNES SURES RESTENT LISIBLES — sinon le `revoke` a tout
      // emporte et l'ecran n'aurait plus rien a lire. Une garde qui ferme tout
      // n'est pas une garde, c'est une panne.
      const { error: eOk } = await client.from('canaux_du_bien')
        .select('ota, titre, actif, vu_le').limit(1)
      if (eOk && /permission denied/i.test(eOk.message)) {
        console.error('✗ le revoke a emporte les colonnes sures :', eOk.message)
        ko++
      } else console.log('✓ les colonnes sures restent lisibles par un client authentifie')
      await client.auth.signOut()
    }
  } else {
    console.log('· TEST_EMAIL/TEST_PASSWORD absents : colonnes non eprouvees')
  }

  // 3. La cle etrangere.
  {
    const { error } = await sb.from('canaux_du_bien').insert({
      user_id: FAUX_UUID, property_id: FAUX_UUID, provider: 'channex',
      provider_property_id: MARQUE, provider_channel_id: MARQUE })
    if (error && /foreign key|violates/i.test(error.message)) {
      console.log('✓ un bien inconnu est refuse (cle etrangere)')
    } else {
      console.error('✗ un bien inconnu a ete ACCEPTE :', error ? error.message : '(aucune erreur)')
      ko++
    }
  }

  if (bien) {
    const ligne = {
      user_id: bien.user_id, property_id: bien.id, provider: 'channex',
      provider_property_id: MARQUE, provider_channel_id: MARQUE,
      mappe_pour_ce_bien: null
    }
    // 5. `null` est accepte.
    const { error: e1 } = await sb.from('canaux_du_bien').insert(ligne)
    if (e1) { console.error('✗ insertion impossible :', e1.message); ko++ }
    else console.log('✓ `mappe_pour_ce_bien` accepte null')

    // 4. L'unicite.
    if (!e1) {
      const { error: e2 } = await sb.from('canaux_du_bien').insert(ligne)
      if (e2 && /duplicate|unique/i.test(e2.message)) {
        console.log('✓ le meme canal deux fois sur le meme bien est refuse')
      } else {
        console.error('✗ l unicite ne tient pas :', e2 ? e2.message : '(aucune erreur)')
        ko++
      }
    }

    const { error: eC } = await sb.from('canaux_du_bien')
      .delete().eq('provider_channel_id', MARQUE)
    console.log(eC ? '⚠ nettoyage incomplet : ' + eC.message : '✓ rien ne reste sur la base')
  }

  // 6. L'horloge du releve, table du meme lot.
  {
    const { error } = await sb.from('canaux_releve')
      .select('user_id, tente_le, vu_le, ok, erreur').limit(1)
    if (error) { console.error('✗ table canaux_releve absente :', error.message); ko++ }
    else console.log('✓ l horloge du releve (canaux_releve) existe')
  }

  console.log(ko === 0
    ? `\nMigration 2026-10-19-canaux-du-bien APPLIQUEE sur ${PROJET}.`
    : `\n${ko} verification(s) en echec sur ${PROJET}.`)
  process.exit(ko === 0 ? 0 : 1)
})().catch((e) => { console.error('Erreur :', e.message); process.exit(2) })
