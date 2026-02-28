console.log("Service Worker Loaded...");

self.addEventListener('push', e => {
    const data = e.data.json();
    console.log("Push Received...");
    self.registration.showNotification(data.title, {
        body: data.body,
        icon: '/images/logo.png', // Cesta k tvému logu
        badge: '/images/badge.png', // Malá ikona pro lištu (volitelné)
        vibrate: [100, 50, 100]
    });
});