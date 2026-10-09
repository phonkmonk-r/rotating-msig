import { useRef, useState } from "react";

import { browser, type Bookmark } from "./api";
import { IconClose, IconGlobe } from "./icons";
import { tabLabel } from "./lib/browser";

const DOUBLE_CLICK_MS = 250;

/** The saved pages under Browse dApps in the sidebar: each opens in a new browser tab; double-click a name to rename it. */
export function SavedPages({ saved, onOpened }: { saved: Bookmark[]; onOpened: () => void }) {
  const [editing, setEditing] = useState<string>();
  const [name, setName] = useState("");
  // A click waits briefly, so the first click of a double-click (rename) does not also open the page.
  const pendingOpen = useRef<ReturnType<typeof setTimeout>>(undefined);

  if (saved.length === 0) {
    return <p className="saved-empty muted small">Save a page with the star in the browser's address bar to open it from here.</p>;
  }

  const finish = (item: Bookmark, keep: boolean) => {
    setEditing(undefined);
    if (keep && name.trim() !== item.title) void browser!.renameBookmark(item.url, name);
  };

  return (
    <ul className="saved-list" aria-label="Saved pages">
      {saved.map((item) => {
        const label = tabLabel(item);
        const icon = item.icon ? <img className="site-icon" src={item.icon} alt="" /> : <IconGlobe width="13" height="13" />;
        if (editing === item.url) {
          return (
            <li key={item.url} className="saved-item">
              <span className="saved-rename">
                {icon}
                <input
                  autoFocus
                  aria-label={`Rename ${label}`}
                  value={name}
                  maxLength={80}
                  onChange={(e) => setName(e.target.value)}
                  onFocus={(e) => e.target.select()}
                  onBlur={() => finish(item, true)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") finish(item, true);
                    if (e.key === "Escape") finish(item, false);
                  }}
                />
              </span>
            </li>
          );
        }
        return (
          <li key={item.url} className="saved-item">
            <button
              type="button"
              className="saved-open"
              title={`${item.url}\nDouble-click to rename`}
              onClick={(e) => {
                if (e.detail > 1) return;
                clearTimeout(pendingOpen.current);
                pendingOpen.current = setTimeout(() => void browser!.newTab(item.url).then(onOpened), DOUBLE_CLICK_MS);
              }}
              onDoubleClick={() => {
                clearTimeout(pendingOpen.current);
                setName(item.title || label);
                setEditing(item.url);
              }}
            >
              {icon}
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
