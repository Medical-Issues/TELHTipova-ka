// Systém oznámení o nových verzích
(function() {
    'use strict';

    const STORAGE_KEY = 'tipovacka_last_seen_version';
    const API_URL = '/api/version';

    // Vytvořit a zobrazit notifikaci
    function showVersionNotification(versionData) {
        // Kontrola - nezobrazovat pokud uživatel již viděl tuto verzi
        const lastSeen = localStorage.getItem(STORAGE_KEY);
        if (lastSeen === versionData.version) {
            return;
        }

        // Vytvořit element notifikace
        const notification = document.createElement('div');
        notification.className = 'version-notification';
        notification.id = 'version-notification';

        const changelogHtml = versionData.changelog
            .map(item => `<li>${escapeHtml(item)}</li>`)
            .join('');

        notification.innerHTML = `
            <div class="version-notification-header">
                <div>
                    <span class="version-notification-title">${escapeHtml(versionData.title || 'Nová aktualizace')}</span>
                    <span class="version-number-badge">v${escapeHtml(versionData.version)}</span>
                </div>
                <button class="version-notification-close" onclick="dismissVersionNotification()">&times;</button>
            </div>
            <div class="version-notification-content">
                <h4>Co je nového:</h4>
                <ul class="version-changelog-list">
                    ${changelogHtml}
                </ul>
                <p style="margin-top: 15px; font-size: 0.85em; color: #888;">
                    Vydáno: ${new Date(versionData.releasedAt).toLocaleDateString('cs-CZ')}
                </p>
            </div>
        `;

        document.body.appendChild(notification);

        // Auto-hide po 10 sekundách
        setTimeout(() => {
            dismissVersionNotification();
        }, 10000);
    }

    // Funkce pro zavření notifikace
    window.dismissVersionNotification = function() {
        const notification = document.getElementById('version-notification');
        if (notification) {
            notification.classList.add('hide');
            setTimeout(() => {
                notification.remove();
            }, 300);

            // Uložit verzi jako viděnou
            const versionBadge = notification.querySelector('.version-number-badge');
            if (versionBadge) {
                const version = versionBadge.textContent.replace('v', '');
                localStorage.setItem(STORAGE_KEY, version);
            }
        }
    };

    // Escape HTML pro bezpečnost
    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Načíst informace o verzi
    async function checkVersion() {
        try {
            const response = await fetch(API_URL);
            if (!response.ok) {
                console.log('Verze: Response not OK, skipping');
                return;
            }

            const data = await response.json();

            // Pokud je to počáteční verze, nezobrazovat oznámení
            if (data.isInitial) {
                return;
            }

            // Zobrazit notifikaci
            showVersionNotification(data);
        } catch (error) {
            console.log('Verze oznámení: Nepodařilo se načíst verzi', error);
        }
    }

    // Spustit po načtení stránky
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', checkVersion);
    } else {
        checkVersion();
    }
})();
