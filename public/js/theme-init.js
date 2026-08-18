(function () {
    var user = document.documentElement.getAttribute('data-user') || '';
    
    // 1. UI Mode Init (Standard vs Minimal)
    var defaultMode = document.documentElement.getAttribute('data-ui-mode') || 'standard';
    var savedMode = defaultMode;
    try {
        var userModeKey = user ? ('videohosk_uimode_' + user) : '';
        var userSavedMode = userModeKey ? localStorage.getItem(userModeKey) : null;
        if (userSavedMode === 'minimal' || userSavedMode === 'standard') {
            savedMode = userSavedMode;
        } else {
            var globalSavedMode = localStorage.getItem('videohosk_uimode');
            if (globalSavedMode === 'minimal' || globalSavedMode === 'standard') {
                savedMode = globalSavedMode;
            }
        }
    } catch (e) {}
    document.documentElement.setAttribute('data-ui-mode', savedMode);

    // 2. Palette Theme Init
    var defaultTheme = (user === 'hajera') ? 'sunset' : 'cinematic';
    var savedTheme = defaultTheme;
    try {
        var userKey = user ? ('videohosk_theme_' + user) : '';
        var userSaved = userKey ? localStorage.getItem(userKey) : null;
        if (userSaved) {
            savedTheme = userSaved;
        } else if (user === 'hajera') {
            savedTheme = 'sunset';
        } else {
            savedTheme = localStorage.getItem('videohosk_theme') || defaultTheme;
        }
    } catch (e) {}
    document.documentElement.setAttribute('data-theme', savedTheme);
})();

