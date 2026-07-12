self.addEventListener('fetch', e => e.respondWith(fetch(e.request)));

// App推播通知(2026-07-13)：跟現有LINE通知同一套觸發點，後端(send-web-push
// Edge Function)送過來的payload固定是{title, body}這個形狀。
self.addEventListener('push', e => {
  let data = { title: '永平整復保健', body: '有新的通知' };
  try {
    if (e.data) data = { ...data, ...e.data.json() };
  } catch (_) {
    // payload不是JSON格式時的容錯，不讓整個push事件失敗、通知完全不顯示
    if (e.data) data.body = e.data.text();
  }
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/booking/icon-192.png',
      badge: '/booking/icon-192.png',
      tag: 'yongping-notify', // 同一個tag：新通知進來會取代舊的，不會疊一堆通知洗版
    })
  );
});

// 點通知：如果已經有分頁開著就切過去，沒有的話開新分頁——比單純open()更好，
// 不會每次點通知都多開一個分頁。
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes('/booking/') && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/booking/');
    })
  );
});
