// KenMaP Service Worker (ハブと全アプリ共通)
// 内容を更新したら VERSION を上げると、利用者の端末のキャッシュが新しくなります。
const VERSION = 'v8';
const CACHE = 'kenmap-' + VERSION;

// オフラインで使えるようにするファイル。アプリを追加したらここにも足す。
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './respiratory/',
  './respiratory/index.html',
  './piv-echo/',
  './piv-echo/index.html',
  './ECG-dojo/',
  './ECG-dojo/index.html',
  './ECG-dojo/app.js',
  './ECG-dojo/ecg.js',
  './ECG-dojo/data/shiro.json',
  './ECG-dojo/data/cha.json',
  './ECG-dojo/data/kuro.json',
  './ECG-dojo/data/shihan.json',
  './abcde-quest/',
  './abcde-quest/index.html',
  './abcde-quest/game.js',
  './abcde-quest/cases/index.json',
  './abcde-quest/cases/case01-sepsis.json'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('kenmap-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // ページ: ネット優先 (最新を表示)、オフライン時はキャッシュ
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return res; })
        .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('./')))
    );
    return;
  }

  // アプリ内ファイルと Google Fonts: キャッシュ優先、裏で更新
  if (url.origin === location.origin || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.match(req).then(cached => {
        const network = fetch(req).then(res => {
          if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
  }
});
