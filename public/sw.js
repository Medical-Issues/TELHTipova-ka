console.log("Service Worker Loaded...");
// Force update - okamžitá aktivace nové verze
self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(clients.claim());
});
// 1. PŘÍJEM NOTIFIKACE
self.addEventListener('push', e => {
    const payload = e.data.json();
    console.log("Push Received...", payload);

    e.waitUntil(
        self.registration.showNotification(payload.title, {
            body: payload.body,
            icon: '/images/logo.png',
            badge: '/images/logo.png',
            image: payload.image || null,
            // --------------------------------
            vibrate: payload.vibrate || [100, 100, 250, 500, 100, 100, 250],
            tag: payload.tag || 'obecne-upozorneni',
            renotify: true,
            requireInteraction: payload.requireInteraction || false,
            actions: payload.actions || [],
            data: {
                url: payload.url || '/'
            }
        })
    );
});

// 2. REAKCE NA KLIKNUTÍ (Tělo zprávy i tlačítka)
self.addEventListener('notificationclick', e => {
    // Okamžitě zavřeme notifikaci, ať tam nevisí
    e.notification.close();

    // Zjistíme, jestli uživatel klikl na nějaké konkrétní tlačítko
    const action = e.action;
    const targetUrl = e.notification.data.url;

    // Pokud uživatel klikl na tlačítko "Zavřít", neděláme nic (notifikaci už jsme zavřeli nahoře)
    if (action === 'close') {
        return;
    }

    // Prokliknutí do aplikace (klik na "open_match" nebo kamkoliv do textu notifikace)
    e.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
            // Pokud už má uživatel náš web někde otevřený, přepneme ho do něj a přesměrujeme
            for (let i = 0; i < windowClients.length; i++) {
                const client = windowClients[i];
                if (client.url.includes(self.registration.scope) && 'focus' in client) {
                    client.navigate(targetUrl);
                    return client.focus();
                }
            }
            // Pokud web otevřený nemá, otevřeme nové okno
            if (clients.openWindow) {
                return clients.openWindow(targetUrl);
            }
        })
    );
});