import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { currentMonitor, getCurrentWindow, primaryMonitor, type Monitor } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { anchorCompact, captureView, dockCompact, fitDetails, restoreView, type WindowView } from "./windowLayout";
import { FREE_LIMITS, PLANS, YEARLY_SAVINGS, accountLimit, hasPro, type Billing, type Provider } from "./plan";
import "./App.css";

type UsageWindow = { label: string; usedPercent: number; resetsAt: number | null };
type ProviderUsage = { accountEmail: string | null; plan: string | null; source: string; updatedAt: number; windows: UsageWindow[] };
type Reading = { data?: ProviderUsage; error?: string; loading: boolean; active?: boolean };
type Login = { provider: Provider; loginId: string; authUrl: string };
const cacheKey = "usage-widget.accounts.v3";
const legacyCacheKeys = ["usage-widget.codex-accounts.v2", "usage-widget.codex-accounts.v1"];

function initialReadings(): Record<string, Reading> {
  // The bare "claude" entry stands in until Claude Code reports which account is signed in.
  const readings: Record<string, Reading> = { claude: { loading: false } };
  try {
    const stored = localStorage.getItem(cacheKey);
    // Older caches held only Codex readings, keyed the same way.
    const cache = JSON.parse(stored || legacyCacheKeys.map(key => localStorage.getItem(key)).find(Boolean) || "{}");
    for (const [id, data] of Object.entries(cache) as [string, ProviderUsage][]) {
      const kind = stored && id.startsWith("claude:") ? "claude" : "codex";
      if (typeof data?.accountEmail === "string" && data.accountEmail.includes("@") && Number.isFinite(data.updatedAt)
        && typeof data.source === "string" && Array.isArray(data.windows) && data.windows.length > 0
        && data.windows.every(window => typeof window.label === "string" && Number.isFinite(window.usedPercent)
          && window.usedPercent >= 0 && window.usedPercent <= 100 && (window.resetsAt === null || Number.isFinite(window.resetsAt)))) {
        readings[`${kind}:${data.accountEmail.toLowerCase()}`] = { data, loading: false, active: false };
      }
    }
  } catch { /* An unavailable or invalid cache must not block fresh usage. */ }
  return readings;
}

