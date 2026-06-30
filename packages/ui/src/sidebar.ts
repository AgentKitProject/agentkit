// Pure (no React/browser globals) helpers for the AppShell collapsible sidebar,
// mirroring ./theme.ts. `sidebarInitScript` is emitted from server root layouts
// to set the collapse attribute BEFORE paint (no width flash); the client
// `SidebarCollapseToggle` reads/writes the same key + attribute.

/** localStorage key the AppShell persists the collapsed/expanded choice under. */
export const SIDEBAR_STORAGE_KEY = "ak-sidebar-collapsed";

/** Attribute set on <html> that the CSS rail rules key off. */
export const SIDEBAR_ATTR = "data-ak-sidebar";

/**
 * FOUC-free inline `<head>` script (as a string) that sets `data-ak-sidebar`
 * on <html> BEFORE React hydrates, from `localStorage("ak-sidebar-collapsed")`.
 * Apps drop this next to `themeInitScript`. Default (no stored pref) = expanded.
 */
export function sidebarInitScript(storageKey: string = SIDEBAR_STORAGE_KEY): string {
  return `(function(){try{if(localStorage.getItem(${JSON.stringify(
    storageKey,
  )})==="1"){document.documentElement.setAttribute(${JSON.stringify(
    SIDEBAR_ATTR,
  )},"collapsed");}}catch(e){}})();`;
}
