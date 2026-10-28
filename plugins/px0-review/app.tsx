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
import { Tooltip } from "./components/ui/tooltip";
import "./app.css";

type Session = {
  url: string;
  root: string;
  environmentId: string;
  hostId: string;
  key: string;
  fileCount: number | null;
};
function sameViewer(a: Session | null, b: Session | null) {
  return (
    !!a &&
    !!b &&
    a.key === b.key &&
    a.url === b.url &&
    a.environmentId === b.environmentId &&
    a.hostId === b.hostId &&
    a.root === b.root
  );
}
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
  const mounted = useRef(false);
  const generation = useRef(0);
  const draftSession = useRef<Session | null>(null);
  const stopping = useRef(false);
  const clearDraft = useCallback(() => {
    draftSession.current = null;
    requestId.current = crypto.randomUUID();
    setSelection(null);
    setInstruction("");
    setNotice("");
  }, []);
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
    if (stopping.current) return;
    paused.current = false;
    const attempt = ++generation.current;
    const current = () =>
      mounted.current && !paused.current && generation.current === attempt;
    try {
      const s = await rpcRef.current.call("open", {
        threadId,
        origin: location.origin,
        remote,
      });
      if (!current()) return;
      if (!sameViewer(sessionRef.current, s)) clearDraft();
      sessionRef.current = s;
      setSession((prev) =>
        prev?.key === s.key &&
        prev.url === s.url &&
        prev.fileCount === s.fileCount
          ? prev
          : s,
      );
      setError("");
      setStopped(false);
    } catch (e) {
      if (current()) setError(e instanceof Error ? e.message : String(e));
    }
  }, [threadId, remote, clearDraft]);
  useEffect(() => {
    mounted.current = true;
    paused.current = false;
    setSession(null);
    sessionRef.current = null;
    clearDraft();
    setError("");
    setStopped(false);
    const refresh = () => {
      if (paused.current) return;
      return open();
    };
    void refresh();
    const timer = setInterval(refresh, 30000);
    return () => {
      mounted.current = false;
      generation.current++;
      clearInterval(timer);
    };
  }, [open, clearDraft]);
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
        draftSession.current = s;
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
    const source = draftSession.current;
    if (!sameViewer(source, sessionRef.current)) {
      clearDraft();
      return;
    }
    const sentRequest = requestId.current;
    const current = () =>
      mounted.current &&
      requestId.current === sentRequest &&
      sameViewer(source, sessionRef.current);
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      await rpc.call("feedback", {
        threadId,
        environmentId: source!.environmentId,
        requestId: sentRequest,
        selection,
        instruction,
      });
      if (current()) {
        clearDraft();
        setNotice("Feedback sent to this BB thread.");
      }
    } catch (e) {
      if (current()) setError(e instanceof Error ? e.message : String(e));
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
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
            if (stopping.current) return;
            stopping.current = true;
            paused.current = true;
            const attempt = ++generation.current;
            clearDraft();
            try {
              await rpc.call("stop", { threadId });
              if (!mounted.current || generation.current !== attempt) return;
              sessionRef.current = null;
              setSession(null);
              setStopped(true);
            } catch (e) {
              if (mounted.current && generation.current === attempt)
                setError(String(e));
            } finally {
              stopping.current = false;
            }
          }}
        >
          Stop
        </Button>
      </div>
      {session?.fileCount === 0 && (
        <div className="px0-workspace-empty" role="status">
          <strong>No files in this thread’s workspace yet.</strong>
          <code>{session.root}</code>
          <span>
            px0 shows this folder’s files. Choose a thread with a repository, or
            change this thread’s working directory to review existing code.
          </span>
        </div>
      )}
      {error && (
        <div role="alert" className="px0-error">
          {error}
          <Button size="sm" variant="secondary" onClick={() => void open()}>
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
              onClick={clearDraft}
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
              <Button size="sm" onClick={() => void open()}>
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
    <Tooltip label="px0 · Review this workspace">
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
    </Tooltip>
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
    component: ({ threadId }) => (
      <ReviewPanel key={threadId} threadId={threadId} />
    ),
  });
  app.slots.experimental_threadHeaderAction({
    id: "review",
    title: "Review code with px0",
    component: HeaderAction,
  });
});
