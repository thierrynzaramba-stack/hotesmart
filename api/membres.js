// api/membres.js — Page « Equipe et droits » (etape 4).
// DOC : docs/kb/profils-et-droits.md (modif = MEME COMMIT)
//
// Un seul endpoint pour les profils d'un compte et leurs droits.
//
// DOMAINE `equipe`, qui est NON DELEGABLE en ecriture (lib/permissions.js) :
// `peutEcrire` exige userId === accountUserId. Le titulaire seul modifie les
// profils, et c'est garanti cote serveur — pas seulement par l'interface qui
// cache le bouton.
//
// ⚠ DEUX REPRESENTATIONS DU MEME PERIMETRE, a tenir synchrones :
//   profile_permissions.property_ids   uuid[]  (properties.id)
//   public_tokens.property_ids         text[]  (provider_property_id)
// La premiere est la source de verite des droits ; la seconde est ce que lit la
// PWA prestataire. Ecrire l'une sans l'autre donne un prestataire qui a les
// droits mais ne voit rien, ou l'inverse.

const { createClient } = require('@supabase/supabase-js')
const crypto = require('crypto')
const { requirePermission, verifierSession } = require('../lib/require-permission')
const { DOMAINES, NIVEAUX, NON_DELEGABLES } = require('../lib/permissions')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

const JOURS_VALIDITE_INVITATION = 7
const VISIBILITE_PWA_JOURS = 30

// Jeton genere cote SERVEUR. Ni gen_random_uuid() en defaut de colonne (qui
// creerait une invitation permanente sur chaque profil), ni Math.random (128 bits
// d'entropie reelle sont le minimum pour un lien qui donne acces a un compte).
const nouveauJeton = () => crypto.randomBytes(32).toString('base64url')

const CHAMPS_PROFIL = 'id, account_user_id, member_user_id, first_name, last_name, email, phone, ' +
                      'access_mode, pwa_token, is_owner, active, invited_at, accepted_at, ' +
                      'invite_token, invite_expires_at, created_at'

// ─── Validation des droits soumis ────────────────────────────────────────────
//
// Renvoie { erreur } ou { permissions }. Ne fait AUCUNE confiance au client : la
// page peut griser ce qu'elle veut, la regle vit ici.
// `existant` : la ligne de droits deja en base, ou null a la creation.
//
// ⚠ CE QUI N'EST PAS FOURNI EST CONSERVE, PAS REMIS A ZERO. Le panneau des
// prestataires n'affiche ni perimetre ni domaines — ils se gerent depuis la
// fiche prestataire. Sans cette regle, enregistrer depuis ce panneau reduit
// aurait rebascule leur `property_scope` sur 'all' : Régina, reglee sur deux
// biens, aurait vu TOUT le compte. Un formulaire qui n'expose pas un champ ne
// doit jamais l'ecraser.
function validerPermissions (brut, estTitulaireCible, existant = null) {
  const p = brut && typeof brut === 'object' ? brut : {}
  const defaut = (cle, siVide) => p[cle] != null ? p[cle]
                                : existant && existant[cle] != null ? existant[cle]
                                : siVide
  const out = {}

  for (const domaine of DOMAINES) {
    const niveau = String(defaut(domaine, 'none'))
    if (!NIVEAUX.includes(niveau)) return { erreur: `Niveau invalide pour ${domaine}` }
    // ⚠ `facturation` et `equipe` ne se delèguent pas. Le refus est ici parce
    // qu'une valeur ecrite en base survivrait a l'interface : un jour ou la garde
    // serait relachee, le membre l'aurait deja.
    if (NON_DELEGABLES.includes(domaine) && niveau === 'write' && !estTitulaireCible) {
      // ⚠ Fourni explicitement -> on REFUSE, l'appelant doit le savoir.
      // Herite du socle -> on ABAISSE silencieusement. Une valeur fautive deja en
      // base (correctif SQL, seed, migration) rendrait sinon le profil
      // definitivement non enregistrable : aucun ecran ne permet de l'abaisser,
      // et chaque enregistrement la reconduirait pour la refuser aussitot.
      if (p[domaine] != null) {
        return { erreur: `Le domaine « ${domaine} » ne peut pas être délégué en écriture` }
      }
      console.warn(`[membres] ${domaine}=write herite du socle : abaisse a 'none'`)
      out[domaine] = 'none'
      continue
    }
    out[domaine] = niveau
  }

  const dispo = String(defaut('self_availability', 'none'))
  if (!NIVEAUX.includes(dispo)) return { erreur: 'Niveau invalide pour les disponibilités' }
  out.self_availability = dispo
  out.self_view_reviews = defaut('self_view_reviews', true) !== false

  // Le perimetre suit la meme regle : absent du corps -> celui deja enregistre.
  const scope = defaut('property_scope', 'all') === 'selected' ? 'selected' : 'all'
  out.property_scope = scope
  const idsBruts = p.property_ids != null ? p.property_ids
                 : existant && existant.property_ids != null ? existant.property_ids
                 : []
  out.property_ids = scope === 'selected'
    ? [...new Set((Array.isArray(idsBruts) ? idsBruts : []).map(String))]
    : []

  return { permissions: out }
}

