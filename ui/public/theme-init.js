/* Sets the theme before first paint so there is no flash of the wrong one.
   Loaded as a blocking script from <head> (the CSP only allows same-origin scripts,
   so this cannot be inline). Keep in step with src/lib/theme.ts: theme.test.ts
   executes this file and compares it to that module. Plain ES5 on purpose. */
(function () {
  var mode = "system";

  try {
    var stored = window.localStorage.getItem("shipflow.theme");

    if (stored === "light" || stored === "dark" || stored === "system") mode = stored;
  } catch (error) {
    /* storage blocked: stay on "system" */
  }

  var dark = false;

  try {
    dark = window.matchMedia("(prefers-color-scheme: dark)").matches === true;
  } catch (error) {
    /* no matchMedia: light */
  }

  var root = document.documentElement;

  root.setAttribute("data-theme", mode === "system" ? (dark ? "dark" : "light") : mode);
  root.setAttribute("data-theme-mode", mode);
})();
