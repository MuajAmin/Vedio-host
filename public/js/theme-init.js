(function () {
    var user = document.documentElement.getAttribute('data-user') || '';
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