const accountIds = (readings: Record<string, Reading>, provider: Provider) => Object.keys(readings).filter(id => id.startsWith(`${provider}:`));
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
  // New hooks stay below the existing ones; the widget tests address hooks by call order.
  const [pro] = useState(hasPro);
  // "plan" opens Pro from the header badge, without a limit being hit.
  const [upgradeFor, setUpgradeFor] = useState<Provider | "plan" | null>(null);
  const knownAtLogin = useRef<{ provider: Provider; ids: Set<string> } | null>(null);
  const [billing, setBilling] = useState<Billing>("yearly");

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
          const key = email ? `claude:${email.toLowerCase()}` : "claude";
          const settle = (reading: Reading) => setReadings(previous => {
            const next = { ...previous };
            for (const id of accountIds(next, "claude")) next[id] = { ...next[id], loading: false, active: false };
            // A known account replaces the placeholder; saved Claude readings stay visible when signed out.
            if (email || (email === null && accountIds(next, "claude").length)) delete next.claude;
            else if (email === null) next.claude = { loading: false };
            if (email !== null) next[key] = { ...next[key], ...reading };
            return next;
          });
          settle({ loading: true, active: true, error: undefined });
          if (email === null) return;
          const data = await invoke<ProviderUsage>("claude_usage");
          // Claude usage does not name its account; the CLI status does.
          if (mounted.current) settle({ data: { ...data, accountEmail: email ?? data.accountEmail }, loading: false, active: true, error: undefined });
        }
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error);
        if (mounted.current && id === "codex") setCodexError(message);
        if (mounted.current) setReadings(previous => {
          const next = { ...previous };
          for (const key of Object.keys(next).filter(key => id === "codex" ? key.startsWith("codex:") : key === "claude" || (key.startsWith("claude:") && next[key].active))) {
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

  const providerName = (provider: Provider) => provider === "codex" ? "Codex" : "Claude";
  const usedAll = (provider: Provider) => {
    const limit = FREE_LIMITS[provider];
    return `You've used ${limit === 1 ? "your" : limit === 2 ? "both" : `all ${limit}`} free ${providerName(provider)} account${limit === 1 ? "" : "s"}.`;
  };
  const atLimit = (provider: Provider) => accountIds(readings, provider).length >= accountLimit(provider, pro);

  // Signing in again also switches between saved accounts, so the limit is checked again once the account is known.
  const signIn = (provider: Provider) => {
    knownAtLogin.current = { provider, ids: new Set(accountIds(readings, provider)) };
    setUpgradeFor(null);
    void connect(provider);
  };

  const addAccount = (provider: Provider) => {
    if (atLimit(provider)) {
      setAuthError("");
      setUpgradeFor(provider);
      return;
    }
    signIn(provider);
  };

  // Signs a newly added account back out when the free plan's limit was already reached.
  const enforceLimit = async (provider: Provider) => {
    const known = knownAtLogin.current;
    knownAtLogin.current = null;
    if (!known || known.provider !== provider || known.ids.size < accountLimit(provider, pro)) return;
    await refreshDone.current;
    if (authLock.current) return;
    authLock.current = true;
    setAuthBusy(true);
    try {
      const email = await invoke<string | null>(`${provider}_account`);
      const id = email ? `${provider}:${email.toLowerCase()}` : null;
      if (!email || !id || known.ids.has(id)) return;
      await invoke(`${provider}_logout`, { expectedEmail: email });
      (provider === "codex" ? setActiveEmail : setClaudeEmail)(null);
      setReadings(previous => {
        const next = { ...previous };
        delete next[id];
        if (provider === "claude" && !accountIds(next, "claude").length) next.claude = { loading: false };
        return next;
      });
      setUpgradeFor(provider);
      setAuthError(`${email} was signed out. The free plan includes ${FREE_LIMITS[provider]} ${providerName(provider)} account${FREE_LIMITS[provider] === 1 ? "" : "s"}.`);
    } catch (error) { setAuthError(String(error)); }
    finally { authLock.current = false; setAuthBusy(false); }
  };

  const cancelLogin = async () => {
    if (!loginRef.current || authLock.current) return;
    authLock.current = true;
    setAuthBusy(true);
    try {
      await invoke(`${loginRef.current.provider}_login_cancel`, { loginId: loginRef.current.loginId });
      knownAtLogin.current = null;
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
      const provider: Provider = accountId.startsWith("claude:") ? "claude" : "codex";
      const email = accountId.slice(provider.length + 1);
      const installedEmail = await invoke<string | null>(`${provider}_account`);
      const setInstalled = provider === "codex" ? setActiveEmail : setClaudeEmail;
      if (installedEmail?.toLowerCase() === email) {
        await invoke(`${provider}_logout`, { expectedEmail: email });
        setInstalled(null);
        if (provider === "codex") setCodexError("");
      } else {
        setInstalled(installedEmail);
      }
      setReadings(previous => {
        const next = { ...previous };
        delete next[accountId];
        for (const id of accountIds(next, provider)) {
          next[id] = { ...next[id], active: installedEmail?.toLowerCase() !== email && id === `${provider}:${installedEmail?.toLowerCase()}` };
        }
        // Keep a Claude card on screen so its Sign in button stays reachable.
        if (provider === "claude" && !accountIds(next, "claude").length) next.claude = { loading: false };
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
          void refresh(true).then(() => enforceLimit(login.provider));
        }
      } catch (error) {
        if (!stopped) {
          knownAtLogin.current = null;
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
        .filter(([id, reading]) => (id.startsWith("codex:") || id.startsWith("claude:")) && reading.data)
        .map(([id, reading]) => [id, reading.data]))));
      for (const key of legacyCacheKeys) localStorage.removeItem(key);
    } catch { /* Keep monitoring when local storage is unavailable. */ }
  }, [readings]);

  // The signed-in account leads; saved accounts follow, most recently read first.
  const liveEmail = { codex: activeEmail, claude: claudeEmail };
  const isLive = (id: string, provider: Provider) => !!readings[id].active && id === `${provider}:${liveEmail[provider]?.toLowerCase()}`;
  const sortedIds = (provider: Provider) => accountIds(readings, provider)
    .sort((a, b) => Number(isLive(b, provider)) - Number(isLive(a, provider)) || (readings[b].data?.updatedAt ?? 0) - (readings[a].data?.updatedAt ?? 0));
  const account = (id: string, provider: Provider) => ({ id, name: provider === "codex" ? "Codex" : "Claude Code", kind: provider,
    email: readings[id].data?.accountEmail || id.slice(provider.length + 1) });
  const claudePlaceholder = "claude" in readings ? [{ id: "claude", name: "Claude Code", kind: "claude" as const, email: claudeEmail ?? null }] : [];
  const placeholder = readings.claude;
  const claudeSignedOut = desktop && claudeEmail === null && !placeholder?.loading;
  const claudeCanSignIn = claudeSignedOut || (desktop && !!placeholder?.error && !placeholder.data);
  const groups = [
    { kind: "codex" as const, name: "Codex", mark: "◎", items: sortedIds("codex").map(id => account(id, "codex")) },
    { kind: "claude" as const, name: "Claude Code", mark: "✳", items: [...claudePlaceholder, ...sortedIds("claude").map(id => account(id, "claude"))] },
  ];
  const busy = refreshing || Object.values(readings).some(reading => reading.loading);
  const coolingDown = now - lastRefresh.current < 10_000;

  return (
    <main className={`widget${pinned ? " compact" : ""}`}>
      <div className="widget-content" ref={contentRef}>
      <header className="header" data-tauri-drag-region={!pinned || undefined}>
        <div className="heading" data-tauri-drag-region={!pinned || undefined}>
          <h1 data-tauri-drag-region={!pinned || undefined}>{pinned ? "AI usage" : "TokenPulse"}
            {!pinned && (pro ? <span className="plan-badge pro" title="TokenPulse Pro · unlimited accounts">Pro</span>
              : <button className="plan-badge" aria-label="Free plan · see Pro" aria-expanded={upgradeFor !== null}
                title={`Free plan · ${FREE_LIMITS.codex} Codex + ${FREE_LIMITS.claude} Claude account. Click to see Pro.`}
                onClick={() => { setAuthError(""); setUpgradeFor(upgradeFor ? null : "plan"); }}>Free</button>)}
            {" "}{!pinned && <span className="header-note" data-tauri-drag-region>· auto 2 min</span>}</h1>
        </div>
        {desktop && <button className={`icon-button pin-button${pinned ? " is-pinned" : ""}`} disabled={pinBusy}
          onClick={() => { void togglePin(); }} aria-label={pinned ? "Unpin and show details" : "Pin compact widget to bottom right"}
          aria-pressed={pinned} title={pinned ? "Unpin · restore details and original position" : "Pin · compact view at bottom right"}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3h8l-1 7 4 4v2H5v-2l4-4-1-7ZM12 16v5" /></svg>
        </button>}
        <button className="icon-button refresh-button" disabled={busy || coolingDown || authBusy || !!login} onClick={() => { void refresh(); }} aria-label="Refresh usage" title="Refresh usage">
          <svg viewBox="0 0 24 24" className={busy ? "spin" : ""} aria-hidden="true"><path d="M20 7v5h-5M20 12a8 8 0 1 1-2.3-5.7" /></svg>
        </button>
        {desktop && <button className="icon-button minimize" aria-label="Hide to tray" title="Hide to tray · click the tray icon to show again" onClick={() => {
          setWindowError("");
          void getCurrentWindow().hide().catch(() => setWindowError("Could not hide the widget. Use Hide in the tray icon menu."));
        }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /></svg></button>}
        {desktop && <button className="icon-button close" aria-label="Quit TokenPulse" title="Quit TokenPulse" onClick={() => { void getCurrentWindow().close().catch(() => setWindowError("Could not close the widget. Use Quit in the tray icon menu.")); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>}
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
      {upgradeFor && !pinned && <div className="upgrade-panel" role="dialog" aria-label="TokenPulse Pro">
        <div className="upgrade-head">
          <h2 aria-label="Upgrade to Pro">Upgrade to<span className="plan-badge pro" aria-hidden="true">Pro</span></h2>
          <button className="icon-button" aria-label="Close upgrade" title="Close" onClick={() => setUpgradeFor(null)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </div>
        <p className="upgrade-lead">
          {upgradeFor !== "plan" && <strong>{usedAll(upgradeFor)}</strong>}
          Free includes {FREE_LIMITS.codex} Codex + {FREE_LIMITS.claude} Claude account. Pro removes the limit.
        </p>
        <div className="upgrade-plans" role="radiogroup" aria-label="Billing period">
          {(Object.keys(PLANS) as Billing[]).map(id => <button key={id} role="radio" aria-checked={billing === id}
            className={`plan${billing === id ? " selected" : ""}`} onClick={() => setBilling(id)}>
            <span className="plan-radio" aria-hidden="true" />
            <span className="plan-name">{PLANS[id].name}</span>
            {id === "yearly" && <span className="plan-save">Save {YEARLY_SAVINGS}%</span>}
            <span className="plan-price">${PLANS[id].amount}<small> / {PLANS[id].per}</small></span>
          </button>)}
        </div>
        <button className="upgrade-cta" disabled title="Payments are coming soon">Get Pro · coming soon</button>
        {upgradeFor !== "plan" && <button className="upgrade-switch" disabled={busy || authBusy || !!login} onClick={() => signIn(upgradeFor)}
          title={`Sign in again to one of your saved ${providerName(upgradeFor)} accounts`}>Switch to a saved account</button>}
      </div>}
      <div className="providers">
        {groups.map(group => {
        const count = accountIds(readings, group.kind).length;
        const limited = atLimit(group.kind);
        const addTitle = limited ? "Free plan limit reached. Upgrade for unlimited accounts."
          : `Switch / add ${group.name} account. Uses the shared ${group.name} CLI / IDE login.`;
        return (
        <div className={`provider-group ${group.kind}`} key={group.kind}>
          <div className="group-heading">
            <span className="group-mark" aria-hidden="true">{group.mark}</span>
            <h3>{group.name}</h3>
            {!pinned && (pro ? count > 1 && <span className="group-count">{count} accounts</span>
              : count > 0 && <span className="group-count" title={`Free plan: up to ${FREE_LIMITS[group.kind]} ${group.name} account${FREE_LIMITS[group.kind] === 1 ? "" : "s"}`}>
                {count}/{FREE_LIMITS[group.kind]}
              </span>)}
            {!pinned && (group.kind === "codex" || (claudeEmail && !claudeCanSignIn)) && <button className="group-action" disabled={!desktop || busy || authBusy || !!login}
              onClick={() => addAccount(group.kind)} aria-label={`Switch or add ${group.name} account`} title={addTitle}>+ Add account</button>}
            {!pinned && group.kind === "claude" && claudeCanSignIn && <button className="group-action" disabled={busy || authBusy || !!login}
              onClick={() => addAccount("claude")} aria-label="Sign in to Claude Code"
              title={limited ? addTitle : "Sign in with your Claude subscription (shared with Claude Code CLI / IDE)"}>
              {login?.provider === "claude" ? "Signing in…" : "Sign in"}
            </button>}
          </div>
          <div className="provider-cards">
          {!group.items.length && <p className="empty-state group-empty">{busy ? `Checking ${group.name} account…` : `No ${group.name} account connected.`}</p>}
          {group.items.map(provider => {
          const { data, error, loading, active } = readings[provider.id];
          const placeholderCard = provider.id === "claude";
          const saved = !placeholderCard && (!active || liveEmail[provider.kind]?.toLowerCase() !== provider.email?.toLowerCase());
          const stale = !!data && (saved || now - data.updatedAt * 1000 > 15 * 60_000 || !!error);
          const selectable = !placeholderCard || !!provider.email;
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
        );
        })}
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
