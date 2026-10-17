(function () {
  'use strict';
  if (window.__pfDrawer) return;
  window.__pfDrawer = true;

  var inVscode = location.pathname.indexOf('/.vscode/') !== -1;
  var base = inVscode ? '../' : '';
  var onAccountPage = /account\.html$/i.test(location.pathname);
  var current = location.pathname.split('/').pop() || 'index.html';

  var LINKS = [
    ['Dashboard', 'index.html'],
    ['Kiosks', 'kiosks.html'],
    ['Components', 'components.html'],
    ['Log an Event', 'log-event.html'],
    ['Fault History', 'fault-history.html'],
    ['Alerts', 'alerts.html'],
    ['Reports', 'reports.html'],
    ['Users', 'users.html'],
    ['Audit Log', 'audit-log.html'],
    ['My account', '.vscode/account.html']
  ];

   
  var css = [
    '.pfd-btn,.pfd-overlay,.pfd-drawer{display:none}',
    '@media (max-width:900px){',
    '.pfd-hide{display:none !important}',
    '.pfd-btn{display:flex;flex-direction:column;justify-content:center;align-items:center;gap:5px;position:fixed;top:12px;left:12px;z-index:2147483000;width:44px;height:44px;border:0;border-radius:10px;background:#1f7a6d;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25);padding:0}',
    '.pfd-btn span{display:block;width:20px;height:2px;background:#fff;border-radius:2px}',
    '.pfd-btn:focus-visible{outline:3px solid #9be3d6;outline-offset:2px}',
    '.pfd-overlay{display:block;position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483001;background:rgba(0,0,0,.5);opacity:0;pointer-events:none;transition:opacity 200ms cubic-bezier(.22,1,.36,1)}',
    '.pfd-open .pfd-overlay{opacity:1;pointer-events:auto}',
    '.pfd-drawer{display:flex;flex-direction:column;gap:4px;position:fixed;top:0;left:0;bottom:0;width:min(280px,85vw);z-index:2147483002;background:#123e3b;color:#fff;overflow-y:auto;padding:20px 12px;box-sizing:border-box;transform:translateX(-100%);transition:transform 200ms cubic-bezier(.22,1,.36,1);visibility:hidden}',
    '.pfd-open .pfd-drawer{transform:none;visibility:visible}',
    '.pfd-open{overflow:hidden}',
    '.pfd-title{font-size:1.4rem;font-weight:700;margin:4px 8px 0}',
    '.pfd-sub{font-size:.8rem;opacity:.75;margin:0 8px 16px}',
    '.pfd-drawer a{display:flex;align-items:center;min-height:44px;padding:0 14px;border-radius:10px;color:#fff;text-decoration:none;font-size:.95rem}',
    '.pfd-drawer a:hover{background:rgba(255,255,255,.1)}',
    '.pfd-drawer a.pfd-active{background:#1f7a6d;font-weight:600}',
    '}',
    '@media (prefers-reduced-motion:reduce){.pfd-overlay,.pfd-drawer{transition:none}}'
  ].join('\n');
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // Elements
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pfd-btn';
  btn.setAttribute('aria-label', 'Toggle menu');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = '<span></span><span></span><span></span>';

  var overlay = document.createElement('div');
  overlay.className = 'pfd-overlay';

  var drawer = document.createElement('aside');
  drawer.className = 'pfd-drawer';
  drawer.id = 'pfd-drawer';
  drawer.setAttribute('aria-label', 'Menu');
  btn.setAttribute('aria-controls', 'pfd-drawer');

  var title = document.createElement('div');
  title.className = 'pfd-title';
  title.textContent = 'Pathfinder';
  var sub = document.createElement('div');
  sub.className = 'pfd-sub';
  sub.textContent = 'Asset Traceability';
  drawer.appendChild(title);
  drawer.appendChild(sub);

  LINKS.forEach(function (item) {
    var a = document.createElement('a');
    a.textContent = item[0];
    a.href = base + item[1];
    var file = item[1].split('/').pop();
    if (file === current) {
      a.className = 'pfd-active';
      a.setAttribute('aria-current', 'page');
    }
    drawer.appendChild(a);
  });

  document.body.appendChild(btn);
  document.body.appendChild(overlay);
  document.body.appendChild(drawer);

  function setOpen(open) {
    document.body.classList.toggle('pfd-open', open);
    btn.setAttribute('aria-expanded', String(open));
  }
  btn.addEventListener('click', function () {
    setOpen(!document.body.classList.contains('pfd-open'));
  });
  overlay.addEventListener('click', function () { setOpen(false); });
  drawer.addEventListener('click', function (e) { if (e.target.closest('a')) setOpen(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });

  var mq = window.matchMedia('(max-width: 900px)');
  function onResize() { if (!mq.matches) setOpen(false); }
  if (mq.addEventListener) mq.addEventListener('change', onResize);

  // Sign out only on the account page
  function removeSignOut() {
    if (onAccountPage) return;
    document.querySelectorAll('a, button').forEach(function (el) {
      if (drawer.contains(el)) return;
      if (el.textContent.trim().toLowerCase() === 'sign out') el.remove();
    });
  }

  // Hide any older hamburger in the top-left on phones
  function hideOld() {
    if (!mq.matches) return;
    document.querySelectorAll('button').forEach(function (b) {
      if (b === btn) return;
      var r = b.getBoundingClientRect();
      var label = (b.getAttribute('aria-label') || '').toLowerCase();
      var empty = b.textContent.trim() === '';
      if (r.width > 0 && r.top < 160 && r.left < 160 &&
          (empty || /menu|navigation|sidebar/.test(label))) {
        b.classList.add('pfd-hide');
      }
    });
  }

  function run() { removeSignOut(); hideOld(); }
  run();
  window.addEventListener('load', function () {
    run();
    // app-shell.js may build the header late, so keep watching for 4 seconds
    var observer = new MutationObserver(run);
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(function () { observer.disconnect(); }, 4000);
  });
})();