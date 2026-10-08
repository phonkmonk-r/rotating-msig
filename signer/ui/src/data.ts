import { useCallback, useEffect, useRef, useState } from "react";

import { api, canConnect, type DraftView, type QueueItem, type StatusView } from "./api";

const REFRESH_MS = 10_000;

export interface SignerData {
  status?: StatusView;
  queue: QueueItem[];
  /** The local queue of actions not yet proposed. */
  draft: DraftView;
  error?: string;
  updatedAt?: Date;
  refreshing: boolean;
  refresh: () => Promise<void>;
  /** Pauses polling while a signing action runs, then refreshes. */
  setBusy: (busy: boolean) => void;
}

/** Polls status and queue; every page reads the same snapshot. */
export function useSignerData(): SignerData {
  const [status, setStatus] = useState<StatusView>();
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [draft, setDraft] = useState<DraftView>({ enabled: false, items: [] });
  const [error, setError] = useState<string>();
  const [updatedAt, setUpdatedAt] = useState<Date>();
  const [refreshing, setRefreshing] = useState(false);
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    setRefreshing(true);
    try {
      const [nextStatus, nextQueue, nextDraft] = await Promise.all([api.status(), api.queue(), api.draft()]);
      setStatus(nextStatus);
      setQueue(nextQueue);
      setDraft(nextDraft);
      setError(undefined);
      setUpdatedAt(new Date());
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!canConnect) return;
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const setBusy = useCallback(
    (value: boolean) => {
      busy.current = value;
      if (!value) void refresh();
    },
    [refresh],
  );

  return { status, queue, draft, error, updatedAt, refreshing, refresh, setBusy };
}

export const LOW_GAS_WEI = 5_000_000_000_000_000n;
