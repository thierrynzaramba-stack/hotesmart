/* ============================================================================
   Le bloc « Derniers avis » de l'accueil — spec-aujourdhui-v5.md §3, etape 2.

   ⚠ ICI ET PAS DANS LA BALISE `<script>` DE LA PAGE, pour la raison que le lot
   Logements a deja payee : un rendu ecrit dans un fichier HTML ne se teste
   qu'en extrayant son code a la regex, et ce test passe le jour ou la page
   bouge. Le module rend des chaines, ne connait ni `window.I18n` ni le DOM, et
   recoit ses outils (`t`, `esc`, `icone`, `nombre`, `dateEnClair`).

   ⚠ CE BLOC NE PORTE AUCUNE ACTION (spec §3) : ni repondre, ni evaluer. C'est
   un RESUME, et le geste vit sur la page Avis. Une carte cliquable ici
   ouvrirait une page que ce lot ne livre pas.
   ========================================================================== */

// Les CINQ etats d'un bloc de l'accueil, dans l'ordre ou on les tranche.
// `refus` et `inconnu` ne sont PAS des etats rendus : dans les deux cas le bloc
// ne figure pas dans le DOM (regle absolue du depot, et spec §6). Ils sont ici
// pour que l'appelant les nomme, pas pour qu'il les affiche.
//
// ⚠ `inconnu` A ETE AJOUTE LE 25 OCTOBRE 2026 : il distingue « le serveur n'a
// pas pu lire » (illisible, qui se DIT) de « on n'a pas encore demande » — le
// premier affichage, qui vient du cache et ne porte plus ce bloc depuis que les
// avis en sont retires. Les confondre afficherait « Les avis ne sont pas
// lisibles » a chaque ouverture, pendant un aller-retour, sur une donnee qui
// arrive une seconde plus tard.
export const ETATS = ['refus', 'inconnu', 'illisible', 'vide', 'liste']

/**
 * La VUE du bloc, sans une ligne de HTML : ce qu'on sait, et ce qu'on en dit.
 *
 * @param derniers  la liste descendue par l'endpoint, `null` si illisible
 * @param notes     `{ global: { note_sur_5, notes } }`, `null` si illisible
 * @param biens     la liste des biens de l'ecran, pour retrouver nom et photo
 * @param refuse    vrai quand le profil n'a pas le droit `avis`
 */
export function vueDesAvis ({ derniers, notes, biens = [], refuse = false,
                             connu = true, perimetreVide = false } = {}) {
  const rien = (etat) => ({ etat, cartes: [], note_sur_5: null, nombre: null })
  if (refuse) return rien('refus')
  // ⚠ UN PERIMETRE VIDE N'A PAS « PAS ENCORE D'AVIS », IL N'A PAS DE LOGEMENT.
  // Un membre delegue a qui aucun bien n'est confie lisait « Pas encore d'avis
  // sur 30 jours » — une phrase qui parle d'absence d'avis la ou il y a absence
  // de BIENS. C'est l'injonction symetrique de « Ajoutez votre premier
  // logement », fermee le meme jour sur le bloc des logements.
  if (perimetreVide) return rien('vide_perimetre')
  // Rien n'a encore ete demande (premier affichage depuis le cache) : on se
  // tait. Voir le commentaire d'`ETATS`.
  if (!connu) return rien('inconnu')
  // ⚠ `null` N'EST PAS `[]`, ET C'EST TOUT L'ECART QUI COMPTE ICI. L'endpoint
  // rend `null` quand il n'a PAS PU lire : afficher « Pas encore d'avis »
  // serait affirmer une absence a un hote qui en a trois cent trente-six.
  if (!Array.isArray(derniers)) return rien('illisible')

  // La moyenne et le compte viennent de l'AUTRE lecture (`notes`), qui peut
  // echouer seule : on rend alors les commentaires sans l'en-tete chiffre.
  const g = (notes && notes.global && typeof notes.global === 'object') ? notes.global : null
  const note = g && g.note_sur_5 != null ? g.note_sur_5 : null
  // ⚠ CE NOMBRE COMPTE LES AVIS **NOTES**, ET LE LIBELLE LE DIT DEPUIS LE
  // 25 OCTOBRE 2026 (constat de la revue). Il disait « N avis sur 30 jours »
  // la ou il compte les avis NOTES : deux populations sous un seul mot, et
  // c'est le defaut que `lib/logement/lecture.js` nomme en toutes lettres
  // (« 336 avis visibles dont 332 notes »). C'est celui qui va avec la
  // moyenne affichee a cote. `notesDuPerimetre` ne rend que ceux-la ; un
  // logement peut porter des avis sans note (une detection dans les messages,
  // une saisie manuelle sans etoile). Afficher le total des avis a cote d'une
  // moyenne calculee sur un sous-ensemble ferait deux chiffres qui ne parlent
  // pas de la meme population — le defaut que `lib/logement/lecture.js` nomme
  // en toutes lettres (« 336 avis visibles dont 332 notes »).
  const nombre = g && Number.isFinite(Number(g.notes)) ? Number(g.notes) : null

  // Le bien de chaque avis : la cle est `property_id_ref`, la cle PROVIDER,
  // jamais l'UUID (CLAUDE.md : « ne JAMAIS joindre naivement uuid vs text »).
  const parRef = new Map()
  for (const b of biens) {
    if (b && b.provider_property_id != null) parRef.set(String(b.provider_property_id), b)
  }
  const cartes = derniers.map(a => {
    const bien = a && a.bien_ref != null ? parRef.get(String(a.bien_ref)) : null
    return {
      id: a.id,
      // ⚠ UN BIEN INTROUVABLE NE FAIT PAS DISPARAITRE L'AVIS. `property_id_ref`
      // n'a pas de cle etrangere : un re-keying ou un bien supprime laisse des
      // avis dont la reference ne designe plus rien (avis-voyageurs.md §15).
      // La carte se rend alors sans nom de logement, plutot que de se taire.
      bien: bien ? (bien.name || null) : null,
      photo: bien ? (bien.photo_url || null) : null,
      ota: a.ota || null,
      recu_le: a.recu_le || null,
      note_sur_5: a.note_sur_5 == null ? null : a.note_sur_5,
      texte: a.texte || '',
      voyageur: a.voyageur || null
    }
  }).filter(c => c.texte)

  return { etat: cartes.length ? 'liste' : 'vide', cartes, note_sur_5: note, nombre }
}

