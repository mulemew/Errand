import { useState, useEffect, useMemo } from "react";
import { Monitor, Plus, Square, Loader2, Trash2, Globe, Pencil, Play, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { osMeta, ExitFlag, type ExitGeo } from "@/components/EnvBadges";
import { useToast } from "@/hooks/use-toast";
import { useLang } from "@/contexts/lang-context";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

/** The list endpoints select whole rows, so the fields the badges need are already here. */
interface Ref { id: number; name: string; type?: string; os?: string | null; exitGeo?: ExitGeo | null }
interface Instance {
  id: string;
  name: string;
  providerId: number | null;
  fingerprintProfileId: number | null;
  proxyProfileId: number | null;
  sessionProfileId: number | null;
  createdAt: number;
  url: string;
}
interface SessionProfile {
  id: number;
  name: string;
  providerId: number | null;
  fingerprintProfileId: number | null;
  proxyProfileId: number | null;
  originUrl: string | null;
  startUrl: string | null;
  autostart: boolean;
  updatedAt: string;
}

/**
 * One row per browser, running or not.
 *
 * A stored browser and the process currently running it are the same thing to anyone using
 * this page, so they are one row. `instance` is null for one that is not running; a null
 * `profileId` only happens if its row was deleted out from under a running process.
 */
interface Row {
  key: string;
  profileId: number | null;
  instance: Instance | null;
  name: string;
  fingerprintProfileId: number | null;
  proxyProfileId: number | null;
  url: string | null;
  /** Where it should open, when that is not "wherever it was left". */
  startUrl: string;
  autostart: boolean;
  /** When the process started, for the uptime counter. Only set while running. */
  startedAt: number | null;
  sortAt: number;
}

const NONE = "none";

const EMPTY_ROW: Row = {
  key: "new",
  profileId: null,
  instance: null,
  name: "",
  fingerprintProfileId: null,
  proxyProfileId: null,
  url: null,
  startUrl: "",
  autostart: false,
  startedAt: null,
  sortAt: 0,
};

/**
 * How long this browser has been up, ticking.
 *
 * Not a formatted timestamp: what you want to know about a browser you left open is how
 * long it has been sitting there, and that only reads right if it moves.
 */
function Uptime({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
  const secs = Math.max(0, Math.floor((Date.now() - since) / 1000));
  const d = Math.floor(secs / 86400);
  const h = Math.floor(secs / 3600) % 24;
  const m = Math.floor(secs / 60) % 60;
  return <>{d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`}</>;
}

/**
 * Long-lived browsers you drive by hand.
 *
 * A task's browser lives for one run and is thrown away. These are kept: closing one saves
 * its cookies, reopening replays them into the same fingerprint and the same exit IP, and a
 * task can select the result to run in an identical environment.
 */
export default function Browsers() {
  const { t } = useLang();
  const { toast } = useToast();

  const [providers, setProviders] = useState<Ref[]>([]);
  const [fingerprints, setFingerprints] = useState<Ref[]>([]);
  const [proxies, setProxies] = useState<Ref[]>([]);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [profiles, setProfiles] = useState<SessionProfile[]>([]);

  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ id: string; name: string } | null>(null);
  /**
   * Bumped to remount the iframe, and left at 0 until the dialog has actually been laid
   * out. noVNC sizes its canvas once, from the container, at connect time — connecting
   * inside a dialog that is still animating in gave it a container with no size and a
   * canvas to match, which is the empty blue screen. A new tab never had the problem
   * because a tab is full size before the client loads.
   */
  const [viewEpoch, setViewEpoch] = useState(0);

  // The editor doubles as the creator: editing.key === "new" means "new".
  const [editing, setEditing] = useState<Row | null>(null);
  const [form, setForm] = useState({ name: "", fingerprintId: NONE, proxyId: NONE, startUrl: "", autostart: false });
  const [saving, setSaving] = useState(false);

  const load = () => {
    void fetch(`${BASE}/api/browsers`, { credentials: "same-origin" })
      .then((r) => r.json())
      .then((d: Instance[]) => setInstances(Array.isArray(d) ? d : []))
      .catch(() => {});
    void fetch(`${BASE}/api/session-profiles`, { credentials: "same-origin" })
      .then((r) => r.json())
      .then((d: SessionProfile[]) => setProfiles(Array.isArray(d) ? d : []))
      .catch(() => {});
  };

  // Wait for the dialog to be open AND laid out before the client connects. Two frames:
  // the first is the one that mounts the dialog, the second is after its layout.
  useEffect(() => {
    if (viewing === null) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setViewEpoch((n) => (n === 0 ? 1 : n)));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [viewing]);

  useEffect(() => {
    const pick = (url: string, set: (v: Ref[]) => void) =>
      fetch(`${BASE}${url}`, { credentials: "same-origin" })
        .then((r) => r.json())
        .then((d) => set(Array.isArray(d) ? d : []))
        .catch(() => {});
    void pick("/api/providers", setProviders);
    void pick("/api/fingerprint-profiles", setFingerprints);
    void pick("/api/proxy-profiles", setProxies);
    load();
    // A browser can also disappear on its own (sidecar TTL, a crash), so the list is polled
    // rather than assumed to match what this tab last did.
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, []);

  // Only camoufox carries a fingerprint, a live view and a session dump, so it is the only
  // backend these can run on — settled here instead of being offered as a question.
  const camoufoxProviderId = useMemo(
    () => providers.find((p) => p.type === "camoufox")?.id ?? null,
    [providers],
  );

  const rows: Row[] = useMemo(() => {
    const byProfile = new Map<number, Instance>();
    for (const i of instances) if (i.sessionProfileId != null) byProfile.set(i.sessionProfileId, i);

    const out: Row[] = profiles.map((p) => {
      const inst = byProfile.get(p.id) ?? null;
      return {
        key: `p${p.id}`,
        profileId: p.id,
        instance: inst,
        name: inst?.name || p.name,
        fingerprintProfileId: p.fingerprintProfileId,
        proxyProfileId: p.proxyProfileId,
        url: inst?.url ?? p.originUrl,
        startUrl: p.startUrl ?? "",
        autostart: p.autostart === true,
        startedAt: inst?.createdAt ?? null,
        sortAt: Date.parse(p.updatedAt) || 0,
      };
    });

    // A process whose row was deleted while it ran still has to be listed, so it can be
    // stopped rather than sitting there invisible.
    for (const i of instances) {
      if (i.sessionProfileId != null && profiles.some((p) => p.id === i.sessionProfileId)) continue;
      out.push({
        key: i.id,
        profileId: null,
        instance: i,
        name: i.name,
        fingerprintProfileId: i.fingerprintProfileId,
        proxyProfileId: i.proxyProfileId,
        url: i.url,
        startUrl: "",
        autostart: false,
        startedAt: i.createdAt,
        sortAt: i.createdAt,
      });
    }

    // Running first — those are the ones you are about to touch.
    return out.sort(
      (a, b) => (a.instance ? 0 : 1) - (b.instance ? 0 : 1) || b.sortAt - a.sortAt,
    );
  }, [instances, profiles]);

  const openEditor = (row: Row | null) => {
    setEditing(row ?? EMPTY_ROW);
    setForm({
      name: row?.name ?? "",
      fingerprintId: row?.fingerprintProfileId != null ? String(row.fingerprintProfileId) : NONE,
      proxyId: row?.proxyProfileId != null ? String(row.proxyProfileId) : NONE,
      startUrl: row?.startUrl ?? "",
      autostart: row?.autostart ?? false,
    });
  };

  const isNew = editing !== null && editing.key === "new";

  const submitEditor = async () => {
    if (!editing) return;
    setSaving(true);
    const fingerprintProfileId = form.fingerprintId === NONE ? null : Number(form.fingerprintId);
    const proxyProfileId = form.proxyId === NONE ? null : Number(form.proxyId);
    try {
      if (isNew) {
        const res = await fetch(`${BASE}/api/browsers`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: form.name.trim() || undefined,
            providerId: camoufoxProviderId,
            fingerprintProfileId,
            proxyProfileId,
            startUrl: form.startUrl.trim() || undefined,
            autostart: form.autostart,
          }),
        });
        const data = (await res.json()) as { id?: string; error?: string };
        if (!res.ok) {
          toast({ title: t.browserLaunchFailed, description: data.error, variant: "destructive" });
          return;
        }
        setEditing(null);
        load();
        if (data.id) setViewing({ id: data.id, name: form.name.trim() });
        return;
      }
      if (editing.profileId == null) return;
      const res = await fetch(`${BASE}/api/session-profiles/${editing.profileId}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          fingerprintProfileId,
          proxyProfileId,
          autostart: form.autostart,
          startUrl: form.startUrl.trim(),
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        toast({ title: t.browserLaunchFailed, description: data.error, variant: "destructive" });
        return;
      }
      setEditing(null);
      load();
    } catch {
      toast({ title: t.networkError, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  /**
   * Reopen a saved browser.
   *
   * Only the id is sent. The server resolves the fingerprint and proxy from the profile
   * itself, because a session is only valid in the environment it was made in — sending
   * saved cookies out through a different exit IP turns a working login into a security
   * prompt. It also lands on the page the session was last used on.
   */
  const open = async (row: Row) => {
    if (row.profileId == null) return;
    setBusyKey(row.key);
    try {
      const r = await fetch(`${BASE}/api/browsers`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionProfileId: row.profileId }),
      });
      const data = (await r.json()) as { id?: string; error?: string };
      if (!r.ok || !data.id) {
        toast({ title: t.browserLaunchFailed, description: data.error, variant: "destructive" });
        return;
      }
      load();
      setViewing({ id: data.id, name: row.name });
    } catch (err) {
      toast({ title: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setBusyKey(null);
    }
  };

  const stop = async (row: Row) => {
    if (!row.instance) return;
    setBusyKey(row.key);
    try {
      await fetch(`${BASE}/api/browsers/${row.instance.id}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (viewing?.id === row.instance.id) setViewing(null);
      load();
    } finally {
      setBusyKey(null);
    }
  };

  const remove = async (row: Row) => {
    if (row.profileId == null) return;
    if (!window.confirm(t.deleteBrowserConfirm)) return;
    setBusyKey(row.key);
    try {
      await fetch(`${BASE}/api/session-profiles/${row.profileId}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      load();
    } finally {
      setBusyKey(null);
    }
  };

  const refName = (list: Ref[], id: number | null) => list.find((r) => r.id === id)?.name ?? t.noneValue;

  return (
    <div className="max-w-4xl mx-auto p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Monitor className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">{t.navBrowsers}</h1>
        </div>
        <Button size="sm" className="gap-2" onClick={() => openEditor(null)}>
          <Plus className="h-4 w-4" />
          {t.newFingerprintBrowser}
        </Button>
      </div>
      <Card className="border-border">
        <CardContent className="p-2 space-y-2">
          {rows.length === 0 ? (
            <p className="text-xs text-muted-foreground p-2">{t.noBrowsersYet}</p>
          ) : (
            rows.map((row) => {
              const running = row.instance !== null;
              const busy = busyKey === row.key;
              return (
                <div key={row.key} className="flex items-center gap-2 p-2 rounded border border-border">
                  <span
                    className={`h-2 w-2 rounded-full shrink-0 ${running ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
                    title={running ? t.browserStatusRunning : t.browserStatusStopped}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{row.name}</p>
                    <p className="text-[11px] text-muted-foreground font-mono truncate">{row.url ?? ""}</p>
                  </div>

                  {/* The environment, as marks rather than a sentence: the fingerprint's OS
                      and the proxy's exit country. Their names are in the tooltips — spelling
                      them out again next to the icon said the same thing twice. */}
                  {(() => {
                    const fp = fingerprints.find((f) => f.id === row.fingerprintProfileId);
                    const { Icon, label } = osMeta(fp?.os);
                    return (
                      <span className="shrink-0 text-muted-foreground" title={`${label}${fp ? ` · ${fp.name}` : ""}`}>
                        <Icon className="h-3.5 w-3.5" />
                      </span>
                    );
                  })()}
                  <ExitFlag
                    geo={proxies.find((p) => p.id === row.proxyProfileId)?.exitGeo}
                    label={refName(proxies, row.proxyProfileId)}
                    className="flex items-center shrink-0"
                  />
                  {row.autostart && (
                    <span className="shrink-0 text-muted-foreground" title={t.autostartLabel}>
                      <Zap className="h-3.5 w-3.5" />
                    </span>
                  )}
                  {running && (
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground w-12 text-right">
                      <Uptime since={row.startedAt ?? Date.now()} />
                    </span>
                  )}

                  {running ? (
                    <>
                      <Button
                        variant="ghost" size="icon" className="h-7 w-7" title={t.liveViewTitle}
                        onClick={() => setViewing({ id: row.instance!.id, name: row.name })}
                      >
                        <Globe className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost" size="icon" className="h-7 w-7" title={t.stopBrowser}
                        onClick={() => void stop(row)} disabled={busy}
                      >
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost" size="icon" className="h-7 w-7" title={t.openProfile}
                      onClick={() => void open(row)} disabled={busy}
                    >
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                    </Button>
                  )}

                  <Button
                    variant="ghost" size="icon" className="h-7 w-7"
                    title={running ? t.cannotEditWhileRunning : t.editBrowserAction}
                    disabled={running || row.profileId == null}
                    onClick={() => openEditor(row)}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  {/* Deleting destroys the browser whether or not it is running — the
                      server stops it first. Closing is the reversible one. */}
                  <Button
                    variant="ghost" size="icon" className="h-7 w-7 text-destructive"
                    title={t.deleteBrowserAction}
                    disabled={row.profileId == null || busy}
                    onClick={() => void remove(row)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      {/* ── New / edit ── */}
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {isNew ? t.newFingerprintBrowser : t.editFingerprintBrowser}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">{t.fieldName}</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={t.browserNameExample}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t.fingerprintLabel}</Label>
              <Select value={form.fingerprintId} onValueChange={(v) => setForm({ ...form, fingerprintId: v })}>
                <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t.noneValue}</SelectItem>
                  {fingerprints.map((f) => (
                    <SelectItem key={f.id} value={String(f.id)}>{f.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t.proxyLabel}</Label>
              <Select value={form.proxyId} onValueChange={(v) => setForm({ ...form, proxyId: v })}>
                <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t.noneValue}</SelectItem>
                  {proxies.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t.startingUrl}</Label>
              <Input
                value={form.startUrl}
                onChange={(e) => setForm({ ...form, startUrl: e.target.value })}
                placeholder="https://example.com"
                className="font-mono text-sm"
              />
              <p className="text-[11px] text-muted-foreground">{t.startingUrlHint}</p>
            </div>
            {!isNew && <p className="text-[11px] text-muted-foreground">{t.envAppliesNextOpen}</p>}
            <div className="flex items-start justify-between gap-3 pt-1">
              <div className="min-w-0">
                <Label className="text-xs">{t.autostartLabel}</Label>
                <p className="text-[11px] text-muted-foreground">{t.autostartHint}</p>
              </div>
              <Switch
                checked={form.autostart}
                onCheckedChange={(v) => setForm({ ...form, autostart: v })}
                className="mt-0.5 shrink-0"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setEditing(null)}>{t.cancel}</Button>
            <Button size="sm" className="gap-2" onClick={() => void submitEditor()} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {isNew ? t.launchBrowser : t.saveChanges}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Live screen. Mounting the iframe is what opens the connection, so it exists only
          while the dialog is open — closing it puts the browser back in the background
          without stopping it. */}
      <Dialog
        open={viewing !== null}
        onOpenChange={(o) => {
          if (o) return;
          setViewing(null);
          setViewEpoch(0);
        }}
      >
        <DialogContent className="max-w-6xl w-full p-2">
          {/* No wrapping: the button used to follow a paragraph of text in a flex-wrap row
              and dropped onto a second line that the dialog clipped, which read as "the
              option is sometimes missing". */}
          <div className="flex items-center gap-2 px-1 pb-2 pr-8">
            <p className="text-xs text-muted-foreground min-w-0 flex-1 truncate">
              {viewing?.name || t.liveViewTitle}
            </p>
            {viewing && (
              // A real window, not an iframe: KasmVNC's clipboard and file transfer want
              // the focus and the permissions of a top-level document, and a browser you
              // are actually using should not be trapped in a modal the size of a card.
              <Button
                variant="outline" size="sm" className="h-7 text-xs shrink-0"
                onClick={() =>
                  window.open(
                    `${BASE}/api/live-view/${viewing.id}/`,
                    `liveview-${viewing.id}`,
                    "noopener,width=1280,height=800",
                  )
                }
              >
                {t.openInNewWindow}
              </Button>
            )}
            {viewing && (
              <Button
                variant="ghost" size="sm" className="h-7 text-xs shrink-0"
                onClick={() => setViewEpoch((n) => n + 1)}
              >
                {t.reconnectView}
              </Button>
            )}
          </div>
          {viewing && viewEpoch > 0 ? (
            <iframe
              key={viewEpoch}
              // THIS instance's own display. Asking for the provider showed the sidecar's
              // shared screen, where nothing is drawn — a black rectangle, every time.
              src={`${BASE}/api/live-view/${viewing.id}/`}
              title={t.liveViewTitle}
              className="w-full rounded border border-border bg-black"
              style={{ height: "70vh" }}
            />
          ) : (
            <div
              className="w-full rounded border border-border bg-black flex items-center justify-center"
              style={{ height: "70vh" }}
            >
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