// Les biens du perimetre doivent appartenir AU COMPTE. Sans ce controle, le
// titulaire pourrait rattacher un profil au bien d'un autre compte, et ce profil
// lirait des donnees qui ne sont pas les siennes.
// ⚠ TROIS CAS A NE PAS CONFONDRE :
//  - le bien appartient au compte           -> retenu
//  - le bien appartient a UN AUTRE compte   -> REFUS (c'est la tentative)
//  - le bien n'existe plus                  -> ignore silencieusement
//
// Le troisieme cas n'est pas theorique : un bien supprime laisse son UUID dans
// le perimetre du profil. Le refuser comme un bien etranger rendait ce profil
// DEFINITIVEMENT non enregistrable — la page ne propose aucune case pour un bien
// qui n'existe plus, donc aucun moyen de retirer l'identifiant fautif.
async function verifierBiens (ids, compte) {
  if (!ids.length) return { ok: true, ids: [], refs: [] }
  const { data, error } = await supabase
    .from('properties').select('id, user_id, provider_property_id').in('id', ids)
  if (error) { console.error('[membres] lecture biens', error.message); return { ok: false, code: 500 } }

  const trouves = data || []
  if (trouves.some(b => String(b.user_id) !== String(compte))) return { ok: false, code: 403 }

  const disparus = ids.filter(id => !trouves.some(b => String(b.id) === String(id)))
  if (disparus.length) console.log(`[membres] ${disparus.length} bien(s) du perimetre n'existent plus, ignore(s)`)

  return {
    ok: true,
    ids:  trouves.map(b => String(b.id)),
    refs: trouves.map(b => b.provider_property_id).filter(Boolean).map(String)
  }
}

// ⚠ Un acces par LIEN dont le perimetre se resout a zero reference est refuse.
// Deux chemins y menent : le titulaire coche « une selection » sans cocher aucun
// bien, ou les biens coches n'ont pas encore de provider_property_id. Dans les
// deux cas, ecrire une liste vide dans public_tokens signifierait « tous les
// biens » — l'exact contraire de l'intention. On le dit, plutot que de deviner.
function perimetrePwaExploitable (scope, refs) {
  // ⚠ « Tous les biens » EST refuse a la creation d'un acces par lien.
  // Dans public_tokens, une liste vide vaut « aucune restriction » : creer un
  // prestataire sans perimetre explicite lui ouvrait le planning menage de TOUS
  // les biens du compte. Un prestataire se designe bien par bien — c'est la
  // nature de son travail.
  if (scope !== 'selected') {
    return 'Choisissez les biens de ce prestataire : un accès par lien ne peut pas porter sur « tous les biens ».'
  }
  if (refs.length) return null
  return 'Sélectionnez au moins un bien déjà connecté au PMS : sans cela, ce prestataire ne pourrait voir aucun ménage.'
}

// Le profil vise appartient-il bien au compte de l'appelant ?
async function chargerCible (profileId, compte) {
  if (!profileId) return { erreur: 400 }
  const { data, error } = await supabase
    .from('profiles').select(CHAMPS_PROFIL).eq('id', profileId).maybeSingle()
  if (error) { console.error('[membres] lecture profil', error.message); return { erreur: 500 } }
  // 404 et non 403 : un profil d'un autre compte ne doit pas se distinguer d'un
  // profil inexistant.
  if (!data || String(data.account_user_id) !== String(compte)) return { erreur: 404 }
  return { profil: data }
}

// ─── Actions ─────────────────────────────────────────────────────────────────

async function lister (res, compte) {
  const { data: profils, error } = await supabase
    .from('profiles').select(CHAMPS_PROFIL)
    .eq('account_user_id', compte)
    .order('is_owner', { ascending: false })
    .order('created_at', { ascending: true })
  if (error) { console.error('[membres] list profils', error.message); return res.status(500).json({ error: 'Erreur lecture' }) }

  const ids = (profils || []).map(p => p.id)
  let droitsParProfil = {}
  if (ids.length) {
    const { data: droits, error: e2 } = await supabase
      .from('profile_permissions').select('*').in('profile_id', ids)
    if (e2) { console.error('[membres] list droits', e2.message); return res.status(500).json({ error: 'Erreur lecture' }) }
    ;(droits || []).forEach(d => { droitsParProfil[d.profile_id] = d })
  }

  const { data: biens } = await supabase
    .from('properties').select('id, name, provider_property_id').eq('user_id', compte).order('name')

  return res.status(200).json({
    profils: (profils || []).map(p => ({
      ...habiller(p),
      permissions: droitsParProfil[p.id] || null
    })),
    biens: biens || []
  })
}

// ⚠ Ni `pwa_token` ni `invite_token` ne sortent tels quels d'une LISTE : un
// jeton n'a pas a transiter tant qu'on ne l'a pas demande explicitement (action
// `lien`). On expose seulement leur existence et leur validite.
function habiller (p) {
  const { pwa_token, invite_token, ...reste } = p
  const expire = p.invite_expires_at ? new Date(p.invite_expires_at).getTime() < Date.now() : false
  return {
    ...reste,
    a_lien_pwa: !!pwa_token && p.active !== false,
    invitation_en_attente: !!invite_token && !expire,
    invitation_expiree: !!invite_token && expire,
    statut: !p.active ? 'desactive'
          : p.accepted_at ? 'actif'
          : invite_token && !expire ? 'invitation_en_attente'
          : invite_token ? 'invitation_expiree'
          : 'sans_acces'
  }
}

