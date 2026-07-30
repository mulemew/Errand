import { useState, useEffect } from "react";
import { Server, Plus, Trash2, Pencil, Loader2, RefreshCw, CheckCircle2, XCircle, HelpCircle, Star, Link2, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { useLang } from "@/contexts/lang-context";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type PType = "playwright" | "puppeteer" | "seleniumbase" | "camoufox";
/** A task that has this provider selected — supplied by the list endpoint. */
interface TaskRef {
  id: number;
  name: string;
}
interface Provider {
  id: number;
  name: string;
  type: PType;
  url: string;
  concurrency: number;
  enabled: boolean;
  isDefault: boolean;
  stealth: boolean | null;
  blockAds: boolean | null;
  ignoreHttps: boolean | null;
  sessionTimeoutMs: number | null;
  viewportWidth: number | null;
  viewportHeight: number | null;
  humanize: boolean | null;
  blockWebrtc: boolean | null;
  healthy: boolean | null;
  lastError: string | null;
  lastCheckedAt: string | null;
  usedBy: TaskRef[];
  running: number;
  queued: number;
}

// Which params each type honours (mirrors PROVIDER_TYPE_PARAMS on the server).
const CAPS: Record<PType, { stealth: boolean; blockAds: boolean; ignoreHttps: boolean; sessionTimeout: boolean; viewport: boolean; humanize: boolean; blockWebrtc: boolean }> = {
  playwright:   { stealth: true,  blockAds: true,  ignoreHttps: true,  sessionTimeout: true,  viewport: true,  humanize: false, blockWebrtc: false },
  puppeteer:    { stealth: true,  blockAds: true,  ignoreHttps: true,  sessionTimeout: true,  viewport: true,  humanize: false, blockWebrtc: false },
  camoufox:     { stealth: false, blockAds: true,  ignoreHttps: true,  sessionTimeout: false, viewport: true,  humanize: true,  blockWebrtc: true },
  seleniumbase: { stealth: false, blockAds: false, ignoreHttps: false, sessionTimeout: false, viewport: true,  humanize: false, blockWebrtc: false },
};
const EMPTY = { name: "", type: "seleniumbase" as PType, url: "", concurrency: 1, enabled: true, stealth: false, blockAds: false, ignoreHttps: false, timeoutMin: "", resolution: "", humanize: true, blockWebrtc: true };
const isBrowserless = (t: PType) => t === "playwright" || t === "puppeteer";

export default function Providers() {
  const { toast } = useToast();
  const { t } = useLang();
  const [rows, setRows] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [checkingId, setCheckingId] = useState<number | null>(null);
  const [checkingAll, setCheckingAll] = useState(false);
  const [settingDefaultId, setSettingDefaultId] = useState<number | null>(null);

  const fill = (template: string, vars: Record<string, string | number>) =>
    Object.entries(vars).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), template);

  const load = () => {
    setLoading(true);
    fetch(`${BASE}/api/providers`)
      .then((r) => r.json())
      .then((data) => setRows(data))
      .catch(() => toast({ title: t.failedToLoad, variant: "destructive" }))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openCreate = () => { setEditingId(null); setForm(EMPTY); setDialogOpen(true); };
  const openEdit = (p: Provider) => {
    setEditingId(p.id);
    setForm({
      name: p.name, type: p.type, url: p.url, concurrency: p.concurrency, enabled: p.enabled,
      stealth: p.stealth ?? false, blockAds: p.blockAds ?? false, ignoreHttps: p.ignoreHttps ?? false,
      timeoutMin: p.sessionTimeoutMs != null ? String(Math.round(p.sessionTimeoutMs / 60000)) : "",
      resolution: p.viewportWidth && p.viewportHeight ? `${p.viewportWidth}x${p.viewportHeight}` : "",
      humanize: p.humanize ?? true, blockWebrtc: p.blockWebrtc ?? true,
    });
    setDialogOpen(true);
  };

  // Build the type-appropriate param payload (null for params this type doesn't honour).
  const paramPayload = () => {
    const c = CAPS[form.type];
    const res = /^(\d+)\s*[x×]\s*(\d+)$/.exec(form.resolution.trim());
    return {
      stealth: c.stealth ? form.stealth : null,
      blockAds: c.blockAds ? form.blockAds : null,
      ignoreHttps: c.ignoreHttps ? form.ignoreHttps : null,
      sessionTimeoutMs: c.sessionTimeout && form.timeoutMin.trim() ? Math.max(0, Math.round(Number(form.timeoutMin) * 60000)) : null,
      viewportWidth: c.viewport && res ? Number(res[1]) : null,
      viewportHeight: c.viewport && res ? Number(res[2]) : null,
      humanize: c.humanize ? form.humanize : null,
      blockWebrtc: c.blockWebrtc ? form.blockWebrtc : null,
    };
  };

  const handleSubmit = async () => {
    if (!form.name.trim() || !form.url.trim()) { toast({ title: t.nameAndUrlRequired, variant: "destructive" }); return; }
    setSubmitting(true);
    try {
      const url = editingId ? `${BASE}/api/providers/${editingId}` : `${BASE}/api/providers`;
      // Type is fixed once created; edit only name/url/concurrency/enabled.
      const body = editingId
        ? { name: form.name.trim(), url: form.url.trim(), concurrency: form.concurrency, enabled: form.enabled, ...paramPayload() }
        : { name: form.name.trim(), type: form.type, url: form.url.trim(), concurrency: form.concurrency, enabled: form.enabled, ...paramPayload() };
      const res = await fetch(url, { method: editingId ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || (await res.text()));
      toast({ title: editingId ? t.providerUpdated : t.providerSaved, variant: "success" });
      setDialogOpen(false);
      load();
    } catch (err) {
      toast({ title: t.failedToSave, description: err instanceof Error ? err.message : "", variant: "destructive" });
    } finally { setSubmitting(false); }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      const res = await fetch(`${BASE}/api/providers/${deleteId}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({} as { affectedTasks?: number }));
      toast({
        title: t.providerDeleted,
        description: data.affectedTasks ? fill(t.tasksFellBackToDefault, { n: data.affectedTasks }) : undefined,
        variant: "success",
      });
      setDeleteId(null);
      load();
    } catch { toast({ title: t.failedToDelete, variant: "destructive" }); }
  };

  const makeDefault = async (id: number) => {
    setSettingDefaultId(id);
    try {
      const res = await fetch(`${BASE}/api/providers/${id}/default`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "");
      // The endpoint returns the bare rows; reload so usedBy / live counters come with them.
      load();
    } catch (err) {
      toast({ title: t.failedToSave, description: err instanceof Error ? err.message : "", variant: "destructive" });
    } finally { setSettingDefaultId(null); }
  };

  const checkOne = async (id: number) => {
    setCheckingId(id);
    try {
      const res = await fetch(`${BASE}/api/providers/${id}/health`, { method: "POST" });
      if (!res.ok) throw new Error();
      const updated: Provider = await res.json();
      // Keep the list-only fields the health endpoint does not return.
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...updated, usedBy: r.usedBy, running: r.running, queued: r.queued } : r)));
    } catch { toast({ title: t.healthCheckFailed, variant: "destructive" }); }
    finally { setCheckingId(null); }
  };

  // Which provider's screen is being watched, if any. The iframe only exists while this is
  // set — mounting it is what opens the WebSocket, and unmounting closes it.
  const [liveViewId, setLiveViewId] = useState<number | null>(null);

  const checkAll = async () => {
    setCheckingAll(true);
    try {
      const res = await fetch(`${BASE}/api/providers/health-all`, { method: "POST" });
      if (!res.ok) throw new Error();
      await res.json();
      load();
    } catch { toast({ title: t.healthCheckFailed, variant: "destructive" }); }
    finally { setCheckingAll(false); }
  };

  const maskUrl = (u: string) => u.replace(/(:\/\/[^:@/]+:)[^@/]+@/, "$1••••@");

  const HealthDot = ({ h }: { h: boolean | null }) =>
    h === true ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : h === false ? <XCircle className="h-4 w-4 text-destructive" /> : <HelpCircle className="h-4 w-4 text-muted-foreground" />;

  /** Tasks bound to this provider. Deleting is safe — the reference is stripped and the
   *  runner falls back — but you should be able to SEE the blast radius first. */
  const UsageLine = ({ tasks }: { tasks: TaskRef[] }) => {
    if (!tasks?.length) return <span className="text-[11px] text-muted-foreground">{t.notInUse}</span>;
    const shown = tasks.slice(0, 3).map((x) => x.name).join(", ");
    const rest = tasks.length - 3;
    return (
      <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1 min-w-0 max-w-full">
        <Link2 className="h-3 w-3 shrink-0" />
        <span className="truncate">
          {fill(t.inUseByTasks, { n: tasks.length })}: {shown}
          {rest > 0 ? ` ${fill(t.andNMore, { n: rest })}` : ""}
        </span>
      </span>
    );
  };

  const deleteTarget = rows.find((r) => r.id === deleteId) ?? null;

  return (
    <div className="max-w-3xl mx-auto p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Server className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">{t.navProviders}</h1>
        </div>
        <div className="flex items-center gap-2">
          {rows.length > 0 && (
            <Button size="sm" variant="outline" className="gap-2" onClick={checkAll} disabled={checkingAll}>
              <RefreshCw className={`h-4 w-4 ${checkingAll ? "animate-spin" : ""}`} />{t.checkAll}
            </Button>
          )}
          <Button size="sm" className="gap-2" onClick={openCreate}><Plus className="h-4 w-4" />{t.addProvider}</Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">{t.providersIntro}</p>

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : rows.length === 0 ? (
        <Card className="border-dashed border-border">
          <CardContent className="flex flex-col items-center justify-center py-12 gap-3 text-center">
            <Server className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t.noProvidersYet}</p>
            <Button size="sm" variant="outline" onClick={openCreate} className="gap-2 mt-2"><Plus className="h-4 w-4" />{t.addProvider}</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {rows.map((p) => (
            <Card key={p.id} className="border-border shadow-sm">
              <CardHeader className="pb-2 bg-muted/20 border-b border-border flex-row items-center justify-between py-3 px-4 gap-3">
                <div className="min-w-0 space-y-1">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2 flex-wrap">
                    <HealthDot h={p.healthy} />
                    {p.name}
                    <span className="text-[10px] font-mono uppercase text-muted-foreground border border-border rounded px-1 py-0.5">{p.type}</span>
                    <span className="text-[10px] text-primary">{t.concurrencyShort} {p.concurrency}</span>
                    {p.isDefault && (
                      <span className="text-[10px] inline-flex items-center gap-0.5 rounded-full bg-primary/10 px-1.5 py-0.5 font-medium text-primary" title={t.defaultProviderHint}>
                        <Star className="h-2.5 w-2.5 fill-current" />{t.defaultBadge}
                      </span>
                    )}
                    {!p.enabled && <span className="text-[10px] text-muted-foreground">({t.disabledSuffix})</span>}
                    {(p.running > 0 || p.queued > 0) && (
                      <span className={`text-[10px] font-mono ${p.queued > 0 ? "text-amber-500" : "text-muted-foreground"}`}>
                        {fill(t.liveRunningQueued, { r: p.running, q: p.queued })}
                      </span>
                    )}
                  </CardTitle>
                  <p className="text-xs text-muted-foreground font-mono truncate">{maskUrl(p.url)}</p>
                  <UsageLine tasks={p.usedBy} />
                  {p.healthy === false && p.lastError && <p className="text-[11px] text-destructive truncate">{t.healthCheckFailed}: {p.lastError}</p>}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {!p.isDefault && p.enabled && (
                    <Button variant="ghost" size="icon" className="h-7 w-7" title={t.setAsDefault}
                      onClick={() => makeDefault(p.id)} disabled={settingDefaultId === p.id}>
                      <Star className={`h-4 w-4 ${settingDefaultId === p.id ? "animate-pulse" : ""}`} />
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" className="h-7 w-7" title={t.checkOne} onClick={() => checkOne(p.id)} disabled={checkingId === p.id || checkingAll}>
                    <RefreshCw className={`h-4 w-4 ${checkingId === p.id ? "animate-spin" : ""}`} />
                  </Button>
                  {/* Only camoufox renders on an Xvfb the viewer can attach to. */}
                  {p.type === "camoufox" && (
                    <Button variant="ghost" size="icon" className="h-7 w-7" title={t.liveViewTitle}
                      onClick={() => setLiveViewId(p.id)}>
                      <Monitor className="h-4 w-4" />
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(p)}><Pencil className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => setDeleteId(p.id)}><Trash2 className="h-4 w-4" /></Button>
                </div>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editingId ? t.editProvider : t.addProvider}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>{t.fieldName}</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="browserless #1" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>{t.fieldType}</Label>
                <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v as PType })} disabled={!!editingId}>
                  <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="seleniumbase">SeleniumBase</SelectItem>
                    <SelectItem value="camoufox">Camoufox</SelectItem>
                    <SelectItem value="playwright">Playwright (CDP)</SelectItem>
                    <SelectItem value="puppeteer">Puppeteer (CDP)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{t.concurrencyLimit}</Label>
                <Input type="number" min={1} max={64} value={form.concurrency}
                  onChange={(e) => setForm({ ...form, concurrency: Math.max(1, parseInt(e.target.value || "1", 10)) })} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>URL</Label>
              <Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder={isBrowserless(form.type) ? "ws://browserless:3000?token=…" : form.type === "camoufox" ? "http://camoufox-proxy:7318" : "http://cf-proxy:7317"}
                className="font-mono" />
              <p className="text-xs text-muted-foreground">
                {isBrowserless(form.type) ? t.urlHintCdp : t.urlHintSidecar}
              </p>
            </div>

            {/* Backend defaults — only the params this type honours */}
            <div className="rounded-md border border-border divide-y divide-border">
              {CAPS[form.type].stealth && (
                <div className="flex items-center justify-between px-3 py-2">
                  <Label className="text-sm">{t.stealthMode}</Label>
                  <Switch checked={form.stealth} onCheckedChange={(v) => setForm({ ...form, stealth: v })} />
                </div>
              )}
              {CAPS[form.type].blockAds && (
                <div className="flex items-center justify-between px-3 py-2">
                  <Label className="text-sm">{t.blockAdsLabel}</Label>
                  <Switch checked={form.blockAds} onCheckedChange={(v) => setForm({ ...form, blockAds: v })} />
                </div>
              )}
              {CAPS[form.type].ignoreHttps && (
                <div className="flex items-center justify-between px-3 py-2">
                  <Label className="text-sm">{t.ignoreHttpsErrors}</Label>
                  <Switch checked={form.ignoreHttps} onCheckedChange={(v) => setForm({ ...form, ignoreHttps: v })} />
                </div>
              )}
              {CAPS[form.type].blockWebrtc && (
                <div className="flex items-center justify-between px-3 py-2 gap-3">
                  <div>
                    <Label className="text-sm">{t.blockWebrtcLabel}</Label>
                    <p className="text-[10px] text-muted-foreground">{t.blockWebrtcHint}</p>
                  </div>
                  <Switch checked={form.blockWebrtc} onCheckedChange={(v) => setForm({ ...form, blockWebrtc: v })} />
                </div>
              )}
              {CAPS[form.type].humanize && (
                <div className="flex items-center justify-between px-3 py-2 gap-3">
                  <div>
                    <Label className="text-sm">{t.humanizeLabel}</Label>
                    <p className="text-[10px] text-muted-foreground">{t.humanizeHint}</p>
                  </div>
                  <Switch checked={form.humanize} onCheckedChange={(v) => setForm({ ...form, humanize: v })} />
                </div>
              )}
              {CAPS[form.type].sessionTimeout && (
                <div className="flex items-center justify-between px-3 py-2 gap-3">
                  <Label className="text-sm shrink-0">{t.sessionTimeoutMinutes}</Label>
                  <Input type="number" min={1} value={form.timeoutMin} placeholder="30"
                    onChange={(e) => setForm({ ...form, timeoutMin: e.target.value })} className="w-28 text-sm" />
                </div>
              )}
              {CAPS[form.type].viewport && (
                <div className="flex items-center justify-between px-3 py-2 gap-3">
                  <Label className="text-sm shrink-0">{t.defaultResolution}</Label>
                  <Input value={form.resolution} placeholder="1920x1080"
                    onChange={(e) => setForm({ ...form, resolution: e.target.value })} className="w-36 text-sm font-mono" />
                </div>
              )}
            </div>
            {CAPS[form.type].viewport && (
              <p className="text-[11px] text-muted-foreground -mt-1">{t.resolutionHint}</p>
            )}

            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <Label className="text-sm">{t.enabledLabel}</Label>
              <Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>{t.cancel}</Button>
            <Button onClick={handleSubmit} disabled={submitting} className="gap-2">
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}{editingId ? t.actionSave : t.actionAdd}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Live view — the sidecar's real screen, proxied by this app so it works behind the
          same reverse proxy and login as everything else. */}
      <Dialog open={liveViewId !== null} onOpenChange={(o) => !o && setLiveViewId(null)}>
        <DialogContent className="max-w-6xl w-full p-2">
          <p className="text-xs text-muted-foreground px-1 pb-2">{t.liveViewHint}</p>
          {liveViewId !== null && (
            <iframe
              src={`${BASE}/api/live-view/${liveViewId}/`}
              title={t.liveViewTitle}
              className="w-full rounded border border-border bg-black"
              style={{ height: "70vh" }}
            />
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteId !== null} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.deleteProviderTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {t.deleteProviderDesc}
              {/* Name the tasks that will be reconfigured — the whole point of tracking usage. */}
              {deleteTarget && deleteTarget.usedBy.length > 0 && (
                <span className="mt-2 block text-amber-600 dark:text-amber-400">
                  {t.deleteInUseWarning}
                  <span className="mt-1 block font-mono text-xs">
                    {deleteTarget.usedBy.slice(0, 8).map((x) => x.name).join(", ")}
                    {deleteTarget.usedBy.length > 8 ? ` ${fill(t.andNMore, { n: deleteTarget.usedBy.length - 8 })}` : ""}
                  </span>
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">{t.actionDelete}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
