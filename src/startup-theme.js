// Startup theme (classic script, runs before the app): avoids a dark flash
// for users who chose the light theme. Same-origin file instead of an inline
// script, so the Web CSP stays `script-src 'self'` (CANVAS-012c5 item 4).
// vite.config.ts emits it into the versioned assets folder and loads it first.
try {
  const startupTheme = localStorage.getItem("infinite-canvas:theme") === "light" ? "light" : "dark";
  document.documentElement.dataset.startupTheme = startupTheme;
  document.documentElement.style.colorScheme = startupTheme;
} catch {
  document.documentElement.dataset.startupTheme = "dark";
  document.documentElement.style.colorScheme = "dark";
}