async function creer (req, res, compte, base) {
  const b = req.body || {}
  const prenom = String(b.first_name || '').trim()
  if (!prenom) return res.status(400).json({ error: 'Le prénom est requis' })

  const mode = b.access_mode === 'lien' ? 'lien' : 'compte'
  const email = String(b.email || '').trim() || null
  if (mode === 'compte' && !email) {
    return res.status(400).json({ error: 'Un accès par compte demande une adresse email' })
  }

  const v = validerPermissions(b.permissions, false)
  if (v.erreur) return res.status(400).json({ error: v.erreur })

  const biens = await verifierBiens(v.permissions.property_ids, compte)
  if (!biens.ok) {
    return res.status(biens.code).json({ error: biens.code === 403 ? 'Bien hors du compte' : 'Erreur lecture' })
  }

  const refusPwa = mode === 'lien' && perimetrePwaExploitable(v.permissions.property_scope, biens.refs)
  if (refusPwa) return res.status(400).json({ error: refusPwa })

  // ⚠ UN PRESTATAIRE N'A AUCUN DOMAINE, et c'est le serveur qui le garantit.
  // Le panneau masque la grille des domaines, mais `brouillon` peut encore les
  // porter : il suffit d'appliquer le modele « Employé » puis de basculer sur
  // « Lien » pour envoyer six domaines en ecriture. Ils seraient ensuite
  // INEFFACABLES — le panneau reduit ne les affiche pas, l'edition ne les envoie
  // pas, et le socle les reconduirait a chaque enregistrement.
  if (mode === 'lien') {
    for (const domaine of DOMAINES) v.permissions[domaine] = 'none'
  }

  const maintenant = new Date()
  const ligne = {
    account_user_id: compte,
    member_user_id:  null,
    first_name:      prenom,
    last_name:       String(b.last_name || '').trim() || null,
    email,
    phone:           String(b.phone || '').trim() || null,
    access_mode:     mode,
    is_owner:        false,
    active:          true
  }

  if (mode === 'compte') {
    ligne.invite_token      = nouveauJeton()
    ligne.invite_expires_at = new Date(maintenant.getTime() + JOURS_VALIDITE_INVITATION * 86400000).toISOString()
    ligne.invited_at        = maintenant.toISOString()
  } else {
    ligne.pwa_token  = nouveauJeton()
    // Un acces par lien n'a pas d'invitation a accepter : il est utilisable tout
    // de suite. `accepted_at` le dit, sinon le profil resterait « sans acces ».
    ligne.accepted_at = maintenant.toISOString()
  }

  const { data: cree, error } = await supabase.from('profiles').insert(ligne).select(CHAMPS_PROFIL).single()
  if (error) {
    console.error('[membres] create', error.message)
    return res.status(500).json({ error: 'Création impossible' })
  }

  const { error: ePerm } = await supabase.from('profile_permissions').insert({
    profile_id: cree.id, account_user_id: compte, ...v.permissions, property_ids: biens.ids
  })
  if (ePerm) {
    // ⚠ Un profil SANS ligne de droits serait un acces au comportement indefini.
    // On annule la creation plutot que de laisser cet etat.
    console.error('[membres] create droits', ePerm.message)
    await supabase.from('profiles').delete().eq('id', cree.id)
    return res.status(500).json({ error: 'Création impossible' })
  }

  if (mode === 'lien') {
    const ok = await synchroniserTokenPwa(cree, biens.refs, v.permissions.property_scope, compte)
    if (!ok) {
      await supabase.from('profile_permissions').delete().eq('profile_id', cree.id)
      await supabase.from('profiles').delete().eq('id', cree.id)
      return res.status(500).json({ error: 'Création impossible' })
    }
  }

  return res.status(200).json({
    profil: habiller(cree),
    lien: lienDAcces(cree, base)
  })
}

// La PWA prestataire lit `public_tokens`, pas `profiles`. Les deux doivent porter
// le meme jeton et le meme perimetre, sinon le prestataire a un lien qui ouvre
// sur rien — ou sur trop.
async function synchroniserTokenPwa (profil, refs, scope, compte) {
  // ⚠ REFUS D'AGIR SUR UN PROFIL DESACTIVE. Sans ce garde-fou, enregistrer un
  // droit ou regenerer un lien sur un profil coupe RECREAIT sa ligne
  // public_tokens : l'acces revenait alors que l'interface affichait toujours
  // « Désactivé », et la PWA n'interroge que public_tokens — rien n'aurait
  // rattrape l'ecart.
  if (profil.active === false) {
    console.log('[membres] profil desactive : aucune ligne PWA recreee')
    return true
  }

  const nom = [profil.first_name, profil.last_name].filter(Boolean).join(' ')
  const ligne = {
    user_id:         compte,
    token:           profil.pwa_token,
    label:           nom,
    // ⚠ SEMANTIQUE DU VIDE, INVERSEE ENTRE LES DEUX TABLES.
    // Dans public_tokens, une liste VIDE veut dire « aucune restriction », donc
    // TOUS les biens (api/menages-public.js). Dans profile_permissions, un
    // 'selected' vide veut dire ZERO bien. Ecrire l'un dans l'autre sans y penser
    // donnait a un prestataire cense voir deux biens la totalite du compte.
    // Le cas est donc REFUSE en amont (voir perimetrePwaExploitable) : on
    // n'arrive jamais ici avec `selected` et une liste vide.
    property_ids:    scope === 'selected' ? refs : [],
    visibility_days: VISIBILITE_PWA_JOURS
  }
  // ⚠ CETTE FONCTION N'EST APPELEE QU'A LA CREATION. Le jeton vient d'etre
  // genere, aucune ligne ne le porte : c'est un INSERT, pas un upsert.
  // Ailleurs — edition, reactivation, regeneration — cette page n'ecrit plus
  // `property_ids` : apps/menages/prestataires.html en est le seul writer
  // (docs/kb/coeur-de-donnees.md). `visibility_days` et `label` s'y reglent
  // aussi ; les reecrire ici ferait perdre le choix de l'hote.
  const { error } = await supabase.from('public_tokens').insert(ligne)
  if (error) { console.error('[membres] public_tokens', error.message); return false }
  return true
}

