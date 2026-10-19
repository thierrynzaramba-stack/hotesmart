/* ============================================================
   HôteSmart — nav.js
   Construit la barre du haut et la barre du bas depuis UNE liste.
   Ajouter une rubrique = une ligne ici (mais la navigation est
   définitive : 5 entrées, voir spec §3).

   ⚠ UNE ENTRÉE MÈNE À SON ÉCRAN V5 DÈS QU'IL EXISTE. « Aujourd'hui »,
   « Calendrier », « Messages » et « Ménages » sont refondus ; seule
   « Mes biens » mène encore à l'écran ACTUEL, jusqu'au lot Logements
   (spec §7). `hrefMobile` : l'écran téléphone quand il en existe un
   distinct.

   ⚠ CE QUE LE MÉCANISME `liens` A COÛTÉ, ET POURQUOI IL N'EST PLUS LÀ.
   Au lot 1 (257b59d, 10 octobre 2026), l'écran calendrier V5 n'existait
   pas : l'entrée retombait sur `/biens`, et chaque page pouvait fournir
   le lien exact (`liens`) — le calendrier du premier bien. UNE SEULE le
   faisait, « Aujourd'hui ». Le lot 3 a livré `/calendrier` (c8e7dff,
   12 octobre) sans revenir ici.
   Le défaut a donc vécu EN PRODUCTION du 12 au 19 octobre : depuis
   Messages (livrée le 11) et Calendrier, puis depuis Ménages (livrée le
   13), « Calendrier » et « Mes biens » menaient AU MÊME ÉCRAN — deux
   onglets sur cinq au même endroit, et aucun vers le calendrier.
   Le téléphone n'a jamais pointé sur `/biens`, mais il n'était pas juste
   pour autant : `/m/calendrier` a mené à l'ANCIEN calendrier téléphone
   jusqu'à 6f3d6af (13 octobre), qui a fait des anciennes pages des
   redirections vers `/calendrier`.
   La leçon n'est pas « il fallait y penser » : un repli que UNE SEULE
   page corrige est un piège qui attend. L'entrée porte maintenant sa
   vraie destination, la même pour toutes les pages, et
   `tests/nav-v5-destinations.test.js` le tient.
   ============================================================ */
