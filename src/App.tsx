import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { currentMonitor, getCurrentWindow, primaryMonitor, type Monitor } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { anchorCompact, captureView, dockCompact, fitDetails, restoreView, type WindowView } from "./windowLayout";
import "./App.css";

type UsageWindow = { label: string; usedPercent: number; resetsAt: number | null };
type ProviderUsage = { accountEmail: string | null; plan: string | null; source: string; updatedAt: number; windows: UsageWindow[] };
type Reading = { data?: ProviderUsage; error?: string; loading: boolean; active?: boolean };
type Provider = "codex" | "claude";
type Login = { provider: Provider; loginId: string; authUrl: string };
const cacheKey = "usage-widget.codex-accounts.v2";

function initialReadings(): Record<string, Reading> {
  const readings: Record<string, Reading> = { claude: { loading: false } };
  try {
    const cache = JSON.parse(localStorage.getItem(cacheKey) || localStorage.getItem("usage-widget.codex-accounts.v1") || "{}");
    for (const data of Object.values(cache) as ProviderUsage[]) {
      if (typeof data?.accountEmail === "string" && data.accountEmail.includes("@") && Number.isFinite(data.updatedAt)
        && typeof data.source === "string" && Array.isArray(data.windows) && data.windows.length > 0
        && data.windows.every(window => typeof window.label === "string" && Number.isFinite(window.usedPercent)
          && window.usedPercent >= 0 && window.usedPercent <= 100 && (window.resetsAt === null || Number.isFinite(window.resetsAt)))) {
        readings[`codex:${data.accountEmail.toLowerCase()}`] = { data, loading: false, active: false };
      }
    }
  } catch { /* An unavailable or invalid cache must not block fresh usage. */ }
  return readings;
}
const refreshMs = 120_000;
const resetTimeZone = "Asia/Manila";
const resetTimeFormatter = new Intl.DateTimeFormat("en-PH", { timeZone: resetTimeZone, hour: "numeric", minute: "2-digit", hour12: true });
const resetDateFormatter = new Intl.DateTimeFormat("en-PH", { timeZone: resetTimeZone, month: "short", day: "numeric" });

function resetSchedule(usage: UsageWindow) {
  if (usage.resetsAt === null) return "No reset yet";
  const reset = new Date(usage.resetsAt * 1000);
  const time = resetTimeFormatter.format(reset);
  return `↻ ${usage.label.toLowerCase().includes("weekly") ? `${resetDateFormatter.format(reset)}, ` : ""}${time}`;
}

// Compact meters only have room for a couple of characters.
function shortLabel(label: string) {
  if (label.toLowerCase().includes("weekly")) return "Wk";
  const span = label.match(/^(\d+)-(hour|minute)/);
  return span ? `${span[1]}${span[2][0]}` : "Sess";
}

function countdown(reset: number | null, now: number) {
  if (reset === null) return "No reset yet";
  const minutes = Math.ceil((reset * 1000 - now) / 60_000);
  if (minutes <= 0) return "Awaiting update";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  return `↻ ${days ? `${days}d ` : ""}${hours ? `${hours}h ` : ""}${mins}m`;
}

