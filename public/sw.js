console.log("[SW] Service Worker Loaded...");
const SW_VERSION = '1.1.0';

// Force update - okamžitá aktivace nové verze
self.addEventListener('install', (event) => {
    console.log('[SW] Installing version:', SW_VERSION);
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    console.log('[SW] Activated version:', SW_VERSION);
    event.waitUntil(clients.claim());
});

// DŮLEŽITÉ: Zachycení změny push subscription (prohlížeč mění endpoint)
self.addEventListener('pushsubscriptionchange', event => {
    console.log('[SW] Push subscription changed, re-subscribing...');
    event.waitUntil(
        self.registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: event.oldSubscription.options.applicationServerKey
        }).then(newSubscription => {
            // Odeslat nový subscription na server
            return fetch('/api/subscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newSubscription)
            });
        }).catch(err => {
            console.error('[SW] Failed to re-subscribe:', err);
        })
    );
});

// 1. PŘÍJEM NOTIFIKACE
self.addEventListener('push', e => {
    const payload = e.data.json();
    console.log("Push Received...", payload);

    // BLOKACE: Ignorovat notifikace z JINÉHO serveru
    if (payload.serverOrigin && payload.serverOrigin !== self.location.origin) {
        console.log(`[SW] BLOCKED: Notification from ${payload.serverOrigin} ignored on ${self.location.origin}`);
        return;
    }

    // Zajistit aby notifikace byla vzdy zobrazena i kdyz ma stejny tag
    const notificationOptions = {
        body: payload.body,
        icon: '/images/logo.png',
        badge: '/images/logo.png',
        image: payload.image || null,
        // --------------------------------
        vibrate: payload.vibrate || [100, 100, 250, 500, 100, 100, 250],
        tag: payload.tag || 'obecne-upozorneni-' + Date.now(), // Unikatni tag pro kazdou notifikaci
        // renotify odstraneno - zpusobovalo problemy na nekterych zarizenich
        requireInteraction: payload.requireInteraction || false,
        actions: payload.actions || [],
        data: {
            url: payload.url || '/',
            timestamp: Date.now()
        },
        // Priorita pro Android
        silent: false
    };

    e.waitUntil(
        self.registration.showNotification(payload.title, notificationOptions)
            .then(() => {
                console.log('[SW] Notification shown:', payload.title);
            })
            .catch(err => {
                console.error('[SW] Failed to show notification:', err);
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