async function modifier (req, res, compte) {
  const b = req.body || {}
  const cible = await chargerCible(b.profile_id, compte)
  if (cible.erreur) return res.status(cible.erreur).json({ error: messageErreur(cible.erreur) })

  // ⚠ Le titulaire n'est pas modifiable. Il porte tous les droits par definition
  // (niveauEffectif renvoie 'write' sans meme lire son profil) : lui retirer un
  // domaine ici n'aurait aucun effet, et le desactiver le priverait de sa propre
  // page. La regle est ici, pas seulement dans le grisage de l'interface.
  if (cible.profil.is_owner) {
    return res.status(403).json({ error: 'Le profil du titulaire n’est pas modifiable' })
  }

  // ⚠ Le mode d'acces est VERROUILLE apres creation. Basculer « compte » vers
  // « lien » laisserait un member_user_id rattache sans jeton, et l'inverse
  // laisserait un jeton PWA actif sur un profil qui se connecte : deux etats que
  // rien ne sait interpreter. « Desactiver puis recreer » est la voie.
  if (b.access_mode && b.access_mode !== cible.profil.access_mode) {
    return res.status(400).json({
      error: 'Le mode d’accès ne se change pas : désactivez ce profil et créez-en un nouveau'
    })
  }

  // ⚠ Les droits DEJA enregistres servent de socle : voir validerPermissions.
  // Une panne de lecture ici ferait repartir le profil des valeurs par defaut —
  // on echoue plutot que d'ecraser.
  const { data: dejaLa, error: eDeja } = await supabase.from('profile_permissions')
    .select('*').eq('profile_id', cible.profil.id).maybeSingle()
  if (eDeja) {
    console.error('[membres] lecture droits existants', eDeja.message)
    return res.status(503).json({ error: 'Service temporairement indisponible' })
  }

  const v = validerPermissions(b.permissions, false, dejaLa)
  if (v.erreur) return res.status(400).json({ error: v.erreur })

  const biens = await verifierBiens(v.permissions.property_ids, compte)
  if (!biens.ok) {
    return res.status(biens.code).json({ error: biens.code === 403 ? 'Bien hors du compte' : 'Erreur lecture' })
  }

  // ⚠ Plus de garde de perimetre PWA a l'edition : elle n'a de sens que la ou le
  // perimetre s'ecrit, c'est-a-dire a la creation. La maintenir ici rendait un
  // profil DEFINITIVEMENT non enregistrable des que ses biens disparaissaient —
  // le panneau reduit n'offre aucune case pour en sortir, pas meme pour changer
  // un numero de telephone.

  const maj = {}
  if (b.first_name != null) {
    const prenom = String(b.first_name).trim()
    if (!prenom) return res.status(400).json({ error: 'Le prénom est requis' })
    maj.first_name = prenom
  }
  if (b.last_name != null) maj.last_name = String(b.last_name).trim() || null
  if (b.phone != null)     maj.phone     = String(b.phone).trim() || null
  // L'email n'est modifiable que tant qu'il n'identifie pas un compte auth
  // reellement rattache — c'est `member_user_id` qui le dit, pose dans le meme
  // update que `accepted_at` a l'acceptation d'une invitation.
  //
  // ⚠ LA GARDE PORTAIT SUR `accepted_at`, ET ELLE BLOQUAIT LES PRESTATAIRES.
  // Un acces par LIEN naissait `accepted_at` rempli (il est utilisable tout de
  // suite, cf. `creer`) sans jamais porter de `member_user_id` : son email
  // etait donc definitivement fige a la creation, alors qu'il n'identifie
  // aucun compte et sert uniquement a la prevenir. Pour un acces par compte,
  // rien ne change : les deux colonnes sont ecrites ensemble.
  if (b.email != null && !cible.profil.member_user_id) {
    maj.email = String(b.email).trim() || null
  }

  if (Object.keys(maj).length) {
    const { error } = await supabase.from('profiles').update(maj).eq('id', cible.profil.id)
    if (error) { console.error('[membres] update profil', error.message); return res.status(500).json({ error: 'Enregistrement impossible' }) }
  }

  // ⚠ On reecrit le perimetre NETTOYE des biens disparus, et on verifie qu'une
  // ligne a bien ete touchee : un `update` qui ne correspond a rien ne leve pas
  // d'erreur, et l'hote lisait « Droits enregistrés » sans que rien ne change.
  const { data: majDroits, error: ePerm } = await supabase.from('profile_permissions')
    .update({ ...v.permissions, property_ids: biens.ids, updated_at: new Date().toISOString() })
    .eq('profile_id', cible.profil.id)
    .select('profile_id')
  if (ePerm) { console.error('[membres] update droits', ePerm.message); return res.status(500).json({ error: 'Enregistrement impossible' }) }
  if (!majDroits || !majDroits.length) {
    console.error('[membres] aucune ligne de droits pour le profil', cible.profil.id)
    return res.status(500).json({ error: 'Enregistrement impossible : droits introuvables' })
  }

  // ⚠ UN SEUL WRITER PAR DONNEE (docs/kb/coeur-de-donnees.md).
  // `public_tokens.property_ids` appartient a apps/menages/prestataires.html,
  // qui est l'ecran d'affectation des biens. Cette page-ci n'y touche PLUS en
  // edition : elle n'affiche pas le perimetre, donc elle ne peut pas le
  // reecrire sans l'ecraser a l'aveugle. Le scenario reel : l'hote coche deux
  // biens sur huit dans la fiche prestataire, puis corrige une faute de frappe
  // sur le nom depuis /settings — et le prestataire recuperait les huit.
  //
  // Elle reste writer a la CREATION, ou il faut bien un point de depart.

  return res.status(200).json({ ok: true })
}

