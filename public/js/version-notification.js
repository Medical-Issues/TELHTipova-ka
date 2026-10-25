// Systém oznámení o nových verzích
(function() {
    'use strict';

    const STORAGE_KEY = 'tipovacka_last_seen_version';
    const API_URL = '/api/version';
    let activeTeamFormTarget = null;
    let teamFormTooltip = null;

    function hideTeamFormTooltip() {
        teamFormTooltip?.remove();
        teamFormTooltip = null;
        activeTeamFormTarget = null;
    }

    function showTeamFormTooltip(target) {
        const text = target.dataset.tooltip;
        if (!text) return;
        if (activeTeamFormTarget === target && teamFormTooltip) return;

        hideTeamFormTooltip();
        activeTeamFormTarget = target;
        teamFormTooltip = document.createElement('div');
        teamFormTooltip.className = 'team-form-tooltip';
        teamFormTooltip.textContent = text;
        document.body.appendChild(teamFormTooltip);

        const targetRect = target.getBoundingClientRect();
        const tooltipRect = teamFormTooltip.getBoundingClientRect();
        const left = Math.max(12, Math.min(
            targetRect.left + targetRect.width / 2 - tooltipRect.width / 2,
            window.innerWidth - tooltipRect.width - 12
        ));
        const top = targetRect.top - tooltipRect.height - 8 >= 8
            ? targetRect.top - tooltipRect.height - 8
            : targetRect.bottom + 8;

        teamFormTooltip.style.left = `${left}px`;
        teamFormTooltip.style.top = `${top}px`;
    }

    document.addEventListener('pointerover', event => {
        const target = event.target.closest('.team-form-result[data-tooltip]');
        if (target) showTeamFormTooltip(target);
    });
    document.addEventListener('pointerout', event => {
        if (activeTeamFormTarget && !activeTeamFormTarget.contains(event.relatedTarget)) {
            hideTeamFormTooltip();
        }
    });
    document.addEventListener('focusin', event => {
        const target = event.target.closest('.team-form-result[data-tooltip]');
        if (target) showTeamFormTooltip(target);
    });
    document.addEventListener('focusout', event => {
        if (activeTeamFormTarget && !activeTeamFormTarget.contains(event.relatedTarget)) {
            hideTeamFormTooltip();
        }
    });
    window.addEventListener('scroll', hideTeamFormTooltip, true);
    window.addEventListener('resize', hideTeamFormTooltip);

    // Vytvořit a zobrazit notifikaci
    function showVersionNotification(versionData, forceShow = false) {
        // Kontrola - nezobrazovat pokud uživatel již viděl tuto verzi (pokud není forceShow)
        const lastSeen = localStorage.getItem(STORAGE_KEY);
        if (!forceShow && lastSeen === versionData.version) {
            return;
        }

        // Odstranit existující notifikaci pokud existuje
        const existing = document.getElementById('version-notification');
        if (existing) {
            existing.remove();
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

    // Aktualizovat text verze na stránce
    function updateVersionBadges(version) {
        if (!version) return;
        const currentVersionEl = document.getElementById('current-version');
        if (currentVersionEl) {
            currentVersionEl.textContent = version;
        }
        const versionBadgeEls = document.querySelectorAll('.version-number, [data-version-badge]');
        versionBadgeEls.forEach(el => {
            el.textContent = 'v' + version;
        });
    }

    // Načíst informace o verzi
    async function checkVersion() {
        try {
            const response = await fetch(API_URL);
            if (!response.ok) {
                console.error('Verze: Response not OK, skipping');
                return;
            }

            const data = await response.json();
            if (data && data.version) {
                updateVersionBadges(data.version);
            }

            // Pokud je to počáteční verze, nezobrazovat oznámení
            if (data.isInitial) {
                return;
            }

            // Zobrazit notifikaci
            showVersionNotification(data);
        } catch (error) {
            console.error('Verze oznámení: Nepodařilo se načíst verzi', error);
        }
    }

    // Globální funkce pro manuální zobrazení notifikace (při kliknutí na version badge)
    window.showVersionNotificationManual = async function() {
        try {
            const response = await fetch(API_URL);
            if (!response.ok) {
                console.error('Verze: Response not OK, skipping');
                return;
            }

            const data = await response.json();
            showVersionNotification(data, true); // forceShow = true
        } catch (error) {
            console.error('Verze oznámení: Nepodařilo se načíst verzi', error);
        }
    };

    // Spustit po načtení stránky
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', checkVersion);
    } else {
        checkVersion();
    }
})();
