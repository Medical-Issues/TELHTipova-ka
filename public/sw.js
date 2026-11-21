console.log("[SW] Service Worker Loaded...");
const SW_VERSION = '1.3.0';

// Force update - okamžitá aktivace nové verze
self.addEventListener('install', () => {
    console.log('[SW] Installing version:', SW_VERSION);
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    console.log('[SW] Activated version:', SW_VERSION);
    event.waitUntil(clients.claim());
});

// Zachycení změny push subscription (prohlížeč mění endpoint)
self.addEventListener('pushsubscriptionchange', event => {
    console.log('[SW] Push subscription changed, re-subscribing...');
    event.waitUntil(
        (async () => {
            try {
                // Pokud prohlížeč nepředá oldSubscription, vytáhneme VAPID klíč z backendu
                let appServerKey = event.oldSubscription?.options?.applicationServerKey;
                if (!appServerKey) {
                    const res = await fetch('/api/vapid-public-key');
                    appServerKey = await res.text();
                }

                const newSubscription = await self.registration.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: appServerKey
                });

                // Získání čerstvého CSRF tokenu ze session před odesláním
                const csrfRes = await fetch('/api/csrf-token', {credentials: 'include'});
                const {csrfToken} = await csrfRes.json();

                await fetch('/api/subscribe', {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': csrfToken
                    },
                    body: JSON.stringify(newSubscription)
                });
                console.log('[SW] Re-subscribed successfully');
            } catch (err) {
                console.error('[SW] Failed to re-subscribe:', err);
            }
        })()
    );
});

// 1. PŘÍJEM NOTIFIKACE + BADGING API
self.addEventListener('push', e => {
    if (!e.data) return;

    let payload;
    try {
        payload = e.data.json();
    } catch {
        payload = {title: 'TELHTipovačka', body: e.data.text()};
    }

    console.log("Push Received...", payload);

    // BLOKACE: Ignorovat notifikace z JINÉHO serveru
    if (payload.serverOrigin && payload.serverOrigin !== self.location.origin) {
        console.log(`[SW] BLOCKED: Notification from ${payload.serverOrigin} ignored on ${self.location.origin}`);
        return;
    }

    // BADGING API: Nastavení nebo vymazání čísla na ikoně aplikace
    if ('setAppBadge' in self.navigator) {
        if (typeof payload.badgeCount === 'number') {
            if (payload.badgeCount > 0) {
                self.navigator.setAppBadge(payload.badgeCount).catch(() => {
                });
            } else {
                self.navigator.clearAppBadge().catch(() => {
                });
            }
        }
    }

    const isSilent = Boolean(payload.silent);

    const notificationOptions = {
        body: payload.body,
        icon: '/images/logo.png',
        badge: payload.badge || '/icons/badge-72.png',
        image: payload.image || null,
        vibrate: isSilent ? undefined : (payload.vibrate || [100, 100, 250, 500, 100, 100, 250]),
        tag: payload.tag || 'obecne-upozorneni-' + Date.now(),
        requireInteraction: payload.requireInteraction || false,
        actions: payload.actions || [],
        data: {
            url: payload.url || '/',
            matchId: payload.matchId || null,
            matchIds: Array.isArray(payload.matchIds) ? payload.matchIds : null,
            timestamp: Date.now()
        },
        silent: isSilent,
        renotify: Boolean(payload.renotify)
    };

    e.waitUntil(
        self.registration.showNotification(payload.title || 'TELHTipovačka', notificationOptions)
            .then(() => console.log('[SW] Notification shown:', payload.title))
            .catch(err => console.error('[SW] Failed to show notification:', err))
    );
});

// 2. REAKCE NA KLIKNUTÍ (Tělo zprávy i tlačítka)
self.addEventListener('notificationclick', e => {
    e.notification.close();

    const action = e.action;
    const targetUrl = e.notification.data?.url || '/';

    // Tlačítko "Zavřít"
    if (action === 'close') {
        return;
    }

    // Tlačítko "Připomenout později" (bez otevírání okna prohlížeče)
    if (action === 'snooze') {
        e.waitUntil(
            (async () => {
                try {
                    const csrfRes = await fetch('/api/csrf-token', {credentials: 'include'});
                    const {csrfToken} = await csrfRes.json();
                    // Podporujeme jak pole matchIds (agregované notifikace), tak jeden matchId
                    const matchIds = e.notification.data?.matchIds
                        || (e.notification.data?.matchId ? [e.notification.data.matchId] : []);
                    await fetch('/api/push/snooze', {
                        method: 'POST',
                        credentials: 'include',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-CSRF-Token': csrfToken
                        },
                        body: JSON.stringify({matchIds})
                    });
                } catch (err) {
                    console.error('[SW] Snooze failed:', err);
                }
            })()
        );
        return;
    }

    // Prokliknutí do aplikace
    e.waitUntil(
        clients.matchAll({type: 'window', includeUncontrolled: true}).then(windowClients => {
            for (let i = 0; i < windowClients.length; i++) {
                const client = windowClients[i];
                if (client.url.includes(self.registration.scope) && 'focus' in client) {
                    client.navigate(targetUrl);
                    return client.focus();
                }
            }
            if (clients.openWindow) {
                return clients.openWindow(targetUrl);
            }
        })
    );
});

// 3. OFFLINE FALLBACK (jen při navigaci na stránku bez internetu)
self.addEventListener('fetch', event => {
    if (event.request.mode === 'navigate') {
        event.respondWith(
            fetch(event.request).catch(() => {
                return new Response(`
                    <!DOCTYPE html>
                    <html lang="cs">
                    <head>
                        <meta charset="UTF-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                        <title>Offline – TELHTipovačka</title>
                        <style>
                            body { background: #121212; color: #f1f5f9; font-family: system-ui, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; padding: 1.5rem; }
                            h1 { color: #e11d48; margin-bottom: 0.5rem; }
                            p { color: #94a3b8; max-width: 340px; line-height: 1.5; margin-bottom: 1.5rem; }
                            button { background: #e11d48; color: white; border: none; padding: 0.8rem 1.5rem; border-radius: 10px; font-weight: 600; font-size: 1rem; cursor: pointer; }
                        </style>
                    </head>
                    <body>
                        <h1>Jsi offline</h1>
                        <p>Vypadá to, že vypadl internet. Zkontroluj připojení a zkus načíst tipovačku znovu.</p>
                        <button onclick="location.reload()">Zkusit znovu</button>
                    </body>
                    </html>
                `, {headers: {'Content-Type': 'text/html; charset=utf-8'}});
            })
        );
    }
});