(() => {
  const NAV = [
    { id: 'today',      href: '/pages/aujourdhui',          key: 'nav.today',      icon: 'i-today' },
    { id: 'calendar',   href: '/calendrier',                key: 'nav.calendar',   icon: 'i-calendar', hrefMobile: '/m/calendrier', domaine: 'reservations' },
    { id: 'messages',   href: '/pages/messages',            key: 'nav.messages',   icon: 'i-message', badge: 'pendingMessages', domaine: 'messages' },
    { id: 'cleaning',   href: '/menages',                   key: 'nav.cleaning',   icon: 'i-cleaning', badge: 'menagesATraiter', domaine: 'menages' },
    { id: 'properties', href: '/biens',                     key: 'nav.properties', icon: 'i-home', domaine: 'reservations' },
  ];

  const icon = (id, cls = 'icon') => `<svg class="${cls}" aria-hidden="true"><use href="/shared/icons.svg#${id}"/></svg>`;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isCurrent = (href) => location.pathname.replace(/\/$/, '').endsWith(href.replace(/\/$/, ''));

  // options.badges : { pendingMessages: n, menagesATraiter: n }
  // options.peutLire(domaine) : masque une entrée sans droit (jamais une
  //   entrée qui mène à une page vide ou à un refus).
  function render(options = {}) {
    const badges = options.badges || {};
    const peutLire = options.peutLire || (() => true);
    const top = document.querySelector('.topbar__nav');
    const bottom = document.querySelector('.bottombar');
    const items = NAV.filter(n => !n.domaine || peutLire(n.domaine)).map(n => {
      const href = n.href;
      // ⚠ L'ONGLET COURANT SE MARQUE SUR TOUTES LES ENTRÉES (constat de la
      // revue de 5de081b). La restriction à « Aujourd'hui » n'était pas un
      // choix de design : elle existait PARCE QUE `calendar` et `properties`
      // menaient tous deux à `/biens` — la lever alors aurait marqué DEUX
      // onglets courants. Le repli parti, la cause l'est aussi, et l'hôte
      // retrouve sur Calendrier, Messages et Ménages la pastille que
      // `shared/ui.css` dessine depuis le socle et que personne ne voyait.
      const cur = isCurrent(n.href) ? ' aria-current="page"' : '';
      const count = n.badge ? badges[n.badge] : 0;
      const badge = count ? `<span class="badge badge--amber">${esc(count)}</span>` : '';
      return { n, href, hrefMobile: n.hrefMobile || href, cur, badge };
    });
    if (top) top.innerHTML = items.map(({ n, href, cur, badge }) =>
      `<a class="tab" href="${esc(href)}"${cur}><span data-i18n="${n.key}"></span>${badge}</a>`).join('');
    if (bottom) bottom.innerHTML = items.map(({ n, hrefMobile, cur, badge }) =>
      `<a href="${esc(hrefMobile)}"${cur}>${icon(n.icon)}<span data-i18n="${n.key}"></span>${badge}</a>`).join('');
    window.I18n?.apply(top?.parentElement || document);
    window.I18n?.apply(bottom || document);
  }

  // Sélecteur de langue construit depuis langues.json (jamais codé en dur)
  function renderLangSelector(container) {
    if (!container || !window.I18n) return;
    const sel = document.createElement('select');
    sel.className = 'btn btn--secondary';
    sel.setAttribute('data-i18n-attr', 'aria-label:nav.language');
    sel.innerHTML = I18n.langues.map(l => `<option value="${esc(l.code)}"${l.code === I18n.lang ? ' selected' : ''}>${esc(l.nom)}</option>`).join('');
    sel.addEventListener('change', e => I18n.set(e.target.value));
    container.appendChild(sel);
    I18n.apply(container);
  }

  // Menu ≡ (spec §3) : compte, Réglages, Avis, Aide, langue, Déconnexion.
  // options.comptes        : [{ user_id, nom, titulaire }] — sélecteur affiché
  //                          seulement s'il y a un choix (non-régression : un
  //                          hôte seul ne voit rien de nouveau)
  // options.compteActif    : user_id du compte consulté
  // options.onCompte(id)   : bascule (la page se recharge)
  // options.onDeconnexion()
  // options.reglages / options.avis : afficher ces entrées (droits)
  // options.outils : [{ href, key, icon }] — section « Outils » PROVISOIRE
  //   (décision de Thierry, 10 octobre 2026) : les écrans qui n'ont pas encore
  //   rejoint un onglet V5. Chaque lot retire la ligne de l'outil qu'il fusionne
  //   (YieldFlow → Calendrier, Réservation directe et Connexions → Logements…).
  function renderMenu(options = {}) {
    const bouton = document.querySelector('[data-menu-toggle]');
    const panneau = document.querySelector('[data-menu]');
    if (!bouton || !panneau) return;
    const comptes = options.comptes || [];
    const parts = [];
    if (comptes.length > 1) {
      const actif = comptes.find(c => String(c.user_id) === String(options.compteActif)) || comptes[0];
      parts.push(`<span class="menu__label caption muted" data-i18n="nav.account"></span>
        <select class="btn btn--secondary btn--block" data-menu-compte data-i18n-attr="aria-label:nav.account">${comptes.map(c => {
          const vars = esc(JSON.stringify({ name: c.nom || '' }));
          const mien = c.titulaire ? ` data-i18n="nav.account_mine" data-i18n-vars="${vars}"` : '';
          const sel = String(c.user_id) === String(actif.user_id) ? ' selected' : '';
          return `<option value="${esc(c.user_id)}"${sel}${mien}>${esc(c.nom)}</option>`;
        }).join('')}</select>
        ${actif && !actif.titulaire ? '<span class="caption muted" data-i18n="nav.account_shared"></span>' : ''}`);
    }
    const outils = options.outils || [];
    if (outils.length) {
      parts.push(`<span class="menu__label caption muted" data-i18n="nav.tools"></span>`);
      for (const o of outils) parts.push(`<a class="menu__item" href="${esc(o.href)}">${icon(o.icon)}<span data-i18n="${esc(o.key)}"></span></a>`);
      parts.push(`<span class="menu__label caption muted" data-i18n="nav.account_menu"></span>`);
    }
    if (options.reglages) parts.push(`<a class="menu__item" href="/settings">${icon('i-settings')}<span data-i18n="nav.settings"></span></a>`);
    if (options.avis) parts.push(`<a class="menu__item" href="/avis">${icon('i-review')}<span data-i18n="nav.reviews"></span></a>`);
    parts.push(`<a class="menu__item" href="/guide">${icon('i-help')}<span data-i18n="nav.help"></span></a>`);
    parts.push(`<div class="menu__item">${icon('i-globe')}<span data-menu-langue></span></div>`);
    parts.push(`<button type="button" class="menu__item" data-menu-sortie>${icon('i-logout')}<span data-i18n="nav.logout"></span></button>`);
    panneau.innerHTML = parts.join('');
    renderLangSelector(panneau.querySelector('[data-menu-langue]'));
    panneau.querySelector('[data-menu-compte]')?.addEventListener('change', e => options.onCompte?.(e.target.value));
    panneau.querySelector('[data-menu-sortie]')?.addEventListener('click', () => options.onDeconnexion?.());
    window.I18n?.apply(panneau);

    const fermer = () => { panneau.hidden = true; bouton.setAttribute('aria-expanded', 'false'); };
    bouton.addEventListener('click', (e) => {
      e.stopPropagation();
      const ouvrir = panneau.hidden;
      panneau.hidden = !ouvrir;
      bouton.setAttribute('aria-expanded', String(ouvrir));
    });
    panneau.addEventListener('click', e => e.stopPropagation());
    document.addEventListener('click', fermer);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') fermer(); });
  }

  window.HSNav = { render, renderLangSelector, renderMenu };
})();
