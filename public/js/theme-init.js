(function () {
    try {
        var doc = document.documentElement;
        var user = doc.getAttribute('data-user') || '';

        function getCookie(name) {
            var match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
            return match ? decodeURIComponent(match[1]) : null;
        }

        var validThemes = { 'cinematic': 1, 'cyberpunk': 1, 'emerald': 1, 'sunset': 1 };
        var validModes = { 'standard': 1, 'minimal': 1 };
        var themeMetaColors = {
            cinematic: '#060609',
            cyberpunk: '#05050d',
            emerald: '#030806',
            sunset: '#0c040a'
        };

        // 1. UI Mode Init (Standard vs Minimal)
        var serverMode = doc.getAttribute('data-ui-mode');
        var resolvedMode = null;

        if (user) {
            var userSavedMode = localStorage.getItem('videohosk_uimode_' + user);
            if (userSavedMode && validModes[userSavedMode]) {
                resolvedMode = userSavedMode;
            }
        }
        if (!resolvedMode && serverMode && validModes[serverMode]) {
            resolvedMode = serverMode;
        }
        if (!resolvedMode) {
            var cookieMode = getCookie('videohosk_uimode');
            if (cookieMode && validModes[cookieMode]) {
                resolvedMode = cookieMode;
            }
        }
        if (!resolvedMode) {
            var globalSavedMode = localStorage.getItem('videohosk_uimode');
            if (globalSavedMode && validModes[globalSavedMode]) {
                resolvedMode = globalSavedMode;
            }
        }
        if (!resolvedMode) {
            resolvedMode = 'standard';
        }
        doc.setAttribute('data-ui-mode', resolvedMode);

        // 2. Palette Theme Init
        var serverTheme = doc.getAttribute('data-theme');
        var userDefaultTheme = (user === 'hajera') ? 'sunset' : 'cinematic';
        var resolvedTheme = null;

        if (user) {
            var userSavedTheme = localStorage.getItem('videohosk_theme_' + user);
            if (userSavedTheme && validThemes[userSavedTheme]) {
                resolvedTheme = userSavedTheme;
            }
        }
        if (!resolvedTheme && serverTheme && validThemes[serverTheme]) {
            resolvedTheme = serverTheme;
        }
        if (!resolvedTheme) {
            var cookieTheme = getCookie('videohosk_theme');
            if (cookieTheme && validThemes[cookieTheme]) {
                resolvedTheme = cookieTheme;
            }
        }
        if (!resolvedTheme) {
            var globalSavedTheme = localStorage.getItem('videohosk_theme');
            if (globalSavedTheme && validThemes[globalSavedTheme]) {
                resolvedTheme = globalSavedTheme;
            }
        }
        if (!resolvedTheme) {
            resolvedTheme = userDefaultTheme;
        }
        doc.setAttribute('data-theme', resolvedTheme);

        // Sync to storage & cookies immediately
        if (user) {
            localStorage.setItem('videohosk_theme_' + user, resolvedTheme);
            localStorage.setItem('videohosk_uimode_' + user, resolvedMode);
        }
        localStorage.setItem('videohosk_theme', resolvedTheme);
        localStorage.setItem('videohosk_uimode', resolvedMode);
        document.cookie = 'videohosk_theme=' + encodeURIComponent(resolvedTheme) + '; path=/; max-age=31536000; SameSite=Lax';
        document.cookie = 'videohosk_uimode=' + encodeURIComponent(resolvedMode) + '; path=/; max-age=31536000; SameSite=Lax';

        // Sync meta theme-color if present
        var metaTheme = document.querySelector('meta[name="theme-color"]');
        if (metaTheme && themeMetaColors[resolvedTheme]) {
            metaTheme.setAttribute('content', themeMetaColors[resolvedTheme]);
        }
    } catch (e) {}
})();


