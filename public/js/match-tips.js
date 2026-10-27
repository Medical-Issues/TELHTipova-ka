/**
 * Match tips popover interactions & User Profile / Activity Modals
 */

window.toggleTipsPopover = function(event, matchId, side) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    const popoverId = 'tips-popover-' + matchId + '-' + side;
    const popover = document.getElementById(popoverId);
    if (!popover) return;
    const wasHidden = popover.hidden;
    document.querySelectorAll('.tips-popover:not([hidden])').forEach(p => {
        p.hidden = true;
    });
    popover.hidden = !wasHidden;
};

window.closeTipsPopover = function(matchId, side) {
    const popoverId = 'tips-popover-' + matchId + '-' + side;
    const popover = document.getElementById(popoverId);
    if (popover) {
        popover.hidden = true;
    }
};

document.addEventListener('click', (e) => {
    if (!e.target.closest('.match-tips-panel')) {
        document.querySelectorAll('.tips-popover:not([hidden])').forEach(p => {
            p.hidden = true;
        });
    }
});

/* =========================================================
   GLOBAL MODALS: USER PROFILE (H2H DUEL) & RECENT ACTIVITY
   ========================================================= */

function getOrCreateModalContainer() {
    let container = document.getElementById('app-global-modal');
    if (!container) {
        container = document.createElement('div');
        container.id = 'app-global-modal';
        container.className = 'app-modal-overlay';
        container.hidden = true;
        container.onclick = (e) => {
            if (e.target === container) window.closeAppModal();
        };
        document.body.appendChild(container);
    }
    return container;
}

window.closeAppModal = function() {
    const container = document.getElementById('app-global-modal');
    if (container) {
        container.hidden = true;
        container.innerHTML = '';
    }
    document.body.classList.remove('modal-open');
};

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        document.querySelectorAll('.tips-popover:not([hidden])').forEach(p => {
            p.hidden = true;
        });
        window.closeAppModal();
    }
});

