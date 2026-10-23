(function () {
  'use strict';
  if (window.__pfNav) return;          // never run twice
  window.__pfNav = true;

  var onAccountPage = /account\.html$/i.test(location.pathname);
  var mq = window.matchMedia('(max-width: 900px)');

  // Sign out only on the account page
  function removeSignOut() {
    if (onAccountPage) return;
    document.querySelectorAll('a, button').forEach(function (el) {
      if (el.textContent.trim().toLowerCase() === 'sign out') el.remove();
    });
  }

  // Hide any old hamburger in the top-left on phones
  function hideOld() {
    if (!mq.matches) return;
    document.querySelectorAll('button').forEach(function (b) {
      if (b.classList.contains('pf-menu-btn')) return;
      var r = b.getBoundingClientRect();
      var label = (b.getAttribute('aria-label') || '').toLowerCase();
      var empty = b.textContent.trim() === '';
      if (r.width > 0 && r.top < 160 && r.left < 160 &&
          (empty || /menu|navigation|sidebar/.test(label))) {
        b.classList.add('pf-hide-old');
      }
    });
  }

  function setupMenu() {
    var nav = document.querySelector('nav[aria-label="Main navigation"]') || document.querySelector('nav');
    if (!nav) return;
    nav.classList.add('pf-nav');
    if (!nav.id) nav.id = 'main-nav';
    document.body.classList.add('pf-on');

    if (document.querySelector('.pf-menu-btn')) return;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pf-menu-btn';
    btn.setAttribute('aria-label', 'Toggle menu');
    btn.setAttribute('aria-controls', nav.id);
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '<span></span><span></span><span></span>';

    var overlay = document.createElement('div');
    overlay.className = 'pf-nav-overlay';

    document.body.appendChild(btn);
    document.body.appendChild(overlay);

    function setOpen(open) {
      document.body.classList.toggle('pf-nav-open', open);
      btn.setAttribute('aria-expanded', String(open));
    }
    btn.addEventListener('click', function () {
      setOpen(!document.body.classList.contains('pf-nav-open'));
    });
    overlay.addEventListener('click', function () { setOpen(false); });
    nav.addEventListener('click', function (e) { if (e.target.closest('a')) setOpen(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });
  }

  function run() { removeSignOut(); setupMenu(); hideOld(); }

  window.addEventListener('load', function () {
    run();
    // app-shell.js may build the header late, so keep watching for 4 seconds
    var observer = new MutationObserver(run);
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(function () { observer.disconnect(); }, 4000);
  });
  if (mq.addEventListener) mq.addEventListener('change', function () { setTimeout(run, 50); });
})();
