/**
 * Match tips popover interactions
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

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        document.querySelectorAll('.tips-popover:not([hidden])').forEach(p => {
            p.hidden = true;
        });
    }
});