// La ligne de contexte d'une carte : « La bulle · Airbnb · 12 octobre ».
// Les morceaux absents disparaissent, le separateur ne reste jamais seul.
// Les etats qui ne rendent RIEN — ni carte, ni phrase, ni en-tete.
export const MUETS = new Set(['refus', 'inconnu', 'vide_perimetre'])

export function contexteDeLaCarte (carte, { t, libelleDuCanal, dateEnClair }) {
  const bouts = []
  if (carte.bien) bouts.push(carte.bien)
  const canal = carte.ota ? libelleDuCanal({ ota: carte.ota }) : null
  if (canal) bouts.push(canal)
  if (carte.recu_le) bouts.push(dateEnClair(carte.recu_le))
  return bouts.join(' · ')
}

export function carteAvisHtml (carte, outils) {
  const { t, esc, icone, nombre } = outils
  // ⚠ PAS D'ETOILES, JAMAIS (spec §3). La note se lit « 4,6 / 5 », en chiffres :
  // une rangee d'etoiles demande de les compter pour lire une note, et une
  // demi-etoile ne se lit pas du tout a la voix.
  const note = carte.note_sur_5 == null ? ''
    : `<span class="avis-note num">${esc(t('reviews.score', { n: nombre(carte.note_sur_5, 1) }))}</span>`
  const photo = carte.photo
    ? `<span class="avis-photo"><img src="${esc(carte.photo)}" alt="" loading="lazy"></span>`
    : `<span class="avis-photo avis-photo--none">${icone('i-home')}</span>`
  // Le voyageur peut manquer : le profil n'a pas le droit `reservations`, ou
  // le canal n'a pas transmis de nom. On montre alors le logement seul.
  const qui = carte.voyageur
    ? `<span class="avis-qui">${esc(carte.voyageur)}</span>`
    : ''
  return `<article class="avis-carte" data-avis="${esc(carte.id)}">
    <span class="avis-tete">
      ${photo}
      <span class="avis-ident">
        ${qui}
        <span class="caption muted">${esc(contexteDeLaCarte(carte, outils))}</span>
      </span>
      ${note}
    </span>
    <p class="avis-texte clamp-3">${esc(carte.texte)}</p>
  </article>`
}

/**
 * Le bloc entier. Rend `''` sur un refus : l'appelant masque la section, et
 * rien de ce qui mene a un refus n'entre dans le DOM.
 */
// ⚠ LES ETATS MUETS RENDENT LA CHAINE VIDE, ET L'APPELANT DOIT L'ECRIRE.
// Masquer la section ne suffit pas : `hidden` cache, il n'efface pas, et des
// cartes laissees dans le DOM restent lisibles dans la source — exactement ce
// que la regle « on ne montre jamais ce qui mene a un refus » interdit. Le cas
// reel : un premier affichage rend les cartes, puis la reponse du serveur
// refuse le droit. Mesure du 25 octobre 2026 : la section passait a `hidden`
// et portait toujours ses trois cartes et sa moyenne.
export function blocAvisHtml (vue, outils) {
  const { t, esc, nombre } = outils
  if (MUETS.has(vue.etat)) return ''
  if (vue.etat === 'illisible') return `<p class="muted">${esc(t('reviews.unavailable'))}</p>`
  if (vue.etat === 'vide') return `<p class="muted">${esc(t('reviews.empty'))}</p>`
  return vue.cartes.map(c => carteAvisHtml(c, outils)).join('')
}

/** L'en-tete chiffre : la moyenne et le nombre, ou rien du tout. */
export function enTeteAvisHtml (vue, outils) {
  const { t, esc, nombre } = outils
  if (MUETS.has(vue.etat) || vue.note_sur_5 == null) return ''
  const n = vue.nombre == null ? '' : `<span class="muted small">${esc(t('reviews.count_30d', { n: vue.nombre }))}</span>`
  return `<span class="avis-moyenne num">${esc(t('reviews.score', { n: nombre(vue.note_sur_5, 1) }))}</span>${n}`
}