async function basculerActivite (req, res, compte, actif) {
  const cible = await chargerCible((req.body || {}).profile_id, compte)
  if (cible.erreur) return res.status(cible.erreur).json({ error: messageErreur(cible.erreur) })
  if (cible.profil.is_owner) {
    return res.status(403).json({ error: 'Le profil du titulaire ne peut pas être désactivé' })
  }

  const { error } = await supabase.from('profiles').update({ active: actif }).eq('id', cible.profil.id)
  if (error) { console.error('[membres] activite', error.message); return res.status(500).json({ error: 'Enregistrement impossible' }) }

  // ⚠ COUPURE IMMEDIATE, lien compris. `active = false` suffit pour un acces par
  // compte (les fonctions de droits testent `active`), mais la PWA prestataire
  // n'interroge que `public_tokens` : y laisser la ligne laisserait le lien
  // fonctionner apres la desactivation.
  if (cible.profil.access_mode === 'lien' && cible.profil.pwa_token) {
    if (!actif) {
      const { error: e2 } = await supabase.from('public_tokens').delete().eq('token', cible.profil.pwa_token)
      if (e2) {
        console.error('[membres] retrait token PWA', e2.message)
        // On REVIENT en arriere : un profil marque desactive dont le lien marche
        // encore est pire qu'un echec visible.
        await supabase.from('profiles').update({ active: true }).eq('id', cible.profil.id)
        return res.status(500).json({ error: 'Désactivation impossible : le lien n’a pas pu être coupé' })
      }
    } else {
      // ⚠ LA REACTIVATION NE DEVINE PAS LE PERIMETRE.
      // Reconstruire la ligne PWA depuis `profile_permissions` etait un
      // elargissement silencieux : l'hote coche deux biens sur huit dans la fiche
      // prestataire (qui n'ecrit que public_tokens), desactive puis reactive
      // ici — et le prestataire recuperait les huit. Un `property_scope = 'all'`
      // y ecrivait meme une liste vide, qui vaut « aucune restriction ».
      //
      // La desactivation a supprime la ligne, donc son perimetre est perdu : on
      // ne l'invente pas. Le profil redevient actif, et l'hote est renvoye vers
      // le seul ecran qui sait affecter des biens.
      console.log('[membres] reactivation : le perimetre PWA est a redefinir dans la fiche prestataire')
      return res.status(200).json({
        ok: true,
        active: true,
        avertissement: 'Profil réactivé. Ses biens doivent être redéfinis dans sa fiche prestataire : son lien ne montrera aucun ménage tant que ce n’est pas fait.'
      })
    }
  }

  return res.status(200).json({ ok: true, active: actif })
}

// Renvoie le lien EN CLAIR — action explicite, jamais dans la liste.
async function donnerLien (req, res, compte, base) {
  const cible = await chargerCible((req.query?.profile_id || (req.body || {}).profile_id), compte)
  if (cible.erreur) return res.status(cible.erreur).json({ error: messageErreur(cible.erreur) })
  const lien = lienDAcces(cible.profil, base)
  if (!lien) return res.status(404).json({ error: 'Aucun lien actif pour ce profil' })
  return res.status(200).json({ lien })
}

