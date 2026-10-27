import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_useAppPanel,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract, Selection } from "./contract";
import { Button } from "./components/ui/button";
import { Icon } from "./components/ui/icon";
import "./app.css";

type Session = {
  url: string;
  root: string;
  environmentId: string;
  hostId: string;
  key: string;
};
function ReviewPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [instruction, setInstruction] = useState("");
  const [notice, setNotice] = useState("");
  const paused = useRef(false);
  const iframe = useRef<HTMLIFrameElement>(null);
  const sessionRef = useRef<Session | null>(null);
  const requestId = useRef(crypto.randomUUID());
  const sending = useRef(false);
  const remote =
    location.protocol === "https:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  const post = useCallback((data: unknown) => {
    const s = sessionRef.current;
    if (s)
      iframe.current?.contentWindow?.postMessage(data, new URL(s.url).origin);
  }, []);
  const syncTheme = useCallback(
    () =>
      post({
        type: "bb:theme",
        theme:
          document.documentElement.classList.contains("dark") ||
          document.documentElement.dataset.theme === "dark"
            ? "dark"
            : "light",
      }),
    [post],
  );
  const open = useCallback(async () => {
    paused.current = false;
    const s = await rpcRef.current.call("open", {
      threadId,
      origin: location.origin,
      remote,
    });
    sessionRef.current = s;
    setSession((prev) =>
      prev?.key === s.key && prev.url === s.url ? prev : s,
    );
    setError("");
    setStopped(false);
  }, [threadId, remote]);
  useEffect(() => {
    let alive = true;
    setSession(null);
    sessionRef.current = null;
    setSelection(null);
    setError("");
    setStopped(false);
    const refresh = () => {
      if (paused.current) return;
      return open().catch((e) => {
        if (alive) setError(String(e instanceof Error ? e.message : e));
      });
    };
    void refresh();
    const timer = setInterval(refresh, 30000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [open]);
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const s = sessionRef.current;
      if (
        !s ||
        event.source !== iframe.current?.contentWindow ||
        event.origin !== new URL(s.url).origin
      )
        return;
      const d = event.data;
      if (!d || typeof d !== "object") return;
      if (d.type === "px0:ready") syncTheme();
      if (
        d.type === "px0:selection" &&
        typeof d.path === "string" &&
        typeof d.text === "string" &&
        Number.isInteger(d.l1) &&
        Number.isInteger(d.l2) &&
        d.l1 > 0 &&
        d.l2 >= d.l1 &&
        d.text.length <= 24000
      ) {
        setSelection({ path: d.path, l1: d.l1, l2: d.l2, text: d.text });
        setInstruction("");
        setNotice("");
        requestId.current = crypto.randomUUID();
      }
    };
    window.addEventListener("message", listener);
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });
    return () => {
      window.removeEventListener("message", listener);
      observer.disconnect();
    };
  }, [syncTheme]);
  useRealtime("sessions-changed", () => {
    post({ type: "bb:refresh" });
  });
  async function send() {
    if (!session || !selection || !instruction.trim() || sending.current)
      return;
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      await rpc.call("feedback", {
        threadId,
        environmentId: session.environmentId,
        requestId: requestId.current,
        selection,
        instruction,
      });
      setSelection(null);
      setInstruction("");
      setNotice("Feedback sent to this BB thread.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="px0-panel">
      <div className="px0-toolbar">
        <span className="px0-root" title={session?.root}>
          {session?.root.split("/").pop() ?? "px0 Review"}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => post({ type: "bb:refresh" })}
          disabled={!session}
        >
          Refresh
        </Button>
        {session && (
          <a
            className="px0-link"
            href={session.url}
            target="_blank"
            rel="noreferrer"
          >
            Open full view <Icon name="ExternalLink" className="size-3" />
          </a>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={!session}
          onClick={async () => {
            paused.current = true;
            try {
              await rpc.call("stop", { threadId });
              sessionRef.current = null;
              setSession(null);
              setStopped(true);
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          Stop
        </Button>
      </div>
      {error && (
        <div role="alert" className="px0-error">
          {error}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void open().catch((e) => setError(String(e)))}
          >
            Retry
          </Button>
        </div>
      )}
      {notice && (
        <div role="status" className="px0-notice">
          {notice}
        </div>
      )}
      {selection && (
        <form
          className="px0-feedback"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <div className="px0-feedback-title">
            Feedback for {selection.path}:{selection.l1}–{selection.l2}
            <Button
              size="sm"
              variant="ghost"
              type="button"
              onClick={() => setSelection(null)}
            >
              Cancel
            </Button>
          </div>
          <textarea
            autoFocus
            aria-label="Review feedback"
            placeholder="What should the agent change or investigate?"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
          />
          <Button
            size="sm"
            type="submit"
            disabled={busy || !instruction.trim()}
          >
            {busy ? "Sending…" : "Send to BB thread"}
          </Button>
        </form>
      )}
      {session ? (
        <iframe
          ref={iframe}
          className="px0-frame"
          title="px0 code review"
          src={session.url}
          onLoad={syncTheme}
          referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin allow-downloads allow-forms"
        />
      ) : (
        <div className="px0-empty">
          {stopped ? (
            <>
              <span>Review stopped.</span>
              <Button
                size="sm"
                onClick={() => void open().catch((e) => setError(String(e)))}
              >
                Open review
              </Button>
            </>
          ) : (
            <>
              <span>
                {error
                  ? "Review could not start."
                  : "Starting px0 for this worktree…"}
              </span>
              <span>
                Select code in px0, then choose “Send to BB” to discuss it in
                this thread.
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
function HeaderAction({ threadId }: { threadId: string }) {
  const panel = experimental_useAppPanel();
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Review code with px0"
      onClick={() =>
        panel.experimental_openTab({
          surface: { kind: "current" },
          tab: {
            id: "review",
            context: { kind: "thread" },
            availability: "action",
          },
        })
      }
    >
      <Icon name="FileText" className="size-4" />
    </Button>
  );
}
export default definePluginApp((app) => {
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: "review",
    title: "px0 Review",
    tooltip: "Review this worktree with px0",
    icon: "FileText",
    layout: "flush",
    component: ReviewPanel,
  });
  app.slots.experimental_threadHeaderAction({
    id: "review",
    title: "Review code with px0",
    component: HeaderAction,
  });
});
