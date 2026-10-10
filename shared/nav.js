/* ============================================================
   HôteSmart — nav.js
   Construit la barre du haut et la barre du bas depuis UNE liste.
   Ajouter une rubrique = une ligne ici (mais la navigation est
   définitive : 5 entrées, voir spec §3).
   ============================================================ */
(() => {
  const NAV = [
    { href: '/pages/aujourdhui', key: 'nav.today',      icon: 'i-today' },
    { href: '/pages/calendrier', key: 'nav.calendar',   icon: 'i-calendar' },
    { href: '/pages/messages',   key: 'nav.messages',   icon: 'i-message', badge: 'pendingMessages' },
    { href: '/pages/menages',    key: 'nav.cleaning',   icon: 'i-cleaning' },
    { href: '/pages/logements',  key: 'nav.properties', icon: 'i-home' },
  ];

  const icon = (id, cls = 'icon') => `<svg class="${cls}" aria-hidden="true"><use href="/shared/icons.svg#${id}"/></svg>`;
  const isCurrent = (href) => location.pathname.replace(/\/$/, '').endsWith(href.replace(/\/$/, ''));

  function render(badges = {}) {
    const top = document.querySelector('.topbar__nav');
    const bottom = document.querySelector('.bottombar');
    const items = NAV.map(n => {
      const cur = isCurrent(n.href) ? ' aria-current="page"' : '';
      const count = n.badge ? badges[n.badge] : 0;
      const badge = count ? `<span class="badge badge--amber">${count}</span>` : '';
      return { n, cur, badge };
    });
    if (top) top.innerHTML = items.map(({ n, cur, badge }) =>
      `<a class="tab" href="${n.href}"${cur}><span data-i18n="${n.key}"></span>${badge}</a>`).join('');
    if (bottom) bottom.innerHTML = items.map(({ n, cur, badge }) =>
      `<a href="${n.href}"${cur}>${icon(n.icon)}<span data-i18n="${n.key}"></span>${badge}</a>`).join('');
    window.I18n?.apply(top?.parentElement || document);
    window.I18n?.apply(bottom || document);
  }

  // Sélecteur de langue construit depuis langues.json (jamais codé en dur)
  function renderLangSelector(container) {
    if (!container || !window.I18n) return;
    const sel = document.createElement('select');
    sel.className = 'btn btn--secondary';
    sel.setAttribute('data-i18n-attr', 'aria-label:nav.language');
    sel.innerHTML = I18n.langues.map(l => `<option value="${l.code}"${l.code === I18n.lang ? ' selected' : ''}>${l.nom}</option>`).join('');
    sel.addEventListener('change', e => I18n.set(e.target.value));
    container.appendChild(sel);
    I18n.apply(container);
  }

  window.HSNav = { render, renderLangSelector };
})();
