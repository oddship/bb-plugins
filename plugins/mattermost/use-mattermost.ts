import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc, useRealtime, useSettings } from "@get-bb/plugin-sdk/app";
import type { rpcContract, Request, ReadResult } from "./contract";

// Session cache removes RPC roundtrips on back navigation; disk cache is server-owned.
const snapshots = new Map<string, ReadResult>();
const keyOf = (host: string, request: Request) =>
  JSON.stringify([host, { ...request, refresh: undefined }]);
export function useMattermost(request: Request | null) {
  const rpc = useRpc<typeof rpcContract>();
  const { values } = useSettings();
  const host = String(values?.hostId ?? "");
  const key = request ? keyOf(host, request) : "";
  const [state, setState] = useState<{
    key: string;
    result?: ReadResult;
    error?: string;
    pending: boolean;
  }>({ key, pending: false });
  const sequence = useRef(0);
  const serialized = JSON.stringify(request);
  const load = useCallback(
    (force = false) => {
      const req = JSON.parse(serialized) as Request | null;
      if (!req) return;
      const current = ++sequence.current;
      setState((previous) => ({
        key,
        result: previous.key === key ? previous.result : snapshots.get(key),
        pending: true,
      }));
      rpc
        .call("read", { ...req, ...(force ? { refresh: true } : {}) })
        .then((result) => {
          if (sequence.current !== current) return;
          snapshots.delete(key);
          snapshots.set(key, result);
          while (
            snapshots.size > 40 ||
            ([...snapshots.values()].reduce(
              (n, v) => n + JSON.stringify(v).length,
              0,
            ) >
              8 * 1024 * 1024 &&
              snapshots.size > 1)
          )
            snapshots.delete(snapshots.keys().next().value!);
          setState({ key, result, pending: false });
        })
        .catch((cause) => {
          if (sequence.current !== current) return;
          setState((previous) => ({
            key,
            result: previous.key === key ? previous.result : snapshots.get(key),
            pending: false,
            error:
              cause instanceof Error
                ? cause.message
                : "Could not load Mattermost.",
          }));
        });
    },
    [key, serialized, rpc],
  );
  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 60_000);
    const focus = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", focus);
    return () => {
      sequence.current++;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [load]);
  useRealtime("updated", (event: unknown) => {
    const eventKey = (event as { key?: string })?.key;
    if (eventKey === key) load();
  });
  useRealtime("reset", () => {
    snapshots.clear();
    sequence.current++;
    setState({ key: "", pending: false });
    load();
  });
  const result = state.key === key ? state.result : snapshots.get(key);
  return {
    result,
    pending: state.key === key ? state.pending : !!request,
    error: state.key === key ? state.error : undefined,
    refresh: () => load(true),
  };
}
