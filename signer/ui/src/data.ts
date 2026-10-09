import { useCallback, useEffect, useRef, useState } from "react";

import { api, canConnect, type DraftView, type Execution, type QueueItem, type StatusView } from "./api";

const REFRESH_MS = 10_000;

export interface SignerData {
  status?: StatusView;
  queue: QueueItem[];
  /** The local queue of actions not yet proposed. */
  draft: DraftView;
  /** Executions this signer started recently, also after their transaction left the queue. */
  executions: Execution[];
  error?: string;
  updatedAt?: Date;
  refreshing: boolean;
  refresh: () => Promise<void>;
  /** Pauses polling while a signing action runs, then refreshes. */
  setBusy: (busy: boolean) => void;
  /** Turns queue mode on or off. The switch flips at once; the server's reply replaces it, or the old value returns on failure. */
  setQueueMode: (enabled: boolean) => Promise<void>;
}

/** Polls status and queue; every page reads the same snapshot. */
export function useSignerData(): SignerData {
  const [status, setStatus] = useState<StatusView>();
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [draft, setDraft] = useState<DraftView>({ enabled: false, items: [] });
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [error, setError] = useState<string>();
  const [updatedAt, setUpdatedAt] = useState<Date>();
  const [refreshing, setRefreshing] = useState(false);
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    setRefreshing(true);
    try {
      // The queue comes from the Transaction Service, which can be briefly unavailable or rate-limited: keep the last
      // queue then, and let the status's own queueError warn, instead of reporting the signer as unreachable.
      const [nextStatus, nextQueue, nextDraft, nextExecutions] = await Promise.all([
        api.status(),
        api.queue().catch(() => undefined),
        api.draft(),
        api.executions().catch(() => undefined),
      ]);
      setStatus(nextStatus);
      if (nextQueue) setQueue(nextQueue);
      setDraft(nextDraft);
      if (nextExecutions) setExecutions(nextExecutions);
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

  const setQueueMode = useCallback(async (enabled: boolean) => {
    let previous: DraftView | undefined;
    setDraft((current) => {
      previous = current;
      return { ...current, enabled };
    });
    try {
      setDraft(await api.draftMode(enabled));
    } catch (caught) {
      if (previous) setDraft(previous);
      setError((caught as Error).message);
    }
  }, []);

  return { status, queue, draft, executions, error, updatedAt, refreshing, refresh, setBusy, setQueueMode };
}

export const LOW_GAS_WEI = 5_000_000_000_000_000n;
