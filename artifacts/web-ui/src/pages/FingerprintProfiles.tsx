import { useState, useEffect } from "react";
import { Fingerprint, Plus, Trash2, Pencil, Loader2, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { useLang } from "@/contexts/lang-context";
import { UsedByTasks } from "@/components/UsedByTasks";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

/** A task that has this fingerprint selected — supplied by the list endpoint. */
interface TaskRef {
  id: number;
  name: string;
}
interface FingerprintProfile {
  id: number;
  name: string;
  os: string;
  config: { locale?: string; timezone?: string; screen?: string } | null;
  createdAt: string;
  updatedAt: string;
  usedBy?: TaskRef[];
}

interface Form {
  name: string;
  os: string;
  locale: string;
  timezone: string;
  screen: string;
}

const EMPTY: Form = { name: "", os: "windows", locale: "", timezone: "", screen: "" };

/**
 * Render a screen value as "1920x1080", whatever shape it arrives in.
 *
 * A generated fingerprint carries its screen as structured data, and older sidecar builds
 * stored it as the raw object — which the edit dialog then dropped straight into the text
 * field, so you saw {'width': 1536, 'height': 864, 'colorDepth': 24, ...} instead of a
 * resolution. Accepts an object, a "WxH" string, or a stringified dict.
 */
function formatScreen(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    const o = value as { width?: number; height?: number };
    return o.width && o.height ? `${o.width}x${o.height}` : "";
  }
  const raw = String(value).trim();
  if (!raw) return "";
  if (/^\d+\s*[x\u00d7]\s*\d+$/i.test(raw)) return raw.replace(/\s+/g, "");
  const w = /["']?width["']?\s*[:=]\s*(\d+)/i.exec(raw)?.[1];
  const h = /["']?height["']?\s*[:=]\s*(\d+)/i.exec(raw)?.[1];
  return w && h ? `${w}x${h}` : "";
}
const OS_OPTIONS = [
  { value: "windows", label: "Windows" },
  { value: "mac", label: "macOS" },
  { value: "linux", label: "Linux" },
];

export default function FingerprintProfiles() {
  const { toast } = useToast();
  const { t } = useLang();
  const [rows, setRows] = useState<FingerprintProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [source, setSource] = useState<"browserforge" | "preset">("browserforge");
  const [generating, setGenerating] = useState(false);
  // The generated fingerprint config (opaque: {source, os, fp|preset, summary}) that gets
  // saved verbatim into the profile, plus its human-readable summary for display.
  const [generated, setGenerated] = useState<Record<string, unknown> | null>(null);
  const [genSummary, setGenSummary] = useState<Record<string, unknown> | null>(null);

  const fill = (template: string, vars: Record<string, string | number>) =>
    Object.entries(vars).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), template);

  const load = () => {
    setLoading(true);
    fetch(`${BASE}/api/fingerprint-profiles`)
      .then((r) => r.json())
      .then((data) => setRows(data))
      .catch(() => toast({ title: t.failedToLoad, variant: "destructive" }))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openCreate = () => {
    setEditingId(null); setForm(EMPTY); setGenerated(null); setGenSummary(null); setSource("browserforge"); setDialogOpen(true);
  };
  const openEdit = (p: FingerprintProfile) => {
    setEditingId(p.id);
    const cfg = (p.config ?? {}) as Record<string, unknown>;
    // A generated fingerprint carries its own screen (in summary) — show it so the field
    // isn't blank on edit. (For generated profiles it's fixed; the manual field only
    // applies to the non-generated cf-proxy fallback.)
    const summaryScreen = formatScreen((cfg.summary as { screen?: unknown } | undefined)?.screen);
    setForm({
      name: p.name,
      os: p.os,
      locale: (cfg.locale as string) ?? "",
      timezone: (cfg.timezone as string) ?? "",
      screen: formatScreen(cfg.screen) || summaryScreen,
    });
    // A saved generated fingerprint carries fp/preset/summary — keep it fixed on edit.
    if (cfg.fp || cfg.preset) { setGenerated(cfg); setGenSummary((cfg.summary as Record<string, unknown>) ?? null); }
    else { setGenerated(null); setGenSummary(null); }
    setSource(((cfg.source as string) === "preset") ? "preset" : "browserforge");
    setDialogOpen(true);
  };

  const doGenerate = async () => {
    setGenerating(true);
    try {
      const r = await fetch(`${BASE}/api/fingerprint-profiles/generate?os=${encodeURIComponent(form.os)}&source=${source}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "generate failed");
      setGenerated(data.config);
      setGenSummary(data.summary);
      toast({ title: t.fingerprintGenerated, variant: "success" });
    } catch (err) {
      toast({ title: t.generateFailed, description: err instanceof Error ? err.message : "", variant: "destructive" });
    } finally {
      setGenerating(false);
    }
  };

  const handleSubmit = async () => {
    if (!form.name.trim()) { toast({ title: t.nameRequired, variant: "destructive" }); return; }
    setSubmitting(true);
    try {
      // If a fingerprint was generated, save it VERBATIM (fp/preset/summary) so it stays
      // fixed; otherwise fall back to the manual timezone/locale/screen fields.
      const config: Record<string, unknown> = generated ? { ...generated } : {};
      if (form.locale.trim()) config.locale = form.locale.trim();
      if (form.timezone.trim()) config.timezone = form.timezone.trim();
      if (!generated && form.screen.trim()) config.screen = form.screen.trim();
      const url = editingId ? `${BASE}/api/fingerprint-profiles/${editingId}` : `${BASE}/api/fingerprint-profiles`;
      const res = await fetch(url, {
        method: editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: form.name.trim(), os: form.os, config: Object.keys(config).length ? config : null }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || (await res.text()));
      toast({ title: editingId ? t.fingerprintUpdated : t.fingerprintSaved, variant: "success" });
      setDialogOpen(false);
      load();
    } catch (err) {
      toast({ title: t.failedToSave, description: err instanceof Error ? err.message : "", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      const res = await fetch(`${BASE}/api/fingerprint-profiles/${deleteId}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({} as { affectedTasks?: number }));
      toast({ title: t.fingerprintDeleted, description: data.affectedTasks ? fill(t.tasksFellBackToDefaultFp, { n: data.affectedTasks }) : undefined, variant: "success" });
      setDeleteId(null);
      load();
    } catch {
      toast({ title: t.failedToDelete, variant: "destructive" });
    }
  };


  const deleteTarget = rows.find((r) => r.id === deleteId) ?? null;

  return (
    <div className="max-w-3xl mx-auto p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Fingerprint className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">{t.fingerprintsTitle}</h1>
        </div>
        <Button size="sm" className="gap-2" onClick={openCreate}><Plus className="h-4 w-4" />{t.addFingerprint}</Button>
      </div>
      <p className="text-sm text-muted-foreground">{t.fingerprintsIntro}</p>

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : rows.length === 0 ? (
        <Card className="border-dashed border-border">
          <CardContent className="flex flex-col items-center justify-center py-12 gap-3 text-center">
            <Fingerprint className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t.noFingerprintsYet}</p>
            <Button size="sm" variant="outline" onClick={openCreate} className="gap-2 mt-2"><Plus className="h-4 w-4" />{t.addFingerprint}</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {rows.map((p) => (
            <Card key={p.id} className="border-border shadow-sm">
              <CardHeader className="pb-2 bg-muted/20 border-b border-border flex-row items-center justify-between py-3 px-4">
                <div className="min-w-0">
                  <CardTitle className="text-sm font-semibold">{p.name}</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    {OS_OPTIONS.find((o) => o.value === p.os)?.label ?? p.os}
                    {p.config?.timezone ? ` · ${p.config.timezone}` : ""}
                    {p.config?.locale ? ` · ${p.config.locale}` : ""}
                  </p>
                  <UsedByTasks tasks={p.usedBy} />
                </div>
                <div className="flex items-center gap-1 shrink-0">
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
          <DialogHeader><DialogTitle>{editingId ? t.editFingerprint : t.addFingerprint}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>{t.fieldName}</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Windows – Chrome desktop" />
            </div>
            <div className="space-y-1.5">
              <Label>{t.operatingSystem}</Label>
              <select
                value={form.os}
                onChange={(e) => setForm({ ...form, os: e.target.value })}
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                {OS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>

            {/* Generate a real, consistent fingerprint and FIX it (Camoufox) */}
            <div className="space-y-2 rounded-md border border-border p-3">
              {/* flex-wrap + min-w-0 on the select, shrink-0 on the badge. Without them the
                  select's long option text claims the whole row, the badge is squeezed to
                  zero width, and — having nothing to stop it wrapping — renders one
                  character per line as a vertical stripe down the side of the dialog. */}
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={source}
                  onChange={(e) => setSource(e.target.value as "browserforge" | "preset")}
                  className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="browserforge">{t.sourceBrowserforge}</option>
                  <option value="preset">{t.sourceRealPreset}</option>
                </select>
                <Button type="button" variant="outline" size="sm" onClick={doGenerate} disabled={generating} className="gap-2">
                  {generating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{t.generateFingerprint}
                </Button>
                {generated && <span className="shrink-0 whitespace-nowrap text-[11px] text-emerald-500">{t.generatedFixedOnSave}</span>}
              </div>
              {genSummary ? (
                <div className="text-[11px] font-mono text-muted-foreground space-y-0.5 break-all">
                  {genSummary.webglRenderer || genSummary.webglVendor ? <div>{t.gpuLabel}: {[genSummary.webglVendor, genSummary.webglRenderer].filter(Boolean).map(String).join(" · ")}</div> : null}
                  {formatScreen(genSummary.screen) ? <div>{t.screenLabel}: {formatScreen(genSummary.screen)}</div> : null}
                  {genSummary.platform ? <div>{t.platformLabel}: {String(genSummary.platform)}</div> : null}
                  {genSummary.hardwareConcurrency != null ? <div>{t.cpuCoresLabel}: {String(genSummary.hardwareConcurrency)}</div> : null}
                  {genSummary.userAgent ? <div>UA: {String(genSummary.userAgent)}</div> : null}
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">{t.generateHint}</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Timezone <span className="text-muted-foreground">({t.optionalSuffix})</span></Label>
                <Input value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} placeholder={t.autoFromProxyIp} />
              </div>
              <div className="space-y-1.5">
                <Label>Locale <span className="text-muted-foreground">({t.optionalSuffix})</span></Label>
                <Input value={form.locale} onChange={(e) => setForm({ ...form, locale: e.target.value })} placeholder={t.autoFromProxyIp} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>
                Screen{" "}
                <span className="text-muted-foreground">
                  ({generated ? t.screenFixedByFingerprint : t.optionalSuffix})
                </span>
              </Label>
              <Input
                value={form.screen}
                onChange={(e) => setForm({ ...form, screen: e.target.value })}
                placeholder="1920x1080"
                disabled={!!generated}
              />
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
            <AlertDialogTitle>{t.deleteFingerprintTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {t.deleteFingerprintDesc}
              {deleteTarget && deleteTarget.usedBy && deleteTarget.usedBy.length > 0 && (
                <span className="mt-2 block text-amber-600 dark:text-amber-400">
                  {t.deleteInUseWarning}
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
