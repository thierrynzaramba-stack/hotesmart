/* ============================================================================
   CE QUI ARRIVE SUR LE COMPTE DE L'HOTE — etape 4 du lot « Aujourd'hui V5 »
   (spec §4, decision Q3 de Thierry du 24 octobre 2026).

   Le bloc « Revenus nets » affiche des montants NETS : commissions deduites,
   hors taxe de sejour. Et quand la commission n'est pas connue, il affiche le
   BRUT et la ligne le DIT.

   ⚠ « BRUT MARQUE BRUT » N'EST PAS UNE TOLERANCE, C'EST LA REGLE. Le depot
   interdit deux choses a la fois : presenter un minorant comme un total, et
   rendre un `null` muet. Un net invente serait le premier ; sauter la ligne
   serait le second — et ce serait le plus couteux des deux, parce qu'un total
   auquel il manque une reservation A L'AIR JUSTE. On rend donc la valeur avec
   un drapeau, et l'ecran porte la mention.

   ⚠ CE MODULE NE CALCULE PAS LE PRIX VOYAGEUR : il l'emprunte a
   `lib/yield/eclatement.js` (`prixVoyageur`), qui le reconstruit par provider
   et par canal et retire la taxe de sejour quand le provider l'y met. Deux
   implementations du prix voyageur divergeraient, et c'est exactement la dette
   17 que le depot a deja soldee une fois (« l'ecran et le moteur passent par la
   meme assemblee »).

   ⚠ CE QUE LE COEUR SAIT DE LA COMMISSION, PAR CANAL — mesure lue dans
   `lib/yield/eclatement.js` et `docs/kb/prix-voyageur.md`, pas supposee :

     Airbnb / Channex   `amount` EST le net hote (reglage `Payout Amount`), et
                        la commission est le « Listing Cancellation Host Fee »
                        des notes. Le net est donc LU, pas calcule.
     Booking / Channex  `guest_view.total` est le prix voyageur ; la commission
                        de Booking.com N'EST PAS dans le payload. -> BRUT.
     Offline / direct   ecrit par HoteSmart (primitive CRS) : aucune
                        commission par construction. -> net = brut.
     Beds24             `price` est le prix voyageur ; `commission` est servie
                        par Beds24 quand elle existe.
   ========================================================================== */

const { prixVoyageur } = require('../yield/eclatement')

// Les quatre issues possibles, nommees — l'ecran les traduit.
const MOTIFS = {
  prix_non_calculable: 'prix_non_calculable',
  commission_inconnue: 'commission_inconnue',
  commission_aberrante: 'commission_aberrante',
  canal_inconnu: 'canal_inconnu'
}

function nombrePositif (v) {
  const x = Number(v)
  return Number.isFinite(x) && x > 0 ? x : null
}

/**
 * Ce que l'hote touche pour un sejour, hors taxe de sejour.
 *
 * @returns { valeur, net, commission, motif, source }
 *   `valeur`     en euros, ou `null` quand rien n'est calculable ;
 *   `net`        `true` = commission deduite (ou nulle par nature) ;
 *                `false` = c'est un BRUT, et la ligne doit le dire ;
 *   `commission` en euros, ou `null` quand elle n'est pas connue ;
 *   `motif`      pourquoi `valeur` est `null`, ou pourquoi `net` est `false` ;
 *   `source`     d'ou vient le chiffre, pour qu'un ecart se diagnostique.
 */
