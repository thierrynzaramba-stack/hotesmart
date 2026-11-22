// ═══════════════════════════════════════════════════════════════════════════
// HôteSmart — « Accueil du voyageur » : une info du logement, et son éditeur
// Spec : docs/specs/spec-accueil-voyageur.md
//
// ⚠ UN SEUL MODULE POUR LES DEUX ÉCRANS QUI ÉCRIVENT CES INFOS : la fiche du
// logement (bloc « Accueil du voyageur ») et « Le remplir » sous le refus de
// « Utiliser », dans une conversation. Deux copies divergent — c'est la règle
// du dépôt, et la leçon de `shared/calendrier-resa.js`.
//
// ⚠ L'ÉTAT (« À remplir », « synchronisée », « par défaut », « Hors IA ») ARRIVE
// TOUT FAIT DU SERVEUR (`lib/connaissance.js`, `faits`) : la même règle que
// l'envoi au voyageur. Ce module ne décide rien, il peint et il écrit.
//
// Les outils (`t`, `esc`) sont injectés, comme dans `shared/logement-fiche.js` :
// un `const t` ici entrerait en conflit avec la portée de la page.
// ═══════════════════════════════════════════════════════════════════════════

export const ACC_MAX_VALEUR = 1000

// ⚠ AIRBNB : L'ARRIVÉE AU PLUS TARD À 16:00 (décision de Thierry du
// 22 novembre 2026, spec heures-logement §2.1). Un AVERTISSEMENT, jamais un
// refus : l'enregistrement reste possible. Seul endroit du dépôt qui porte
// cette limite — la fiche, qui connaît les canaux, la passe à ce module.
export const ARRIVEE_AIRBNB_MAX = '16:00'
/** L'heure d'arrivée (« HH:MM ») est-elle après la limite d'Airbnb ? */
export function arriveeApresLimiteAirbnb (heure) {
  const h = String(heure || '').trim()
  return /^\d{2}:\d{2}$/.test(h) && h > ARRIVEE_AIRBNB_MAX
}

const iconeAccueil = (id, cls = 'icon') => `<svg class="${cls}" aria-hidden="true"><use href="/shared/icons.svg#${id}"/></svg>`

/** Le libellé d'une info : son étiquette, ou la clé pour une info sans balise. */
export function libelleInfo (f) {
  return f.sansBalise ? f.cle : f.libelle
}

/**
 * La valeur telle que l'hôte la lit — et telle que le voyageur la recevra.
 * Une valeur vide AVEC une heure de la fiche ou un défaut montre ce qui partira
 * vraiment, marqué ; un vrai trou se dit « À remplir », en rouge.
 */
export function valeurInfoHtml (f, { t, esc }) {
  const vide = !String(f.valeur || '').trim()
  // ⚠ UNE HEURE DE LA FICHE ABSENTE EST « À COMPLÉTER », EN ROUGE, ET L'ÉCRAN
  // DIT CE QUE LE VOYAGEUR REÇOIT D'ICI LÀ (spec heures-logement §2.1) : le
  // défaut, qui part vraiment. Ni « À remplir » (ce n'est pas un trou), ni le
  // défaut seul (l'heure est obligatoire).
  if (f.aCompleter) {
    return `<span class="kb-fait__valeur"><span class="kb-a-remplir">${esc(t('acc.to_complete'))}</span> <span class="caption muted">${esc(t('acc.guest_gets_default', { heure: f.defaut || '' }))}</span></span>`
  }
  if (f.aRemplir) return `<span class="kb-fait__valeur kb-a-remplir">${esc(t('kb.to_fill'))}</span>`
  if (vide && f.repli) {
    return `<span class="kb-fait__valeur">${esc(f.repli)} <span class="caption muted">${esc(t('acc.synced'))}</span></span>`
  }
  if (vide && f.defaut) {
    return `<span class="kb-fait__valeur">${esc(f.defaut)} <span class="caption muted">${esc(t('kb.by_default'))}</span></span>`
  }
  return `<span class="kb-fait__valeur">${esc(f.valeur)}</span>`
}