function lienDAcces (profil, base) {
  // ⚠ Un profil DESACTIVE n'a plus de ligne public_tokens : son pwa_token subsiste
  // mais n'ouvre plus rien. Le rendre ferait transmettre un lien mort a
  // quelqu'un, en croyant lui rendre l'acces.
  if (profil.active === false) return null
  if (profil.access_mode === 'lien' && profil.pwa_token) {
    // ⚠ `/apps/menages/public`, PAS `/apps/menages/`.
    // Le second sert index.html — le planning de l'HOTE, qui exige une session et
    // renvoie donc le prestataire vers la page de connexion. Le lien ne semblait
    // fonctionner qu'ouvert depuis la session de l'hote lui-meme : en navigation
    // privee, il aboutissait au login. C'est public.html qui lit `?token=` et
    // interroge /api/menages-public sans session — l'URL qu'utilise deja
    // apps/menages/prestataires.html.
    return `${base}/apps/menages/public?token=${encodeURIComponent(profil.pwa_token)}`
  }
  if (profil.invite_token) {
    const expire = profil.invite_expires_at && new Date(profil.invite_expires_at).getTime() < Date.now()
    if (expire) return null
    return `${base}/invitation?token=${encodeURIComponent(profil.invite_token)}`
  }
  return null
}

// Regeneration : action SEPAREE, jamais un effet de bord d'un enregistrement.
async function regenerer (req, res, compte, base) {
  const cible = await chargerCible((req.body || {}).profile_id, compte)
  if (cible.erreur) return res.status(cible.erreur).json({ error: messageErreur(cible.erreur) })
  if (cible.profil.is_owner) return res.status(403).json({ error: 'Sans objet pour le titulaire' })
  // ⚠ Regenerer sur un profil DESACTIVE recreait sa ligne public_tokens : l'acces
  // revenait sans reactivation explicite, badge « Désactivé » toujours affiche.
  if (cible.profil.active === false) {
    return res.status(409).json({ error: 'Ce profil est désactivé : réactivez-le d’abord.' })
  }

  const jeton = nouveauJeton()

  if (cible.profil.access_mode === 'lien') {
    const ancien = cible.profil.pwa_token
    const { error } = await supabase.from('profiles').update({ pwa_token: jeton }).eq('id', cible.profil.id)
    if (error) { console.error('[membres] regen pwa', error.message); return res.status(500).json({ error: 'Régénération impossible' }) }

    // ⚠ ON NE CHANGE QUE LE JETON. Reconstruire la ligne PWA depuis
    // `profile_permissions` la ferait diverger de ce que l'hote a regle dans la
    // fiche prestataire : il coche deux biens sur huit la-bas, clique
    // « Régénérer le lien » ici, et le prestataire recupere les huit. Pire, un
    // `property_scope = 'all'` y ecrivait une liste vide — qui vaut « aucune
    // restriction ». Le perimetre et la visibilite restent la ou ils sont ecrits.
    const { data: lignePwa, error: eLigne } = await supabase
      .from('public_tokens').select('id').eq('token', ancien).maybeSingle()
    if (eLigne) {
      console.error('[membres] lecture ligne PWA', eLigne.message)
      await supabase.from('profiles').update({ pwa_token: ancien }).eq('id', cible.profil.id)
      return res.status(503).json({ error: 'Service temporairement indisponible' })
    }
    if (!lignePwa) {
      await supabase.from('profiles').update({ pwa_token: ancien }).eq('id', cible.profil.id)
      return res.status(409).json({
        error: 'Ce prestataire n’a pas encore de biens affectés. Définissez-les dans sa fiche avant de régénérer son lien.'
      })
    }

    const { error: eMajToken } = await supabase.from('public_tokens')
      .update({ token: jeton }).eq('id', lignePwa.id)
    if (eMajToken) {
      console.error('[membres] regen token PWA', eMajToken.message)
      await supabase.from('profiles').update({ pwa_token: ancien }).eq('id', cible.profil.id)
      return res.status(500).json({ error: 'Régénération impossible' })
    }
    // L'ancien jeton ne doit plus ouvrir : la ligne qui le portait est retiree
    // APRES que la nouvelle est en place, pour ne jamais laisser le prestataire
    // sans acces valide entre les deux.
    // L'ancien jeton a ete REMPLACE sur la ligne existante : il n'ouvre deja plus
    // rien, et il n'y a aucune ligne orpheline a supprimer ensuite.

    return res.status(200).json({ lien: lienDAcces({ ...cible.profil, pwa_token: jeton }, base) })
  }

  // Mode compte : nouvelle invitation. Refusee si elle a deja ete acceptee — le
  // profil est rattache, il n'y a plus rien a inviter.
  if (cible.profil.accepted_at || cible.profil.member_user_id) {
    return res.status(409).json({ error: 'Ce profil a déjà rejoint le compte' })
  }
  const { error } = await supabase.from('profiles').update({
    invite_token:      jeton,
    invite_expires_at: new Date(Date.now() + JOURS_VALIDITE_INVITATION * 86400000).toISOString(),
    invited_at:        new Date().toISOString()
  }).eq('id', cible.profil.id)
  if (error) { console.error('[membres] regen invitation', error.message); return res.status(500).json({ error: 'Régénération impossible' }) }
  return res.status(200).json({ lien: lienDAcces({ ...cible.profil, invite_token: jeton, invite_expires_at: null }, base) })
}

