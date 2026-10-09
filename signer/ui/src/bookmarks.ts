import { useEffect, useState } from "react";

import { browser, type Bookmark } from "./api";

/** The profile's saved pages, kept in sync with every change from the main process. */
export function useBookmarks(): Bookmark[] {
  const [list, setList] = useState<Bookmark[]>([]);
  useEffect(() => {
    if (!browser) return;
    void browser.bookmarks().then(setList, () => undefined);
    return browser.onBookmarks(setList);
  }, []);
  return list;
}
