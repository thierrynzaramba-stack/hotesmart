// ═══════════════════════════════════════════════════════════════════════════
// HôteSmart — Les heures d'arrivée et de départ d'un logement : leur FORME
// Spec : docs/specs/spec-heures-logement.md (S5)
//
// ⚠ UNE SEULE FORME ENREGISTRÉE : « HH:MM » (00:00 à 23:59). Les colonnes
// `properties.checkin_time` / `checkout_time` sont en texte libre, et le dépôt
// en a lu au moins quatre formes (« 16:00 », « 16:00:00 », « 16h »,
// « 16h30 ») — chaque lecteur refaisait sa propre lecture, et l'alerte du
// ménage n'en comprenait qu'une partie. Le writer (`api/ecran/connaissance.js`)
// et la reprise (`scripts/reprendre-heures-fiche.js`) passent par ici : ce
// qui entre en base est toujours « HH:MM ».
//
// ⚠ UNE FORME ILLISIBLE REND `null`, JAMAIS UNE HEURE DEVINÉE. « 4pm »,
// « 25:00 », « midi » : on ne sait pas, donc on le dit (refus au writer,
// signalement à la reprise).
// ═══════════════════════════════════════════════════════════════════════════

const deux = (n) => String(n).padStart(2, '0')

/**
 * « 16:00 », « 16:00:00 », « 9:5 » refusé, « 16h », « 16h30 », « 16 h 30 »
 * → « HH:MM », ou `null` si la forme n'est pas lisible sans deviner.
 */
function normaliserHeure (brut) {
  if (brut == null) return null
  const s = String(brut).trim().toLowerCase()
  if (!s) return null
  const m = /^(\d{1,2})\s*(?::\s*(\d{2})(?::\d{2})?|h\s*(\d{2})?)$/.exec(s)
  if (!m) return null
  const h = Number(m[1])
  const mn = m[2] != null ? Number(m[2]) : (m[3] != null ? Number(m[3]) : 0)
  if (!Number.isInteger(h) || !Number.isInteger(mn) || h > 23 || mn > 59) return null
  return `${deux(h)}:${deux(mn)}`
}

// Les deux clés de la fiche, et leur colonne. Une seule table de
// correspondance : le writer et la reprise ne la recopient pas.
const COLONNE_HEURE = { checkin: 'checkin_time', checkout: 'checkout_time' }
const estCleHeure = (cle) => Object.prototype.hasOwnProperty.call(COLONNE_HEURE, cle)

/**
 * Le plan de la reprise base → fiche (spec heures-logement §4, S6), PUR : il
 * ne lit ni n'écrit rien, il dit ce que `scripts/reprendre-heures-fiche.js`
 * fera — à blanc comme pour de vrai, c'est la MÊME décision.
 *
 * Par logement EN SERVICE et par heure :
 *   - `copier`     : la base a une heure lisible, la fiche est vide ;
 *   - `identique`  : même heure des deux côtés (la ligne de base part) ;
 *   - `ecart`      : deux heures différentes — l'heure tapée par l'hôte dans le
 *                    bloc (la base) l'emporte (décision 3 du 22 novembre 2026),
 *                    et l'écart est MONTRÉ avant tout `--go` ;
 *   - `illisible`  : la base porte une forme qu'on ne lit pas — rien n'est
 *                    écrit ni supprimé, on le montre ;
 *   - `normaliser` : pas de ligne de base, une heure de fiche lisible mais pas
 *                    au format « HH:MM » (« 16:00:00 » de Beds24) ;
 *   - `fiche_illisible` : pas de ligne de base, une fiche illisible — montrée ;
 *   - `a_completer`: rien nulle part — la fiche dira « À compléter » ;
 *   - `rien`       : la fiche porte déjà « HH:MM », aucune ligne de base.
 * `ecrire` : la valeur à poser en fiche (ou `null`) ; `supprimerLigne` : l'id
 * de la ligne de base à retirer APRÈS l'écriture (ou `null`) ; `ficheBrute` :
 * ce que la fiche valait à la lecture, que l'écriture exige encore (une heure
 * saisie entre-temps n'est jamais écrasée) ; `horsIa` : la ligne de base était
 * cachée à l'IA — la supprimer lui rend l'heure, donc on le MONTRE (S6).
 * `orphelines` : les lignes d'heure de la base sans logement du compte.
 *
 * ⚠ UN LOGEMENT ARCHIVÉ N'EST PAS TOUCHÉ (il ne loue plus, et sa fiche se lit
 * sans crayon) : il est compté à part, ses lignes restent.
 * ⚠ LES LIGNES SONT RAPPROCHÉES PAR LA RÉFÉRENCE DU PARTENAIRE ET LE COMPTE
 * (`knowledge.property_id` est du texte : jamais l'UUID du bien).
 */
