/**
 * Appearance cache key — kept in its own file on purpose.
 *
 * The panel's Content-Security-Policy allows only `script-src 'self' file:`, so an
 * inline <script> that set this global would be blocked. The key would then stay
 * undefined and appearance-boot.js would fall back to the shared default
 * (`pi.appearance.v1`), letting another plugin's cached palette and plugin theme
 * CSS decide this panel's first paint.
 */
window.__APPEARANCE_CACHE_KEY = "pi.session-orchestrator.appearance.v1";