// ─── Acceptation d'une invitation ────────────────────────────────────────────
//
// ⚠ SEULE ACTION HORS DU DOMAINE `equipe`, et c'est necessaire : celui qui
// accepte n'est PAS encore membre du compte. Il est authentifie (on sait qui il
// est), il presente un jeton, et c'est le jeton qui designe le compte — jamais
// une valeur qu'il choisirait.
async function accepter (req, res, appelant) {
  const jeton = String((req.body || {}).token || '').trim()
  if (!jeton) return res.status(400).json({ error: 'Jeton manquant' })

  const { data: profil, error } = await supabase
    .from('profiles').select(CHAMPS_PROFIL + ', account_user_id').eq('invite_token', jeton).maybeSingle()
  if (error) { console.error('[membres] accept lecture', error.message); return res.status(503).json({ error: 'Service temporairement indisponible' }) }
  if (!profil) return res.status(404).json({ error: 'Invitation introuvable ou déjà utilisée' })

  if (profil.invite_expires_at && new Date(profil.invite_expires_at).getTime() < Date.now()) {
    return res.status(410).json({ error: 'Cette invitation a expiré. Demandez-en une nouvelle.' })
  }
  if (!profil.active) return res.status(403).json({ error: 'Cette invitation a été désactivée' })

  if (String(profil.account_user_id) === String(appelant)) {
    return res.status(409).json({ error: 'Vous êtes déjà titulaire de ce compte' })
  }
  const { data: deja } = await supabase.from('profiles')
    .select('id').eq('account_user_id', profil.account_user_id).eq('member_user_id', appelant).maybeSingle()
  if (deja) return res.status(409).json({ error: 'Vous faites déjà partie de ce compte' })

  // ⚠ RATTACHEMENT ET EFFACEMENT DU JETON DANS LE MEME UPDATE, filtre sur le
  // jeton lui-meme. Deux personnes ouvrant le meme lien : la premiere modifie la
  // ligne, la seconde ne correspond plus au filtre et repart bredouille. C'est
  // aussi ce que la contrainte `profiles_invite_coherent` exige — un jeton ne
  // survit pas a l'acceptation.
  const { data: majs, error: eMaj } = await supabase.from('profiles').update({
    member_user_id:    appelant,
    accepted_at:       new Date().toISOString(),
    invite_token:      null,
    invite_expires_at: null
  }).eq('id', profil.id).eq('invite_token', jeton).select('id')

  if (eMaj) { console.error('[membres] accept update', eMaj.message); return res.status(500).json({ error: 'Acceptation impossible' }) }
  if (!majs || !majs.length) return res.status(409).json({ error: 'Invitation déjà utilisée' })

  const { data: compte } = await supabase.from('profiles')
    .select('first_name, email').eq('account_user_id', profil.account_user_id).eq('is_owner', true).maybeSingle()

  return res.status(200).json({
    ok: true,
    compte: { nom: compte?.first_name || 'ce compte', email: compte?.email || null }
  })
}

// Ce que la page d'invitation montre AVANT l'acceptation : de quel compte
// s'agit-il, et l'invitation est-elle encore valable.
//
// ⚠ N'expose QUE le prenom du titulaire et le prenom de l'invite. Celui qui
// detient le jeton peut de toute facon accepter — mais un jeton perime ou
// revoque ne doit rien reveler du tout, d'ou les memes refus que `accept`.
async function apercu (req, res) {
  const jeton = String((req.body || {}).token || '').trim()
  if (!jeton) return res.status(400).json({ error: 'Jeton manquant' })

  const { data: profil, error } = await supabase
    .from('profiles').select('id, account_user_id, first_name, active, invite_expires_at')
    .eq('invite_token', jeton).maybeSingle()
  if (error) { console.error('[membres] apercu', error.message); return res.status(503).json({ error: 'Service temporairement indisponible' }) }
  if (!profil) return res.status(404).json({ error: 'Invitation introuvable ou déjà utilisée' })
  if (!profil.active) return res.status(403).json({ error: 'Cette invitation a été désactivée' })
  if (profil.invite_expires_at && new Date(profil.invite_expires_at).getTime() < Date.now()) {
    return res.status(410).json({ error: 'Cette invitation a expiré. Demandez-en une nouvelle.' })
  }

  const { data: titulaire } = await supabase.from('profiles')
    .select('first_name, last_name').eq('account_user_id', profil.account_user_id).eq('is_owner', true).maybeSingle()

  return res.status(200).json({
    invite: profil.first_name,
    compte: [titulaire?.first_name, titulaire?.last_name].filter(Boolean).join(' ') || 'un compte HôteSmart',
    expire_le: profil.invite_expires_at
  })
}