function age(timestamp: number, now: number) {
  const mins = Math.max(0, Math.floor((now - timestamp * 1000) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
}

function App() {
  const [readings, setReadings] = useState<Record<string, Reading>>(initialReadings);
  const [now, setNow] = useState(Date.now());
  const [windowError, setWindowError] = useState("");
  const pending = useRef(false);
  const mounted = useRef(false);
  const lastRefresh = useRef(0);
  const desktop = isTauri();
  const [activeEmail, setActiveEmail] = useState<string | null>(null);
  // undefined until the Claude Code CLI has reported its sign-in status.
  const [claudeEmail, setClaudeEmail] = useState<string | null | undefined>(undefined);
  const [claudeCode, setClaudeCode] = useState("");
  const [codexError, setCodexError] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [login, setLogin] = useState<Login | null>(null);
  const loginRef = useRef<Login | null>(null);
  const authLock = useRef(false);
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);
  const viewBeforePin = useRef<WindowView | null>(null);
  const pinnedMonitor = useRef<Monitor | null>(null);
  const pinLock = useRef(false);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const refreshDone = useRef<Promise<void> | null>(null);
  const windowTask = useRef<Promise<void>>(Promise.resolve());
  const queueWindow = useCallback((task: () => Promise<void>) => {
    const next = windowTask.current.catch(() => {}).then(task);
    windowTask.current = next;
    return next;
  }, []);

  const refresh = useCallback(async (force = false) => {
    if (pending.current || authLock.current || loginRef.current || (!force && Date.now() - lastRefresh.current < 10_000)) return;
    pending.current = true;
    let finishRefresh!: () => void;
    refreshDone.current = new Promise<void>(resolve => { finishRefresh = resolve; });
    lastRefresh.current = Date.now();
    if (mounted.current) {
      setRefreshing(true);
      setReadings(previous => Object.fromEntries(Object.entries(previous).map(([id, reading]) => [id, { ...reading, loading: true }])));
    }
    await Promise.all(["codex", "claude"].map(async id => {
      try {
        if (!isTauri()) throw new Error("Open the desktop app to read your installed account. Run npm run tauri dev.");
        if (id === "codex") {
          const email = await invoke<string | null>("codex_account");
          if (!mounted.current) return;
          setActiveEmail(email);
          setCodexError("");
          setReadings(previous => {
            const next = { ...previous };
            for (const key of Object.keys(next).filter(key => key.startsWith("codex:"))) next[key] = { ...next[key], loading: false, active: false };
            if (email) {
              const key = `codex:${email.toLowerCase()}`;
              next[key] = { ...next[key], loading: true, active: true, error: undefined };
            }
            return next;
          });
          if (!email) return;
          const data = await invoke<ProviderUsage>("codex_usage");
          if (!data.accountEmail) throw new Error("Codex did not identify this account.");
          if (mounted.current) setActiveEmail(data.accountEmail);
          if (mounted.current) setReadings(previous => {
            const next = { ...previous };
            for (const key of Object.keys(next).filter(key => key.startsWith("codex:"))) next[key] = { ...next[key], loading: false, active: false };
            next[`codex:${data.accountEmail!.toLowerCase()}`] = { data, loading: false, active: true };
            return next;
          });
        } else {
          // Without the CLI, still try the saved login; only sign-in and disconnect need it.
          const email = await invoke<string | null>("claude_account").catch(() => undefined);
          if (!mounted.current) return;
          setClaudeEmail(email);
          if (email === null) {
            setReadings(previous => ({ ...previous, claude: { loading: false } }));
            return;
          }
          const data = await invoke<ProviderUsage>("claude_usage");
          if (mounted.current) setReadings(previous => ({ ...previous, claude: { data, loading: false } }));
        }
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error);
        if (mounted.current && id === "codex") setCodexError(message);
        if (mounted.current) setReadings(previous => {
          const next = { ...previous };
          for (const key of Object.keys(next).filter(key => id === "codex" ? key.startsWith("codex:") : key === "claude")) {
            next[key] = { ...previous[key], error: message, loading: false };
          }
          return next;
        });
      }
    }));
    pending.current = false;
    finishRefresh();
    refreshDone.current = null;
    if (mounted.current) setRefreshing(false);
  }, []);

  const connect = async (provider: Provider) => {
    if (pending.current || authLock.current || loginRef.current) return;
    authLock.current = true;
    setAuthBusy(true);
    setAuthError("");
    setClaudeCode("");
    try {
      const attempt: Login = { provider, ...await invoke<Omit<Login, "provider">>(`${provider}_login_start`) };
      loginRef.current = attempt;
      setLogin(attempt);
      // Claude Code opens the browser itself; its printed URL is the paste-code fallback.
      if (provider === "codex") {
        try { await openUrl(attempt.authUrl); }
        catch { setAuthError("Could not open your browser. Use Open sign-in to retry."); }
      }
    } catch (error) { setAuthError(String(error)); }
    finally { authLock.current = false; setAuthBusy(false); }
  };

  const cancelLogin = async () => {
    if (!loginRef.current || authLock.current) return;
    authLock.current = true;
    setAuthBusy(true);
    try {
      await invoke(`${loginRef.current.provider}_login_cancel`, { loginId: loginRef.current.loginId });
      loginRef.current = null;
      setLogin(null);
      setAuthError("");
    } catch (error) { setAuthError(String(error)); }
    finally { authLock.current = false; setAuthBusy(false); }
    if (!loginRef.current) void refresh(true);
  };

  const submitClaudeCode = async () => {
    const attempt = loginRef.current;
    if (attempt?.provider !== "claude" || authLock.current || !claudeCode.trim()) return;
    authLock.current = true;
    setAuthBusy(true);
    setAuthError("");
    try {
      await invoke("claude_login_code", { loginId: attempt.loginId, code: claudeCode });
      setClaudeCode("");
    } catch (error) { setAuthError(String(error)); }
    finally { authLock.current = false; setAuthBusy(false); }
  };

  const disconnect = async (accountId: string) => {
    if (authLock.current || loginRef.current) return;
    authLock.current = true;
    setAuthBusy(true);
    setAuthError("");
    try {
      // Finish account reads before changing credentials, so a reader cannot race logout.
      await refreshDone.current;
      if (accountId === "claude") {
        // The backend refuses if the installed account no longer matches the one shown.
        if (await invoke<string | null>("claude_account")) await invoke("claude_logout", { expectedEmail: claudeEmail ?? "" });
        setClaudeEmail(null);
        setReadings(previous => ({ ...previous, claude: { loading: false } }));
        setSelectedAccount(null);
        return;
      }
      const email = accountId.slice("codex:".length);
      const installedEmail = await invoke<string | null>("codex_account");
      if (installedEmail?.toLowerCase() === email) {
        await invoke("codex_logout", { expectedEmail: email });
        setActiveEmail(null);
        setCodexError("");
      } else {
        setActiveEmail(installedEmail);
      }
      setReadings(previous => {
        const next = { ...previous };
        delete next[accountId];
        for (const id of Object.keys(next).filter(id => id.startsWith("codex:"))) {
          next[id] = { ...next[id], active: installedEmail?.toLowerCase() !== email && id === `codex:${installedEmail?.toLowerCase()}` };
        }
        return next;
      });
      setSelectedAccount(null);
    } catch (error) { setAuthError(String(error)); }
    finally { authLock.current = false; setAuthBusy(false); }
  };

  const togglePin = async () => {
    if (!desktop || pinLock.current) return;
    pinLock.current = true;
    setPinBusy(true);
    setWindowError("");
    const window = getCurrentWindow();
    try {
      await queueWindow(async () => {
      if (pinned) {
        if (!viewBeforePin.current) throw new Error("Original window view is unavailable.");
        await restoreView(window, viewBeforePin.current);
        setPinned(false);
        pinnedMonitor.current = null;
      } else {
        const monitor = await currentMonitor() || await primaryMonitor();
        if (!monitor) throw new Error("Could not find your monitor's usable desktop area.");
        viewBeforePin.current = await captureView(window);
        pinnedMonitor.current = monitor;
        await dockCompact(window, monitor, Math.max(100, 44 + Object.keys(readings).length * 38));
        setPinned(true);
        setSelectedAccount(null);
      }
      });
    } catch (error) {
      if (!pinned && viewBeforePin.current) {
        try { await restoreView(window, viewBeforePin.current); } catch { /* Keep the original error visible. */ }
        pinnedMonitor.current = null;
      }
      setWindowError(`Could not ${pinned ? "unpin" : "pin"} the widget: ${String(error)}`);
    } finally { pinLock.current = false; setPinBusy(false); }
  };

  useEffect(() => {
    if (!desktop || !contentRef.current) return;
    let stopped = false;
    let running = false;
    let again = false;
    const fit = async () => {
      if (running) { again = true; return; }
      running = true;
      do {
        again = false;
        if (stopped || pinLock.current || !contentRef.current) break;
        const height = Math.ceil(contentRef.current.getBoundingClientRect().height) + (pinned ? 16 : 22);
        try {
          await queueWindow(async () => {
            if (stopped || pinLock.current) return;
            if (pinned && pinnedMonitor.current) await dockCompact(getCurrentWindow(), pinnedMonitor.current, Math.max(80, height));
            else await fitDetails(getCurrentWindow(), height);
          });
        } catch (error) {
          if (!stopped) setWindowError(`Could not fit the widget: ${String(error)}`);
        }
      } while (again && !stopped);
      running = false;
    };
    const observer = new ResizeObserver(() => { void fit(); });
    observer.observe(contentRef.current);
    void fit();
    let unlisten: (() => void) | undefined;
    if (pinned) void getCurrentWindow().onMoved(() => {
      if (!stopped && !pinLock.current && pinnedMonitor.current) {
        void queueWindow(async () => {
          if (!stopped && !pinLock.current && pinnedMonitor.current) await anchorCompact(getCurrentWindow(), pinnedMonitor.current);
        }).catch(() => {
          if (!stopped) setWindowError("Could not keep the widget in the corner. Unpin and pin again.");
        });
      }
    }).then(stop => { if (stopped) stop(); else unlisten = stop; }).catch(() => {
      if (!stopped) setWindowError("Could not keep the widget pinned. Unpin and pin again.");
    });
    return () => { stopped = true; observer.disconnect(); unlisten?.(); };
  }, [desktop, pinned, queueWindow]);

  useEffect(() => {
    if (!login) return;
    let stopped = false;
    let polling = false;
    const timer = window.setInterval(async () => {
      if (polling || authLock.current) return;
      polling = true;
      try {
        const complete = await invoke<boolean>(`${login.provider}_login_poll`, { loginId: login.loginId });
        if (!stopped && complete) {
          loginRef.current = null;
          setLogin(null);
          setAuthError("");
          void refresh(true);
        }
      } catch (error) {
        if (!stopped) {
          loginRef.current = null;
          setLogin(null);
          setAuthError(String(error));
          void refresh(true);
        }
      } finally { polling = false; }
    }, 1000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [login, refresh]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, refreshMs);
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { mounted.current = false; window.clearInterval(timer); window.clearInterval(clock); };
  }, [refresh]);

  useEffect(() => {
    try {
      localStorage.setItem(cacheKey, JSON.stringify(Object.fromEntries(Object.entries(readings)
        .filter(([id, reading]) => id.startsWith("codex:") && reading.data)
        .map(([id, reading]) => [id, reading.data]))));
      localStorage.removeItem("usage-widget.codex-accounts.v1");
    } catch { /* Keep monitoring when local storage is unavailable. */ }
  }, [readings]);

  // The signed-in Codex account leads; saved accounts follow, most recently read first.
  const isLive = (id: string) => !!readings[id].active && id === `codex:${activeEmail?.toLowerCase()}`;
  const codexIds = Object.keys(readings).filter(id => id.startsWith("codex:"))
    .sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || (readings[b].data?.updatedAt ?? 0) - (readings[a].data?.updatedAt ?? 0));
  const providers = [
    ...codexIds.map(id => ({ id, name: "Codex", kind: "codex", mark: "◎", email: readings[id].data?.accountEmail || id.slice(6) })),
    { id: "claude", name: "Claude Code", kind: "claude", mark: "✳", email: claudeEmail ?? null },
  ];
  const claudeSignedOut = desktop && claudeEmail === null && !readings.claude.loading;
  const claudeCanSignIn = claudeSignedOut || (desktop && !!readings.claude.error && !readings.claude.data);
  const groups = [
    { kind: "codex", name: "Codex", mark: "◎", items: providers.filter(provider => provider.kind === "codex") },
    { kind: "claude", name: "Claude Code", mark: "✳", items: providers.filter(provider => provider.kind === "claude") },
  ];
  const busy = refreshing || Object.values(readings).some(reading => reading.loading);
  const coolingDown = now - lastRefresh.current < 10_000;

  return (
    <main className={`widget${pinned ? " compact" : ""}`}>
      <div className="widget-content" ref={contentRef}>
      <header className="header" data-tauri-drag-region={!pinned || undefined}>
        <div className="heading" data-tauri-drag-region={!pinned || undefined}>
          <h1 data-tauri-drag-region={!pinned || undefined}>{pinned ? "AI usage" : "TokenPulse"} {!pinned && <span className="header-note" data-tauri-drag-region>· auto 2 min</span>}</h1>
        </div>
        {desktop && <button className={`icon-button pin-button${pinned ? " is-pinned" : ""}`} disabled={pinBusy}
          onClick={() => { void togglePin(); }} aria-label={pinned ? "Unpin and show details" : "Pin compact widget to bottom right"}
          aria-pressed={pinned} title={pinned ? "Unpin · restore details and original position" : "Pin · compact view at bottom right"}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3h8l-1 7 4 4v2H5v-2l4-4-1-7ZM12 16v5" /></svg>
        </button>}
        <button className="icon-button refresh-button" disabled={busy || coolingDown || authBusy || !!login} onClick={() => { void refresh(); }} aria-label="Refresh usage" title="Refresh usage">
          <svg viewBox="0 0 24 24" className={busy ? "spin" : ""} aria-hidden="true"><path d="M20 7v5h-5M20 12a8 8 0 1 1-2.3-5.7" /></svg>
        </button>
        {desktop && <button className="icon-button minimize" aria-label="Minimize widget" title="Minimize to taskbar" onClick={() => {
          setWindowError("");
          void getCurrentWindow().minimize().catch(() => setWindowError("Could not minimize the widget. Try minimizing it from the taskbar."));
        }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /></svg></button>}
        {desktop && <button className="icon-button close" aria-label="Close widget" title="Close widget" onClick={() => { void getCurrentWindow().close().catch(() => setWindowError("Could not close the widget. Use the taskbar to close it.")); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>}
      </header>

      {(login || authError || codexError) && <div className="account-controls">
        <div className="account-actions">
          {login && <span>{login.provider === "claude" ? "Signing in to Claude…" : "Signing in…"}</span>}
          {login ? <>
            <button disabled={authBusy} onClick={() => { void openUrl(login.authUrl).catch(() => setAuthError("Could not open your browser.")); }}>Open sign-in</button>
            <button disabled={authBusy} onClick={() => { void cancelLogin(); }}>Cancel</button>
          </> : null}
        </div>
        {login && <p className="connection-note">{login.provider === "claude"
          ? "Finish sign-in in the browser tab Claude Code opened. If none opened, use Open sign-in and paste the code shown here."
          : "Finish sign-in in your browser. Choose the account you want to monitor."}</p>}
        {login?.provider === "claude" && <form className="code-form" onSubmit={event => { event.preventDefault(); void submitClaudeCode(); }}>
          <input value={claudeCode} onChange={event => setClaudeCode(event.target.value)} placeholder="Paste code"
            aria-label="Claude sign-in code" autoComplete="off" spellCheck={false} disabled={authBusy} />
          <button type="submit" disabled={authBusy || !claudeCode.trim()}>Submit</button>
        </form>}
        {authError && <p className="connection-error" role="status" title={authError}>{authError}</p>}
        {codexError && <p className="connection-error" role="status" title={codexError}>{codexError}</p>}
      </div>}
      <div className="providers">
        {groups.map(group => (
        <div className={`provider-group ${group.kind}`} key={group.kind}>
          <div className="group-heading">
            <span className="group-mark" aria-hidden="true">{group.mark}</span>
            <h3>{group.name}</h3>
            {!pinned && group.items.length > 1 && <span className="group-count">{group.items.length} accounts</span>}
            {!pinned && group.kind === "codex" && <button className="group-action" disabled={!desktop || busy || authBusy || !!login}
              onClick={() => { void connect("codex"); }} aria-label="Switch or add Codex account"
              title="Switch / add Codex account. Uses the shared Codex CLI / IDE login.">+ Add account</button>}
            {!pinned && group.kind === "claude" && claudeCanSignIn && <button className="group-action" disabled={busy || authBusy || !!login}
              onClick={() => { void connect("claude"); }} aria-label="Sign in to Claude Code"
              title="Sign in with your Claude subscription (shared with Claude Code CLI / IDE)">
              {login?.provider === "claude" ? "Signing in…" : "Sign in"}
            </button>}
          </div>
          <div className="provider-cards">
          {!group.items.length && <p className="empty-state group-empty">{busy ? "Checking Codex account…" : "No Codex account connected."}</p>}
          {group.items.map(provider => {
          const { data, error, loading, active } = readings[provider.id];
          const saved = provider.kind === "codex" && (!active || activeEmail?.toLowerCase() !== provider.email?.toLowerCase());
          const stale = !!data && (saved || now - data.updatedAt * 1000 > 15 * 60_000 || !!error);
          const selectable = provider.kind === "codex" || !!provider.email;
          const selected = selectable && selectedAccount === provider.id;
          const status = !data ? null : saved ? "saved" : stale ? "stale" : "live";
          const statusTitle = status === "live" ? "Signed in · live usage"
            : status === "saved" ? `Saved reading (not the signed-in account) · ${age(data!.updatedAt, now)}`
            : status === "stale" ? `Last known usage · ${age(data!.updatedAt, now)}${error ? ` · ${error}` : ""}` : "";
          return (
            <section className={`provider ${provider.kind}${selected ? " selected" : ""}${saved ? " saved" : ""}`} key={provider.id}
              aria-label={`${provider.email || provider.name} usage`} onClick={selectable && !pinned ? () => setSelectedAccount(provider.id) : undefined}>
              <div className="provider-heading">
                {status && <span className={`status-dot ${status}`} role="img" aria-label={statusTitle} title={statusTitle} />}
                <h2 title={provider.email || "Sign in to Claude Code to monitor usage."}>
                  {selectable && !pinned ? <button className="account-select" aria-pressed={selected}
                    onClick={event => { event.stopPropagation(); setSelectedAccount(selected ? null : provider.id); }}>
                    {provider.email}
                  </button> : provider.email || (claudeSignedOut ? "Not signed in" : "Claude account")}
                </h2>
                {data?.plan && <span className="badge">{data.plan}</span>}
              </div>
                {selected && !pinned && <button className="disconnect-button" disabled={authBusy || !!login}
                  aria-label={`Disconnect ${provider.email}`} title={saved ? "Disconnect this saved account from the widget" : `Disconnect account (also signs out ${provider.name} CLI / IDE)`}
                  onClick={event => { event.stopPropagation(); void disconnect(provider.id); }}>
                  {authBusy ? "Disconnecting…" : "Disconnect"}
                </button>}
              <div className="usage-windows">
              {data?.windows.slice(0, 2).map((usage, index) => {
                const expired = usage.resetsAt !== null && usage.resetsAt * 1000 <= now;
                const tone = expired ? "expired" : usage.usedPercent >= 95 ? "danger" : "normal";
                return (
                  <div className={`usage-window ${tone}`} key={`${usage.label}-${index}`}>
                    <div className="row"><span>{pinned ? shortLabel(usage.label) : usage.label.replace(" window", "")}</span><strong title={`${Math.round(100 - usage.usedPercent)}% remaining · ${resetSchedule(usage)}`}>{Math.round(usage.usedPercent)}<span>%</span></strong></div>
                    <div className="progress" role="progressbar" aria-label={`${provider.email || provider.name} ${usage.label} used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={usage.usedPercent}>
                      <div className="progress-bar" style={{ width: `${usage.usedPercent}%` }} />
                    </div>
                    {!pinned && <div className="window-details">
                      <time
                        dateTime={usage.resetsAt === null ? undefined : new Date(usage.resetsAt * 1000).toISOString()}
                        title={usage.resetsAt === null ? "No reset time reported" : `${new Date(usage.resetsAt * 1000).toLocaleString("en-PH", { timeZone: resetTimeZone })} (Philippine time) · ${countdown(usage.resetsAt, now)}`}
                      >{resetSchedule(usage)}</time>
                    </div>}
                  </div>
                );
              })}
              </div>
              {!data && !error && <p className="empty-state">{loading ? "Reading usage…" : provider.kind === "claude" ? "Sign in to read Claude Code usage." : "Connect this account to read usage."}</p>}
              {error && !data && <p className="error-message" role="status" title={error}>{error}</p>}
              {data && !pinned && <div className={`reading-meta ${stale ? "stale" : ""}`} title={`${error ? `${error} · ` : ""}${data.source} · ${new Date(data.updatedAt * 1000).toLocaleString()}${data.windows.slice(2).map(window => ` · ${window.label}: ${window.usedPercent}% used`).join("")}`}>
                <span>{loading ? "Refreshing…" : error ? "Update failed" : saved ? "Saved reading" : stale ? "Last known usage" : "Updated"} · {age(data.updatedAt, now)}</span>
                <span className="used-label">% used</span>
              </div>}
            </section>
          );
          })}
          </div>
        </div>
        ))}
      </div>
      {windowError && <p className="error-message" role="status" title={windowError}>{windowError}</p>}
      </div>
      {desktop && !pinned && <div className="resize-handle" title="Drag to resize" aria-hidden="true" onMouseDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        void getCurrentWindow().startResizeDragging("SouthEast").catch(() => setWindowError("Could not resize the widget. Try dragging a window edge."));
      }} />}
    </main>
  );
}

export default App;
