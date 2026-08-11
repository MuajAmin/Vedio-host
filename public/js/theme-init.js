(function () {
    var savedTheme = 'cinematic';
    try { savedTheme = localStorage.getItem('videohosk_theme') || savedTheme; } catch (e) {}
    document.documentElement.setAttribute('data-theme', savedTheme);
})();
