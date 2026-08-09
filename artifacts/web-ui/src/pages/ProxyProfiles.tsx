import { useState, useEffect } from "react";
import { Network, Plus, Trash2, Pencil, Loader2, RefreshCw, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { useLang } from "@/contexts/lang-context";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface ExitGeo {
  configured?: boolean; direct?: boolean; ok?: boolean; error?: string;
  exitIp?: string; country?: string; countryCode?: string; region?: string; city?: string; isp?: string; timezone?: string; at?: string;
}
/** A task that has this proxy selected — supplied by the list endpoint. */
interface TaskRef {
  id: number;
  name: string;
}
interface ProxyProfile {
  id: number;
  name: string;
  url: string;
  exitGeo?: ExitGeo | null;
  geoUpdatedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  usedBy?: TaskRef[];
}

const EMPTY = { name: "", url: "" };

export default function ProxyProfiles() {
  const { toast } = useToast();
  const { t } = useLang();
  const [rows, setRows] = useState<ProxyProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [refreshingId, setRefreshingId] = useState<number | null>(null);
  const [refreshingAll, setRefreshingAll] = useState(false);

  const fill = (template: string, vars: Record<string, string | number>) =>
    Object.entries(vars).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), template);

  const load = () => {
    setLoading(true);
    fetch(`${BASE}/api/proxy-profiles`)
      .then((r) => r.json())
      .then((data) => setRows(data))
      .catch(() => toast({ title: t.failedToLoad, variant: "destructive" }))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openCreate = () => { setEditingId(null); setForm(EMPTY); setDialogOpen(true); };
  const openEdit = (p: ProxyProfile) => { setEditingId(p.id); setForm({ name: p.name, url: p.url }); setDialogOpen(true); };

  const handleSubmit = async () => {
    if (!form.name.trim() || !form.url.trim()) {
      toast({ title: t.nameAndProxyUrlRequired, variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const url = editingId ? `${BASE}/api/proxy-profiles/${editingId}` : `${BASE}/api/proxy-profiles`;
      const res = await fetch(url, {
        method: editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: form.name.trim(), url: form.url.trim() }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || (await res.text()));
      const saved: ProxyProfile = await res.json();
      // Patch the single row instead of re-fetching (and blanking) the whole list. The
      // server does not re-probe the exit IP inline any more, so `usedBy` is preserved
      // from the row we already had rather than coming back with the response.
      setRows((prev) =>
        editingId
          ? prev.map((r) => (r.id === saved.id ? { ...saved, usedBy: r.usedBy } : r))
          : [...prev, { ...saved, usedBy: [] }],
      );
      toast({
        title: editingId ? t.proxyUpdated : t.proxySaved,
        description: t.exitCheckingInBackground,
        variant: "success",
      });
      setDialogOpen(false);
    } catch (err) {
      toast({ title: t.failedToSave, description: err instanceof Error ? err.message : "", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      const res = await fetch(`${BASE}/api/proxy-profiles/${deleteId}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({} as { affectedTasks?: number }));
      toast({
        title: t.proxyDeleted,
        description: data.affectedTasks ? fill(t.tasksFellBackToNoProxy, { n: data.affectedTasks }) : undefined,
        variant: "success",
      });
      setRows((prev) => prev.filter((r) => r.id !== deleteId));
      setDeleteId(null);
    } catch {
      toast({ title: t.failedToDelete, variant: "destructive" });
    }
  };

  const refreshOne = async (id: number) => {
    setRefreshingId(id);
    try {
      const res = await fetch(`${BASE}/api/proxy-profiles/${id}/refresh`, { method: "POST" });
      if (!res.ok) throw new Error();
      const updated: ProxyProfile = await res.json();
      setRows((prev) => prev.map((r) => (r.id === id ? { ...updated, usedBy: r.usedBy } : r)));
    } catch {
      toast({ title: t.failedToRefresh, variant: "destructive" });
    } finally {
      setRefreshingId(null);
    }
  };

  const refreshAll = async () => {
    setRefreshingAll(true);
    try {
      const res = await fetch(`${BASE}/api/proxy-profiles/refresh-all`, { method: "POST" });
      if (!res.ok) throw new Error();
      await res.json();
      load(); // reload so usedBy comes back with the fresh geo
      toast({ title: t.allProxiesRefreshed, variant: "success" });
    } catch {
      toast({ title: t.failedToRefresh, variant: "destructive" });
    } finally {
      setRefreshingAll(false);
    }
  };

  // Hide the password portion of a proxy URL when displaying it.

  // Country flag as an <img> (flagcdn) — Windows browsers don't render flag emoji.
  const GeoLine = ({ geo }: { geo?: ExitGeo | null }) => {
    if (!geo || (geo.configured === false && !geo.ok && !geo.direct)) {
      return <span className="text-xs text-muted-foreground">{t.exitNotChecked}</span>;
    }
    if (!geo.ok) {
      return <span className="text-xs text-destructive truncate">{t.exitCheckFailed}{geo.error ? `: ${geo.error}` : ""}</span>;
    }
    const cc = geo.countryCode?.toLowerCase();
    const place = [geo.city, geo.region, geo.country].filter(Boolean).join(", ");
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
        {cc && (
          <img
            src={`https://flagcdn.com/20x15/${cc}.png`}
            srcSet={`https://flagcdn.com/40x30/${cc}.png 2x`}
            width={20}
            height={15}
            alt={geo.countryCode}
            className="rounded-sm shrink-0"
          />
        )}
        <span className="truncate">{place || geo.countryCode}{geo.exitIp ? ` · ${geo.exitIp}` : ""}</span>
      </span>
    );
  };

  /** Tasks bound to this proxy. Deleting is safe — the reference is stripped and the run
   *  falls back to no proxy — but the blast radius should be visible first. */
  const UsageLine = ({ tasks }: { tasks?: TaskRef[] }) => {
    if (!tasks?.length) return <span className="text-[11px] text-muted-foreground">{t.notInUse}</span>;
    // The count is what a list row can usefully say; the names go in a popover.
    //
    // Three names and "and N more" was the worst of both: too little to answer "which
    // tasks?", and long enough to be truncated by the row anyway — so the visible part was
    // an arbitrary prefix of an arbitrary subset. A count reads at a glance and the full
    // list is one click away, complete and scrollable.
    return (
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="text-[11px] text-muted-foreground inline-flex items-center gap-1 hover:text-foreground hover:underline underline-offset-2"
          >
            <Link2 className="h-3 w-3 shrink-0" />
            {fill(t.inUseByTasks, { n: tasks.length })}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-0">
          <div className="px-3 py-2 border-b border-border text-xs font-medium">
            {fill(t.inUseByTasks, { n: tasks.length })}
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            {tasks.map((x) => (
              <div key={x.id} className="px-3 py-1 text-xs truncate" title={x.name}>
                {x.name}
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    );
  };

  const deleteTarget = rows.find((r) => r.id === deleteId) ?? null;

  return (
    <div className="max-w-3xl mx-auto p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Network className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">{t.proxiesTitle}</h1>
        </div>
        <div className="flex items-center gap-2">
          {rows.length > 0 && (
            <Button size="sm" variant="outline" className="gap-2" onClick={refreshAll} disabled={refreshingAll}>
              <RefreshCw className={`h-4 w-4 ${refreshingAll ? "animate-spin" : ""}`} />{t.refreshExitAll}
            </Button>
          )}
          <Button size="sm" className="gap-2" onClick={openCreate}><Plus className="h-4 w-4" />{t.addProxy}</Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">{t.proxiesIntro}</p>

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : rows.length === 0 ? (
        <Card className="border-dashed border-border">
          <CardContent className="flex flex-col items-center justify-center py-12 gap-3 text-center">
            <Network className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t.noProxiesYet}</p>
            <Button size="sm" variant="outline" onClick={openCreate} className="gap-2 mt-2"><Plus className="h-4 w-4" />{t.addProxy}</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {rows.map((p) => (
            <Card key={p.id} className="border-border shadow-sm">
              <CardHeader className="pb-2 bg-muted/20 border-b border-border flex-row items-center justify-between py-3 px-4 gap-3">
                <div className="min-w-0 space-y-1">
                  <CardTitle className="text-sm font-semibold">{p.name}</CardTitle>
                  {/* The URL is not repeated here. It is long, it is the one field that
                      carries credentials, and the edit dialog shows it in full the moment
                      anyone actually needs it. The exit geo below identifies the proxy far
                      better than a truncated vless:// string does. */}
                  <GeoLine geo={p.exitGeo} />
                  <UsageLine tasks={p.usedBy} />
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button variant="ghost" size="icon" className="h-7 w-7" title={t.refreshExitOne} onClick={() => refreshOne(p.id)} disabled={refreshingId === p.id || refreshingAll}>
                    <RefreshCw className={`h-4 w-4 ${refreshingId === p.id ? "animate-spin" : ""}`} />
                  </Button>
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
          <DialogHeader><DialogTitle>{editingId ? t.editProxy : t.addProxy}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>{t.fieldName}</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t.proxyNameExample} />
            </div>
            <div className="space-y-1.5">
              <Label>{t.proxyUrlLabel}</Label>
              <Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="socks5://user:pass@host:port" className="font-mono" />
              <p className="text-xs text-muted-foreground">{t.proxyUrlHint}</p>
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

      <AlertDialog open={deleteId !== null} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.deleteProxyTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {t.deleteProxyDesc}
              {deleteTarget && deleteTarget.usedBy && deleteTarget.usedBy.length > 0 && (
                <span className="mt-2 block text-amber-600 dark:text-amber-400">
                  {t.deleteInUseWarning}
                  {/* All of them, scrolled — this is the confirmation for an action that
                      touches every one of these tasks, so "and 14 more" is the wrong place
                      to economise. */}
                  <span className="mt-1 block max-h-40 overflow-y-auto font-mono text-xs">
                    {deleteTarget.usedBy.map((x) => x.name).join(", ")}
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
