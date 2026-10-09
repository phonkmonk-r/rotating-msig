import { browser, type Bookmark } from "./api";
import { IconClose } from "./icons";
import { tabLabel } from "./lib/browser";

/** The saved pages under Browse dApps in the sidebar: each opens in a new browser tab. */
export function SavedPages({ saved, onOpened }: { saved: Bookmark[]; onOpened: () => void }) {
  if (saved.length === 0) {
    return <p className="saved-empty muted small">Save a page with the star in the browser's address bar to open it from here.</p>;
  }
  return (
    <ul className="saved-list" aria-label="Saved pages">
      {saved.map((item) => {
        const label = tabLabel(item);
        return (
          <li key={item.url} className="saved-item">
            <button type="button" className="saved-open" title={item.url} onClick={() => void browser!.newTab(item.url).then(onOpened)}>
              <span className="saved-label">{label}</span>
            </button>
            <button type="button" className="saved-remove icon-button" aria-label={`Remove ${label}`} title="Remove" onClick={() => void browser!.removeBookmark(item.url)}>
              <IconClose width="12" height="12" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