// ─── Les comptes auxquels l'appelant a acces ─────────────────────────────────
//
// ⚠ HORS du domaine `equipe`, comme preview et accept : la question n'est pas
// « as-tu le droit de gerer une equipe » mais « de quels comptes fais-tu partie ».
// Refuser ici priverait un membre du selecteur qui lui donne acces.
//
// Ne revele QUE les comptes dont l'appelant est deja membre actif — il n'apprend
// rien qu'il ne puisse deja atteindre.
async function mesComptes (req, res, appelant) {
  // 1. Son propre compte, toujours en tete.
  const { data: sien, error: eSien } = await supabase
    .from('profiles').select('first_name, last_name, email')
    .eq('account_user_id', appelant).eq('is_owner', true).maybeSingle()
  if (eSien) { console.error('[membres] mes_comptes (sien)', eSien.message); return res.status(503).json({ error: 'Service temporairement indisponible' }) }

  const comptes = [{
    user_id: appelant,
    nom: [sien?.first_name, sien?.last_name].filter(Boolean).join(' ') || 'Mon compte',
    email: sien?.email || null,
    titulaire: true
  }]

  // 2. Les comptes ou il est membre ACTIF et ACCEPTE. Un profil desactive ou une
  //    invitation en attente ne donnent aucun acces — les inclure afficherait un
  //    compte sur lequel toutes les requetes echoueraient.
  const { data: membres, error: eMembre } = await supabase
    .from('profiles').select('account_user_id, first_name, active, accepted_at')
    .eq('member_user_id', appelant).eq('is_owner', false)
  if (eMembre) { console.error('[membres] mes_comptes (membre)', eMembre.message); return res.status(503).json({ error: 'Service temporairement indisponible' }) }

  const utiles = (membres || []).filter(m => m.active === true && m.accepted_at)
  for (const m of utiles) {
    if (String(m.account_user_id) === String(appelant)) continue
    const { data: proprio } = await supabase
      .from('profiles').select('first_name, last_name, email')
      .eq('account_user_id', m.account_user_id).eq('is_owner', true).maybeSingle()
    comptes.push({
      user_id: m.account_user_id,
      nom: [proprio?.first_name, proprio?.last_name].filter(Boolean).join(' ') || 'Compte partagé',
      email: proprio?.email || null,
      titulaire: false
    })
  }

  return res.status(200).json({ comptes })
}

function messageErreur (code) {
  return code === 400 ? 'Identifiant de profil requis'
       : code === 404 ? 'Profil introuvable'
       : 'Erreur serveur'
}

// ─── Handler ─────────────────────────────────────────────────────────────────

// ⚠ `lien` N'EST PAS UNE LECTURE. Elle rend un jeton en clair — celui qui ouvre
// la PWA d'un prestataire, ou celui qui rattache quelqu'un au compte. Classee en
// lecture, elle n'aurait exige que `equipe: 'read'`, qui est DELEGABLE (seul
// `write` ne l'est pas). Inoffensif tant qu'il n'y a pas de selecteur de compte,
// mais des l'etape 5 un membre en lecture seule obtiendrait de quoi rattacher un
// complice. Une action qui divulgue un secret d'acces exige `write`.
const LECTURE = new Set(['list'])
const ACTIONS = new Set(['list', 'lien', 'create', 'update', 'deactivate', 'reactivate', 'regenerate', 'accept', 'preview', 'mes_comptes'])

module.exports = async function handler (req, res) {
  const action = String(req.query?.action || (req.body || {}).action || '').trim()
  if (!ACTIONS.has(action)) return res.status(400).json({ error: 'Action inconnue' })

  // ⚠ `preview` PRECEDE la verification de session, et c'est tout l'enjeu du
  // parcours : l'invite qui ouvre le lien ne s'est JAMAIS connecte chez
  // HoteSmart. Exiger une session ici lui repondait 401, et la page d'invitation
  // affichait « Demandez une nouvelle invitation » au lieu de lui proposer de se
  // connecter. Le jeton EST l'autorisation : il ne revele que le prenom du
  // titulaire et celui de l'invite, a qui detient deja le lien.
  if (action === 'preview') return await apercu(req, res)

  const appelant = await verifierSession(req, res)
  if (!appelant) return

  // Base publique pour construire les liens. L'en-tete `host` vient du client :
  // on ne l'utilise QUE si aucune valeur d'environnement n'est fournie, et jamais
  // pour decider de quoi que ce soit — seulement pour afficher une URL au
  // titulaire, qui la reconnaitra.
  const base = (process.env.PUBLIC_BASE_URL || `https://${req.headers.host || 'hotesmart.vercel.app'}`)
    .replace(/\/+$/, '')

  // `accept` est hors du domaine `equipe` : celui qui l'appelle n'est pas encore
  // membre du compte. Il est authentifie, et c'est le JETON qui designe le compte.
  if (action === 'accept')      return await accepter(req, res, appelant)
  // `mes_comptes` est hors du domaine `equipe` : voir le commentaire de la
  // fonction. C'est ce qui alimente le selecteur de compte.
  if (action === 'mes_comptes') return await mesComptes(req, res, appelant)

  const garde = await requirePermission(req, res, {
    domaine: 'equipe',
    niveau: LECTURE.has(action) ? 'read' : 'write',
    userId: appelant
  })
  if (!garde.ok) return
  const compte = garde.accountUserId

  try {
    switch (action) {
      case 'list':       return await lister(res, compte)
      case 'lien':       return await donnerLien(req, res, compte, base)
      case 'create':     return await creer(req, res, compte, base)
      case 'update':     return await modifier(req, res, compte)
      case 'deactivate': return await basculerActivite(req, res, compte, false)
      case 'reactivate': return await basculerActivite(req, res, compte, true)
      case 'regenerate': return await regenerer(req, res, compte, base)
      default:           return res.status(400).json({ error: 'Action inconnue' })
    }
  } catch (e) {
    console.error('[membres]', e.message)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
}