function netDuSejour (snapshot, raw, defaultProvider = null) {
  const s = snapshot || {}
  const r = raw || {}
  const provider = String(s.provider || defaultProvider || '').toLowerCase()
  const canal = String(s.source || '').trim().toLowerCase()

  const pv = prixVoyageur(s, r, defaultProvider)
  if (pv.valeur == null) {
    // ⚠ ON REPREND LE MOTIF DE L'AMONT, ON N'EN INVENTE PAS UN. `prixVoyageur`
    // a quatorze raisons de refuser, toutes precises (« Host Fee illisible
    // dans notes », « guest_view illisible sur une chambre », « taxe de sejour
    // superieure ou egale au prix »…). Les ecraser par un « prix non
    // calculable » generique ferait perdre a l'hote — et a nous — la seule
    // information qui dit OU regarder.
    return {
      valeur: null,
      net: null,
      commission: null,
      motif: MOTIFS.prix_non_calculable,
      detail: pv.raison || null,
      source: pv.source || null
    }
  }

  // ─── Airbnb par Channex : le net est LU, et la commission avec lui ────────
  if (provider === 'channex' && canal === 'airbnb') {
    // ⚠ MEME MOTIF QUE L'AMONT, ANCRE SUR LA FIN DE LIGNE, et pour la meme
    // raison : sur « 1.2.3 » une regex non ancree capture « 1.2 » et rend un
    // chiffre credible mais faux (lecon gravee dans `eclatement.js`). Ici
    // l'erreur serait pire qu'un prix faux : elle changerait la COMMISSION,
    // donc le net, donc un montant que l'hote compare a son relevé.
    const m = /Listing Cancellation Host Fee: *(\d+(?:\.\d+)?) *(?:\r?\n|$)/.exec(r.notes || '')
    const frais = m ? Number(m[1]) : null
    if (frais == null || !Number.isFinite(frais) || frais < 0) {
      // Impossible en pratique — `prixVoyageur` a deja refuse ce cas et nous
      // ne serions pas ici. On le traite quand meme : une garde qui depend du
      // refus d'une AUTRE fonction n'est pas une garde, c'est un couplage.
      return {
        valeur: pv.valeur,
        net: false,
        commission: null,
        motif: MOTIFS.commission_inconnue,
        detail: 'Host Fee illisible dans notes',
        source: pv.source
      }
    }
    // ⚠ ICI, LE NET EST `amount` PAR CONSTRUCTION, ET IL N'Y A PAS DE GARDE A
    // POSER — mesure faite avant d'ecrire cette ligne, parce que j'avais
    // commence par en poser une et par affirmer qu'elle protegeait d'un net
    // negatif. ELLE NE PEUT PAS MORDRE : `prixVoyageur` rend ici
    // `amount + frais`, donc le prix est TOUJOURS superieur aux frais des que
    // `amount > 0` — et `amount <= 0` est deja refuse en amont. Mesure :
    //   amount 10,00 / fee 500,00  -> prix 510, fee >= prix ? false
    //   amount  0,01 / fee 9999,00 -> prix 9999,01, fee >= prix ? false
    // Une garde inatteignable dont le commentaire jure qu'elle protege est
    // exactement le defaut que ce depot passe son temps a corriger : elle ne
    // rougira jamais, et elle fait croire que la question est traitee.
    // Le controle de coherence qui MORD vit chez Beds24, plus bas, ou
    // `price - commission` peut reellement passer sous zero.
    //
    // ⚠ ET UN RATIO ABERRANT — 98 % de commission — N'EST PAS REFUSE ICI, c'est
    // assume : nous n'avons pas de seuil mesure, et inventer « au-dela de
    // 30 %, refus » ferait disparaitre d'un total un sejour dont le net est
    // peut-etre juste. Le chiffre rendu reste `amount`, c'est-a-dire ce
    // qu'Airbnb dit verser. Le rapprochement avec le versement REEL est la
    // dette 95.
    return {
      valeur: Math.round((pv.valeur - frais) * 100) / 100,
      net: true,
      commission: frais,
      motif: null,
      source: `${pv.source} - Host Fee`
    }
  }

  // ─── Booking.com par Channex : la commission n'est pas transmise ──────────
  if (provider === 'channex' && (canal === 'bookingcom' || canal === 'booking.com')) {
    // ⚠ ET ON NE LA DEVINE PAS A 15 %. C'est la tentation de ce bloc : le taux
    // Booking.com est connu du metier, donc « on sait a peu pres ». Mais un
    // taux negocie, une promotion Genius, un programme de visibilite le
    // changent par bien et par periode — et un net approche presente comme un
    // net serait exactement ce que la regle du depot interdit. Brut, marque
    // brut. La dette 95 porte le rapprochement avec les versements reels.
    return {
      valeur: pv.valeur,
      net: false,
      commission: null,
      motif: MOTIFS.commission_inconnue,
      detail: 'Booking.com ne transmet pas sa commission',
      source: pv.source
    }
  }

  // ─── Vente directe : aucune commission, par construction ─────────────────
  if (provider === 'channex' && canal === 'offline') {
    // `net: true` AVEC une commission a zero, et ce n'est pas la meme chose
    // qu'une commission inconnue : ici nous avons ecrit la reservation
    // nous-memes (primitive CRS), donc personne ne preleve rien. Le dire
    // « brut » ferait porter a l'hote un doute qui n'existe pas.
    return { valeur: pv.valeur, net: true, commission: 0, motif: null, source: pv.source }
  }

  // ─── Beds24 : la commission est servie quand elle existe ─────────────────
  if (provider === 'beds24') {
    const com = nombrePositif(r.commission)
    if (com == null) {
      // ⚠ UNE COMMISSION A ZERO N'EST PAS LA MEME CHOSE SUR UN CANAL DIRECT ET
      // SUR UNE OTA, et `eclatement.js` a deja gravé la distinction : « une
      // resa OTA dont Beds24 remet price et commission a zero » existe, et
      // prendre son zero pour une absence de commission transformerait un
      // brut en net. Direct -> net (personne ne preleve) ; OTA -> brut.
      return canal === 'direct'
        ? { valeur: pv.valeur, net: true, commission: 0, motif: null, source: pv.source }
        : {
            valeur: pv.valeur,
            net: false,
            commission: null,
            motif: MOTIFS.commission_inconnue,
            detail: `Beds24 ne sert aucune commission pour « ${canal || 'canal vide'} »`,
            source: pv.source
          }
    }
    // ⚠ LA SEULE GARDE DE COHERENCE QUI MORD REELLEMENT, et c'est pour ca
    // qu'elle est ici et pas chez Airbnb : `prixVoyageur` rend `price`, et
    // `commission` est servie a cote, donc la soustraction PEUT passer sous
    // zero. Mesure : price 100 / commission 150 -> refus ; 100 / 100 -> refus ;
    // 100 / 30 -> net 70. Un net negatif qu'un total absorberait ne se voit
    // pas dans une somme de six chiffres.
    if (com >= pv.valeur) {
      return {
        valeur: null,
        net: null,
        commission: null,
        motif: MOTIFS.commission_aberrante,
        detail: `commission ${com} >= prix voyageur ${pv.valeur}`,
        source: pv.source
      }
    }
    return {
      valeur: Math.round((pv.valeur - com) * 100) / 100,
      net: true,
      commission: com,
      motif: null,
      source: `${pv.source} - commission`
    }
  }

  // ⚠ UN COUPLE (provider, canal) NON PREVU ECHOUE BRUYAMMENT — regle de
  // `eclatement.js`, reprise ici dans l'esprit. Rendre le prix voyageur « en
  // brut » pour un canal inconnu serait un repli silencieux : si ce canal sert
  // un net hote, le chiffre est deja un net, et l'afficher comme un brut invite
  // a lui retirer une commission une seconde fois.
  //
  // ⚠ ET CE RETOUR EST INATTEIGNABLE AUJOURD'HUI, mesure : `prixVoyageur`
  // refuse en amont tout couple qu'il ne connait pas (« canal non prevu :
  // expedia », « provider inconnu »), et les quatre qu'il accepte sont tous
  // traites au-dessus. On arrive donc ici avec un `motif`
  // `prix_non_calculable` et non `canal_inconnu`.
  // Il reste, et ce n'est pas une contradiction avec ce que je viens
  // d'ecrire sur la garde d'Airbnb : la difference est qu'une garde
  // inatteignable DONT ON AFFIRME QU'ELLE PROTEGE est un mensonge, alors qu'un
  // filet dont on DIT qu'il ne sert pas encore est une precaution. Le jour ou
  // `prixVoyageur` apprend un cinquieme canal, ce module ne le suivra pas tout
  // seul — et c'est cette ligne qui le dira au lieu de rendre un brut faux.
  // ⚠ ET CE N'EST PAS CE CHEMIN QUE LE TEST GARDE — j'avais ecrit ici qu'il
  // « verifie que le motif est bien inatteignable », ce qui etait faux : un
  // chemin mort ne se garde pas, puisque aucun appel ne l'atteint (mesure par
  // mutation : le remplacer par un repli sur le brut laisse la suite au vert).
  // Ce que `tests/revenus-net-hote.test.js` garde est l'INVARIANT qui compte —
  // tout prix calculable repart avec une etiquette `net` ou `brut`, jamais
  // `null` — sur 300 combinaisons de provider, de canal et de payload, dont
  // 40 calculables, compte FIGE. Si `prixVoyageur` apprend un cinquieme canal
  // et que ce module ne le suit pas, c'est ce compte qui bouge et qui parle.
  return {
    valeur: null,
    net: null,
    commission: null,
    motif: MOTIFS.canal_inconnu,
    detail: `${provider || 'provider vide'} / ${canal || 'canal vide'}`,
    source: pv.source || null
  }
}

module.exports = { netDuSejour, MOTIFS }
