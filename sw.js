// dshs43 관리 — 서비스 워커 (관리자 사이트 전용)
// 관리자 화면은 늘 최신 내용이 중요해서 네트워크 우선으로 받고, 인터넷이 없을 때만 받아 둔 파일을 씁니다.
// BUILD 는 scripts/build-admin.mjs 가 묶을 때마다 바꿔서, 새 배포가 올라가면 기기에 바로 깔립니다.
const BUILD = '2026-11-14T05:03:57.427Z';
const CACHE = `dshs43-admin-${BUILD}`;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Supabase · Edge Function 등 다른 서버 응답은 건드리지 않습니다 (캐시하면 옛 데이터가 보임)
  if (url.origin !== location.origin) return;
  const key = req.mode === 'navigate' ? './index.html' : req;
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)).catch(() => {}); }
    return res;
  }).catch(() => caches.match(key, { ignoreSearch: req.mode === 'navigate' }).then(hit => hit || Response.error())));
});

// ---------- 웹 푸시 (승인 요청 · 피드백 · 운영 점검 · 사용 분석) ----------
self.addEventListener('push', e => {
  let d = { title: 'dshs43 관리', body: '새 알림이 있어요', url: './' };
  try { if (e.data) d = { ...d, ...e.data.json() }; } catch (err) { if (e.data) d.body = e.data.text(); }
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body,
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: d.tag || 'dshs43-admin',
    renotify: true,
    data: { url: d.url || './' }
  }));
});

// 서버가 보내는 주소(/?view=admin&pane=ops 등)를 이 사이트에서 엽니다
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || './', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if (c.url.startsWith(self.location.origin)) return c.navigate(target).then(w => (w || c).focus()).catch(() => c.focus());
    }
    return self.clients.openWindow(target);
  }));
});