function planDeReprise ({ biens = [], lignes = [] } = {}) {
  const cleLigne = (userId, ref, cle) => `${userId}|${ref}|${cle}`
  const parCle = new Map()
  for (const l of lignes) {
    if (!l || l.type !== 'fixed' || !estCleHeure(l.key)) continue
    parCle.set(cleLigne(l.user_id, String(l.property_id), l.key), l)
  }
  const connues = new Set()
  for (const b of biens) {
    if (b && b.provider_property_id != null) {
      for (const cle of Object.keys(COLONNE_HEURE)) connues.add(cleLigne(b.user_id, String(b.provider_property_id), cle))
    }
  }
  const orphelines = [...parCle.keys()].filter(k => !connues.has(k)).length
  const plan = []
  const archives = []
  for (const b of biens) {
    if (!b || b.provider_property_id == null) continue
    if (b.archive_le) { archives.push(b); continue }
    const ref = String(b.provider_property_id)
    const heures = {}
    for (const cle of Object.keys(COLONNE_HEURE)) {
      const ligne = parCle.get(cleLigne(b.user_id, ref, cle)) || null
      const ficheBrute = b[COLONNE_HEURE[cle]]
      const ficheVide = !(ficheBrute != null && String(ficheBrute).trim())
      const fiche = normaliserHeure(ficheBrute)
      const base = ligne ? normaliserHeure(ligne.value) : null
      let action
      let ecrire = null
      let supprimerLigne = null
      if (ligne) {
        if (!base) action = 'illisible'
        else {
          supprimerLigne = ligne.id
          if (ficheVide) { action = 'copier'; ecrire = base }
          else if (fiche === base) { action = 'identique'; ecrire = ficheBrute === base ? null : base }
          else { action = 'ecart'; ecrire = base }
        }
      } else if (ficheVide) action = 'a_completer'
      else if (!fiche) action = 'fiche_illisible'
      else if (ficheBrute !== fiche) { action = 'normaliser'; ecrire = fiche }
      else action = 'rien'
      heures[cle] = {
        action, ecrire, supprimerLigne,
        fiche: ficheVide ? null : String(ficheBrute),
        ficheBrute: ficheBrute == null ? null : String(ficheBrute),
        base: ligne ? String(ligne.value) : null,
        horsIa: !!(ligne && ligne.lisible_par_ia === false)
      }
    }
    plan.push({ id: b.id, userId: b.user_id, nom: b.name || ref, ref, heures })
  }
  return { plan, archives: archives.length, orphelines }
}

/**
 * Exécute le plan (`scripts/reprendre-heures-fiche.js`). Séparé du script pour
 * être éprouvé avec un double de Supabase.
 * `supprimer: false` : la COPIE SEULE — avant le merge (§4, ordre des gestes) :
 * l'ancien code lit encore la base, rien ne change pour le voyageur ; aucune
 * ligne n'est retirée.
 *
 * ⚠ ORDRE : la fiche d'abord, la ligne de base ENSUITE, et seulement si la
 * fiche a été écrite (ou n'avait rien à écrire).
 * ⚠ L'ÉCRITURE EXIGE QUE LA FICHE VAILLE ENCORE EXACTEMENT CE QUE LE PLAN A LU
 * (constat 8 de la relecture 1, constat 4 de la relecture 2) : `null` ou la
 * valeur brute lue. Une heure écrite entre la lecture et l'écriture n'est
 * jamais écrasée — le geste ne trouve aucune ligne, la ligne de base reste, et
 * on le dit.
 * ⚠ CETTE CONDITION NE COUVRE QUE L'INSTANT DE LA LECTURE (constat 1 de la
 * relecture 2). Ce qui protège une heure tapée dans le bloc APRÈS le
 * déploiement, c'est le writer de l'heure (`api/ecran/connaissance.js`) : il
 * retire la ligne de base de cette heure avant d'écrire la fiche, donc la
 * reprise n'a plus rien à remettre. Un `ecart` qui reste au `--go` est donc
 * un écart d'AVANT le lot, ou une heure Beds24 que l'ancienne synchro a
 * réécrite en fiche : dans les deux cas l'heure tapée par l'hôte (la base)
 * l'emporte (décisions 2 et 3).
 */
async function executerReprise (sb, plan, { supprimer = true } = {}) {
  const bilan = { ecrites: 0, supprimees: 0, sautees: [], echecs: [] }
  for (const b of plan) {
    for (const [cle, h] of Object.entries(b.heures)) {
      const colonne = COLONNE_HEURE[cle]
      let ficheOk = true
      if (h.ecrire) {
        let q = sb.from('properties').update({ [colonne]: h.ecrire })
          .eq('id', b.id).eq('user_id', b.userId).is('archive_le', null)
        // ⚠ LA VALEUR LUE ELLE-MÊME, POUR TOUTES LES ACTIONS (constat 4 de la
        // relecture 2) : une fiche faite d'espaces est « vide » pour le plan,
        // mais `.or(is.null,eq.)` ne la retenait pas — le geste était sauté à
        // chaque passage, avec un faux motif.
        q = h.ficheBrute == null ? q.is(colonne, null) : q.eq(colonne, h.ficheBrute)
        const { data, error } = await q.select('id').maybeSingle()
        if (error) { ficheOk = false; bilan.echecs.push(`${b.nom} (${cle}) : ${error.message}`) }
        else if (!data) { ficheOk = false; bilan.sautees.push(`${b.nom} (${cle}) : la fiche a changé depuis la lecture (ou le logement est archivé), rien n'est écrit et la ligne de base reste`) }
        else bilan.ecrites++
      }
      if (supprimer && ficheOk && h.supprimerLigne != null) {
        const { error } = await sb.from('knowledge').delete()
          .eq('id', h.supprimerLigne).eq('user_id', b.userId).eq('property_id', b.ref)
        if (error) bilan.echecs.push(`${b.nom} (${cle}) base : ${error.message}`)
        else bilan.supprimees++
      }
    }
  }
  return bilan
}

module.exports = { normaliserHeure, COLONNE_HEURE, estCleHeure, planDeReprise, executerReprise }
