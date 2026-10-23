const fontStylesheetUrl =
    "https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&display=swap";

function loadPoppins() {
    if (document.querySelector('link[data-fonts="poppins"]')) return;

    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.media = "print";
    stylesheet.href = fontStylesheetUrl;
    stylesheet.dataset.fonts = "poppins";
    stylesheet.onload = () => {
        stylesheet.media = "all";
    };
    stylesheet.onerror = () => {
        console.error("Could not load the Poppins font stylesheet.");
    };
    document.head.append(stylesheet);
}

window.setTimeout(loadPoppins, 0);