function escapeHtmlClient(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

window.openUserProfileModal = function(targetUsername) {
    if (!targetUsername) return;
    const container = getOrCreateModalContainer();
    container.hidden = false;
    document.body.classList.add('modal-open');

    // Loading skeleton
    container.innerHTML = `
        <div class="app-modal-card" onclick="event.stopPropagation()">
            <button type="button" class="app-modal-close" onclick="window.closeAppModal()">&times;</button>
            <div style="text-align: center; padding: 40px 20px; color: var(--text-muted, #94a3b8);">
                <div style="display: inline-block; width: 32px; height: 32px; border: 3px solid rgba(255,85,0,0.3); border-top-color: var(--primary, #ff5500); border-radius: 50%; animation: spin 0.8s linear infinite; margin-bottom: 12px;"></div>
                <div style="font-weight: 600;">Načítám profil hráče ${escapeHtmlClient(targetUsername)}...</div>
            </div>
        </div>
    `;

    const urlParams = new URLSearchParams(window.location.search);
    const liga = urlParams.get('liga') || '';
    const season = urlParams.get('season') || '';

    fetch(`/api/user-profile-h2h?targetUser=${encodeURIComponent(targetUsername)}&liga=${encodeURIComponent(liga)}&season=${encodeURIComponent(season)}`)
        .then(res => {
            if (!res.ok) throw new Error('Nepodařilo se načíst profil hráče.');
            return res.json();
        })
        .then(data => {
            const {targetUser, isSelf, h2h, topTeams } = data;
            const initial = (targetUser.username || '?')[0].toUpperCase();

            let h2hHtml = '';
            if (!isSelf && h2h) {
                const isMeLeading = h2h.myWins > h2h.targetWins;
                const isTargetLeading = h2h.targetWins > h2h.myWins;

                let duelsListHtml;
                if (h2h.recentDuels && h2h.recentDuels.length > 0) {
                    duelsListHtml = `
                        <div class="modal-section-title">⚔️ Poslední přímé souboje (odlišné tipy)</div>
                        <div class="recent-duels-list">
                            ${h2h.recentDuels.map(d => {
                                const iWon = d.myPts > d.targetPts;
                                const heWon = d.targetPts > d.myPts;
                                return `
                                <div class="recent-duel-item">
                                    <div class="recent-duel-match">
                                        <span class="recent-duel-teams">${escapeHtmlClient(d.homeName)} vs ${escapeHtmlClient(d.awayName)}</span>
                                        <span class="recent-duel-score">${escapeHtmlClient(d.score)}</span>
                                    </div>
                                    <div class="recent-duel-picks">
                                        <span class="pick-badge ${iWon ? 'win' : (heWon ? 'loss' : '')}" title="Tvůj tip">Ty: ${escapeHtmlClient(d.myPick)} (${d.myPts}b)</span>
                                        <span class="pick-badge ${heWon ? 'win' : (iWon ? 'loss' : '')}" title="Tip soupeře">${escapeHtmlClient(targetUser.username)}: ${escapeHtmlClient(d.targetPick)} (${d.targetPts}b)</span>
                                    </div>
                                </div>`;
                            }).join('')}
                        </div>
                    `;
                } else {
                    duelsListHtml = `
                        <div style="font-size: 12px; color: var(--text-dim, #64748b); text-align: center; padding: 8px 0; margin-bottom: 14px;">
                            Zatím žádné vyhodnocené zápasy, kde byste tipovali odlišně.
                        </div>
                    `;
                }

                h2hHtml = `
                    <div class="h2h-duel-card">
                        <div class="h2h-duel-header">
                            <span>Vzájemná bilance</span>
                            <span>${h2h.agreedCount + h2h.disagreedCount} společných tipů</span>
                        </div>
                        <div class="h2h-scoreboard">
                            <div class="h2h-player ${isMeLeading ? 'winner' : ''}">
                                <span class="h2h-player-label">Ty</span>
                                <span class="h2h-player-score">${h2h.myWins}</span>
                            </div>
                            <div class="h2h-vs-center">
                                <span class="h2h-vs-badge">VS</span>
                                <span class="h2h-draws-label">${h2h.draws} remíz</span>
                            </div>
                            <div class="h2h-player ${isTargetLeading ? 'winner' : ''}">
                                <span class="h2h-player-label">${escapeHtmlClient(targetUser.username)}</span>
                                <span class="h2h-player-score">${h2h.targetWins}</span>
                            </div>
                        </div>
                        <div class="h2h-agreement-bar">
                            <div class="h2h-agreement-fill" style="width: ${h2h.agreementPct}%;"></div>
                        </div>
                        <div class="h2h-agreement-text">
                            <span>Míra shody: <strong>${h2h.agreementPct}%</strong></span>
                            <span>${h2h.agreedCount} shodných tipů</span>
                        </div>
                    </div>
                    ${duelsListHtml}
                `;
            } else if (isSelf) {
                h2hHtml = `
                    <div style="background: rgba(255, 85, 0, 0.08); border: 1px solid rgba(255, 85, 0, 0.25); border-radius: var(--radius-md, 8px); padding: 14px; margin-bottom: 20px; text-align: center;">
                        <span style="font-weight: 700; color: #fff; font-size: 13px;">Toto je tvůj profil!</span>
                        <p style="margin: 4px 0 0; font-size: 12px; color: var(--text-muted, #94a3b8);">Chceš-li vidět vzájemný H2H duel, klikni v žebříčku nebo u zápasů na jméno kteréhokoliv soupeře.</p>
                    </div>
                `;
            }

            let topTeamsHtml = '';
            if (topTeams && topTeams.length > 0) {
                topTeamsHtml = `
                    <div class="modal-section-title">🏆 Nejúspěšnější týmy v tipech</div>
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin-bottom: 10px;">
                        ${topTeams.map(t => `
                            <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: var(--radius-sm, 6px); padding: 10px; display: flex; align-items: center; gap: 10px;">
                                <img src="${t.logo}" alt="" style="width: 26px; height: 26px; object-fit: contain;">
                                <div style="flex: 1; min-width: 0;">
                                    <div style="font-weight: 700; color: #fff; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtmlClient(t.name)}</div>
                                    <div style="font-size: 11px; color: var(--accent-green, #22c55e); font-weight: 600;">${t.pct}% (${t.correct}/${t.total})</div>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                `;
            }

            container.innerHTML = `
                <div class="app-modal-card" onclick="event.stopPropagation()">
                    <button type="button" class="app-modal-close" onclick="window.closeAppModal()">&times;</button>
                    
                    <div class="modal-user-header">
                        <div class="modal-user-avatar">${initial}</div>
                        <div class="modal-user-info">
                            <h3 class="modal-user-name">
                                ${escapeHtmlClient(targetUser.username)}
                                ${isSelf ? '<span class="modal-rank-badge" style="color: var(--primary, #ff5500); border-color: rgba(255,85,0,0.4); font-size: 10px;">Ty</span>' : ''}
                            </h3>
                            <div class="modal-user-stats-strip">
                                <span class="modal-rank-badge">#${targetUser.rank} v lize</span>
                                <span><strong>${targetUser.points}</strong> bodů</span>
                                <span><strong>${targetUser.pct}%</strong> úspěšnost</span>
                                <span>(${targetUser.correct} z ${targetUser.totalTipped})</span>
                            </div>
                        </div>
                    </div>

                    ${h2hHtml}
                    ${topTeamsHtml}
                </div>
            `;
        })
        .catch(err => {
            container.innerHTML = `
                <div class="app-modal-card" onclick="event.stopPropagation()">
                    <button type="button" class="app-modal-close" onclick="window.closeAppModal()">&times;</button>
                    <div style="text-align: center; padding: 30px; color: #f87171;">
                        <p style="font-weight: 700; margin: 0 0 8px 0;">Chyba načtení</p>
                        <p style="font-size: 12px; color: var(--text-muted); margin: 0;">${escapeHtmlClient(err.message)}</p>
                    </div>
                </div>
            `;
        });
};

window.openRecentActivityModal = function() {
    const container = getOrCreateModalContainer();
    container.hidden = false;
    document.body.classList.add('modal-open');

    // Loading skeleton
    container.innerHTML = `
        <div class="app-modal-card" onclick="event.stopPropagation()">
            <button type="button" class="app-modal-close" onclick="window.closeAppModal()">&times;</button>
            <div style="text-align: center; padding: 40px 20px; color: var(--text-muted, #94a3b8);">
                <div style="display: inline-block; width: 32px; height: 32px; border: 3px solid rgba(255,85,0,0.3); border-top-color: var(--primary, #ff5500); border-radius: 50%; animation: spin 0.8s linear infinite; margin-bottom: 12px;"></div>
                <div style="font-weight: 600;">Načítám tvé nedávné výsledky...</div>
            </div>
        </div>
    `;

    const urlParams = new URLSearchParams(window.location.search);
    const liga = urlParams.get('liga') || '';
    const season = urlParams.get('season') || '';

    fetch(`/api/recent-activity?liga=${encodeURIComponent(liga)}&season=${encodeURIComponent(season)}`)
        .then(res => {
            if (!res.ok) throw new Error('Nepodařilo se načíst nedávné výsledky.');
            return res.json();
        })
        .then(data => {
            const { results, totalEarned, totalPossible } = data;
            const pct = totalPossible > 0 ? Math.round((totalEarned / totalPossible) * 100) : 0;

            let matchesListHtml;
            if (results && results.length > 0) {
                matchesListHtml = results.map(m => {
                    let tipBadgeHtml;
                    if (!m.userPicked) {
                        tipBadgeHtml = `<span class="activity-tip-badge untipped">Netipováno (0b)</span>`;
                    } else if (m.isCorrect) {
                        tipBadgeHtml = `<span class="activity-tip-badge correct">✓ Tip: ${escapeHtmlClient(m.userPicked)} (+${m.points}b)</span>`;
                    } else {
                        tipBadgeHtml = `<span class="activity-tip-badge wrong">✗ Tip: ${escapeHtmlClient(m.userPicked)} (0b)</span>`;
                    }

                    const totalCommunity = m.community.home + m.community.away;
                    const correctCount = m.winner === 'home' ? m.community.home : (m.winner === 'away' ? m.community.away : 0);
                    const communityPct = totalCommunity > 0 ? Math.round((correctCount / totalCommunity) * 100) : 0;

                    return `
                        <div class="activity-match-card">
                            <div class="activity-match-top">
                                <div class="activity-teams">
                                    <img src="${m.homeLogo}" alt="">
                                    <span>${escapeHtmlClient(m.homeName)}</span>
                                    <span style="color: var(--text-dim); margin: 0 2px;">vs</span>
                                    <span>${escapeHtmlClient(m.awayName)}</span>
                                    <img src="${m.awayLogo}" alt="">
                                </div>
                                <span class="activity-score-badge">${m.score}${m.ot ? '<small style="font-size:10px; color:var(--accent-amber);">p</small>' : ''}</span>
                            </div>
                            <div class="activity-match-bottom">
                                ${tipBadgeHtml}
                                <span class="activity-community-stats">Trefilo ${correctCount} z ${totalCommunity} tipérů (${communityPct}%)</span>
                            </div>
                        </div>
                    `;
                }).join('');
            } else {
                matchesListHtml = `
                    <div style="text-align: center; padding: 30px 10px; color: var(--text-dim, #64748b);">
                        Zatím zde nejsou žádné vyhodnocené zápasy.
                    </div>
                `;
            }

            container.innerHTML = `
                <div class="app-modal-card" onclick="event.stopPropagation()">
                    <button type="button" class="app-modal-close" onclick="window.closeAppModal()">&times;</button>
                    
                    <div style="margin-bottom: 16px;">
                        <h3 style="margin: 0 0 4px 0; font-size: 18px; font-weight: 800; color: #fff; display: flex; align-items: center; gap: 8px;">
                            ⚡ Nedávné výsledky & Tvoje body
                        </h3>
                        <p style="margin: 0; font-size: 12px; color: var(--text-muted, #94a3b8);">Rychlý přehled tvých trefených tipů z posledních odehraných zápasů</p>
                    </div>

                    <div class="activity-banner">
                        <div class="activity-banner-stats">
                            <span class="activity-banner-title">Bilance z posledních ${totalPossible} zápasů</span>
                            <span class="activity-banner-score">+${totalEarned} bodů</span>
                        </div>
                        <div style="text-align: right;">
                            <span style="font-size: 20px; font-weight: 800; color: ${pct >= 50 ? 'var(--accent-green, #22c55e)' : '#f87171'}; font-family: 'JetBrains Mono', monospace;">${pct}%</span>
                            <div style="font-size: 10px; color: var(--text-dim, #64748b);">úspěšnost</div>
                        </div>
                    </div>

                    <div class="modal-section-title">Poslední odehrané zápasy</div>
                    <div class="activity-matches-list">
                        ${matchesListHtml}
                    </div>
                </div>
            `;
        })
        .catch(err => {
            container.innerHTML = `
                <div class="app-modal-card" onclick="event.stopPropagation()">
                    <button type="button" class="app-modal-close" onclick="window.closeAppModal()">&times;</button>
                    <div style="text-align: center; padding: 30px; color: #f87171;">
                        <p style="font-weight: 700; margin: 0 0 8px 0;">Chyba načtení</p>
                        <p style="font-size: 12px; color: var(--text-muted); margin: 0;">${escapeHtmlClient(err.message)}</p>
                    </div>
                </div>
            `;
        });
};