/** Une ligne en lecture, avec son crayon quand l'hôte peut écrire.
 *  `airbnbActif` : le logement a un canal Airbnb actif et mappé (la fiche le
 *  sait, `fiche.canaux`) — l'heure d'arrivée après 16:00 s'y signale. */
export function ligneInfoHtml (f, { t, esc, peutModifier = true, airbnbActif = false }) {
  const libelle = esc(libelleInfo(f))
  const sous = f.sansBalise ? `<span class="caption muted">${esc(t('kb.ai_only'))}</span>` : ''
  const verrou = f.horsIa ? `<span class="kb-badge kb-badge--horsia">${iconeAccueil('i-lock')}${esc(t('kb.no_ai'))}</span>` : ''
  const crayon = peutModifier
    ? `<button type="button" class="kb-icone" data-acc-modifier="${esc(f.cle)}"
        aria-label="${esc(t('kb.edit_info', { info: libelleInfo(f) }))}">${iconeAccueil('i-edit')}</button>`
    : ''
  const avertissement = airbnbActif && f.cle === 'checkin' && arriveeApresLimiteAirbnb(f.valeur)
    ? `<p class="caption kb-avertissement" data-acc-airbnb>${esc(t('acc.airbnb_16h'))}</p>`
    : ''
  return `<div class="kb-fait" data-acc-ligne="${esc(f.cle)}">
      <span class="kb-fait__libelle">${libelle}${sous}</span>${valeurInfoHtml(f, { t, esc })}${verrou}${crayon}
    </div>${avertissement}`
}

/** L'éditeur d'une info, au même endroit que sa ligne. */
export function editeurInfoHtml (f, { t, esc }) {
  const id = `acc-saisie-${String(f.cle).replace(/[^a-z0-9_-]/gi, '')}`
  // ⚠ UNE HEURE DE LA FICHE SE SAISIT DANS UN CHAMP HEURE (« HH:MM »), et le
  // vide est refusé par le serveur (`heure_obligatoire`) : l'aide le dit AVANT
  // le clic, plutôt qu'une erreur générique après.
  const saisie = f.fiche
    ? `<input id="${id}" type="time" step="60" required data-acc-saisie value="${esc(f.valeur || '')}" autocomplete="off">`
    : `<input id="${id}" data-acc-saisie value="${esc(f.valeur || '')}" maxlength="${ACC_MAX_VALEUR}" autocomplete="off">`
  const aide = f.fiche ? `<p class="caption muted">${esc(t('acc.hour_required'))}</p>` : ''
  return `<div class="kb-fait kb-fait--edition" data-acc-edition="${esc(f.cle)}">
      <label class="kb-fait__libelle" for="${id}">${esc(libelleInfo(f))}</label>
      ${saisie}${aide}
      <div class="kb-actions">
        <button type="button" class="btn btn--primary" data-acc-enregistrer="${esc(f.cle)}">${esc(t('kb.save'))}</button>
        <button type="button" class="kb-lien" data-acc-annuler>${esc(t('kb.cancel'))}</button>
      </div>
    </div>`
}

/**
 * Écrit une info. ⚠ UN SEUL WRITER, CELUI DE LA BASE : le POST de
 * `api/ecran/connaissance.js` (titulaire seul, garde serveur), par la
 * bien désigné dans les biens DU COMPTE. Vider la valeur supprime la ligne.
 * @param {function} appel  `(chemin, corps) => Promise` de la page
 */
export function enregistrerInfo (appel, { ref = null, bienId = null, cle, valeur }) {
  // `bienId` (UUID) depuis la fiche, qui ne connaît pas la référence du
  // partenaire ; `ref` depuis la base de connaissance, qui la connaît.
  const designe = bienId ? { bienId: String(bienId) } : { bien: String(ref) }
  return appel('/api/ecran/connaissance', {
    action: 'enregistrer', ...designe, type: 'fixed', key: String(cle),
    value: String(valeur == null ? '' : valeur).trim()
  })
}
