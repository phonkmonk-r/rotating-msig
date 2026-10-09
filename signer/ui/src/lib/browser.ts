import type { BrowserTab } from "../api";

/** A tab's name in the tab strip: the page title, else its host, else "New tab". */
export function tabLabel(tab: Pick<BrowserTab, "title" | "url">): string {
  const title = tab.title.trim();
  if (title && title !== tab.url) return title;
  try {
    const { protocol, host } = new URL(tab.url);
    if (protocol === "https:" || protocol === "http:") return host;
  } catch {
    // Not a URL yet: a new tab.
  }
  return "New tab";
}
