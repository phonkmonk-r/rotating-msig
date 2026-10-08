import { describeRevert, readSafeState, type SafeState } from "@rotating-msig/core";
import { useCallback, useEffect, useState } from "react";
import type { Address, PublicClient } from "viem";

const REFRESH_MS = 12_000;

export interface SafeStateHandle {
  state?: SafeState;
  error?: string;
  loading: boolean;
  updatedAt?: Date;
  refresh: () => Promise<void>;
}

/** Polls the Safe and its guard; every tab reads the same snapshot. */
export function useSafeState(client: PublicClient, safe: Address, guard?: Address): SafeStateHandle {
  const [state, setState] = useState<SafeState>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date>();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setState(await readSafeState(client, safe, guard));
      setError(undefined);
      setUpdatedAt(new Date());
    } catch (caught) {
      setError(describeRevert(caught) ?? (caught as Error).message);
    } finally {
      setLoading(false);
    }
  }, [client, safe, guard]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  return { state, error, loading, updatedAt, refresh };
}
