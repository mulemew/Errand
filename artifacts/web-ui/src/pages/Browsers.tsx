import { useState, useEffect } from "react";
import { Monitor, Plus, Square, Loader2, Save, Trash2, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useLang } from "@/contexts/lang-context";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface Ref { id: number; name: string; type?: string }
interface Instance {
  id: string;
  name: string;
  providerId: number | null;
  fingerprintProfileId: number | null;
  proxyProfileId: number | null;
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
  updatedAt: string;
}

const NONE = "none";

/**
 * Long-lived browsers you drive by hand.
 *
 * A task's browser lives for one run and is thrown away. These are held open until you stop
 * them, in a chosen environment (backend + fingerprint + proxy), so you can do the things a
 * script cannot — register an account, clear a challenge that needs a human — and then save
 * the resulting session for a task that will run in the SAME environment.
 */
export default function Browsers() {
  const { t } = useLang();
  const { toast } = useToast();

  const [providers, setProviders] = useState<Ref[]>([]);
  const [fingerprints, setFingerprints] = useState<Ref[]>([]);
  const [proxies, setProxies] = useState<Ref[]>([]);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [profiles, setProfiles] = useState<SessionProfile[]>([]);

  const [name, setName] = useState("");
  const [providerId, setProviderId] = useState(NONE);
  const [fingerprintId, setFingerprintId] = useState(NONE);
  const [proxyId, setProxyId] = useState(NONE);
  const [startUrl, setStartUrl] = useState("");
  const [launching, setLaunching] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Instance | null>(null);

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

  const launch = async () => {
    setLaunching(true);
    try {
      const res = await fetch(`${BASE}/api/browsers`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || undefined,
          providerId: providerId === NONE ? null : Number(providerId),
          fingerprintProfileId: fingerprintId === NONE ? null : Number(fingerprintId),
          proxyProfileId: proxyId === NONE ? null : Number(proxyId),
          startUrl: startUrl.trim() || undefined,
        }),
      });
      const data = (await res.json()) as { id?: string; error?: string };
      if (!res.ok) {
        toast({ title: t.browserLaunchFailed, description: data.error, variant: "destructive" });
        return;
      }
      setName("");
      setStartUrl("");
      load();
    } catch {
      toast({ title: t.networkError, variant: "destructive" });
    } finally {
      setLaunching(false);
    }
  };

  const stop = async (id: string) => {
    setBusyId(id);
    try {
      await fetch(`${BASE}/api/browsers/${id}`, { method: "DELETE", credentials: "same-origin" });
      if (viewing?.id === id) setViewing(null);
      load();
    } finally {
      setBusyId(null);
    }
  };

  const saveSession = async (inst: Instance) => {
    const profileName = window.prompt(t.sessionProfileNamePrompt, inst.name);
    if (!profileName?.trim()) return;
    setBusyId(inst.id);
    try {
      const res = await fetch(`${BASE}/api/browsers/${inst.id}/save-session`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: profileName.trim() }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        toast({ title: t.saveFailed, description: data.error, variant: "destructive" });
        return;
      }
      toast({ title: t.sessionProfileSaved, variant: "success" });
      load();
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Reopen a saved profile as a running browser.
   *
   * Only the id is sent. The server resolves the provider, fingerprint and proxy from the
   * profile itself, because a session is only valid in the environment it was made in —
   * sending saved cookies out through a different exit IP turns a working login into a
   * security prompt. It also lands on the page the session was last used on, so what you
   * get is the logged-in site rather than a blank tab.
   */
  const openProfile = async (sessionProfileId: number) => {
    try {
      const r = await fetch(`${BASE}/api/browsers`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionProfileId }),
      });
      const data = (await r.json()) as { id?: string; error?: string };
      if (!r.ok || !data.id) {
        toast({ title: t.browserLaunchFailed, description: data.error, variant: "destructive" });
        return;
      }
      toast({ title: t.reopenedFromProfile, variant: "success" });
      load();
      setViewing({ id: data.id, name: "" } as never);
    } catch (err) {
      toast({ title: err instanceof Error ? err.message : String(err), variant: "destructive" });
    }
  };

  const deleteProfile = async (id: number) => {
    await fetch(`${BASE}/api/session-profiles/${id}`, { method: "DELETE", credentials: "same-origin" });
    load();
  };

  const refName = (list: Ref[], id: number | null) => list.find((r) => r.id === id)?.name ?? t.noneValue;
  const canPreview = (inst: Instance) =>
    providers.find((p) => p.id === inst.providerId)?.type === "camoufox";

  return (
    <div className="max-w-4xl mx-auto p-4 md:p-6 space-y-4">
      <div className="flex items-center gap-2">
        <Monitor className="h-5 w-5 text-primary" />
        <h1 className="text-lg font-semibold">{t.navBrowsers}</h1>
      </div>
      <p className="text-xs text-muted-foreground -mt-2">{t.browsersIntro}</p>

      {/* ── New instance ── */}
      <Card className="border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">{t.newBrowserInstance}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">{t.fieldName}</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.browserNameExample} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t.navProviders}</Label>
              <Select value={providerId} onValueChange={setProviderId}>
                <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t.defaultValue}</SelectItem>
                  {providers.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>{p.name}（{p.type}）</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t.navFingerprints}</Label>
              <Select value={fingerprintId} onValueChange={setFingerprintId}>
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
              <Label className="text-xs">{t.navProxies}</Label>
              <Select value={proxyId} onValueChange={setProxyId}>
                <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t.noneValue}</SelectItem>
                  {proxies.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t.startingUrl}</Label>
            <Input value={startUrl} onChange={(e) => setStartUrl(e.target.value)} placeholder="https://example.com" className="font-mono text-sm" />
          </div>
          <Button onClick={launch} disabled={launching} className="gap-2">
            {launching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {t.launchBrowser}
          </Button>
        </CardContent>
      </Card>

      {/* ── Running instances ── */}
      <Card className="border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">{t.runningBrowsers}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {instances.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t.noRunningBrowsers}</p>
          ) : (
            instances.map((inst) => (
              <div key={inst.id} className="flex items-center gap-2 p-2 rounded border border-border">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{inst.name}</p>
                  <p className="text-[11px] text-muted-foreground font-mono truncate">{inst.url}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {refName(providers, inst.providerId)} · {refName(fingerprints, inst.fingerprintProfileId)} · {refName(proxies, inst.proxyProfileId)}
                  </p>
                </div>
                {canPreview(inst) && (
                  <Button variant="ghost" size="icon" className="h-7 w-7" title={t.liveViewTitle} onClick={() => setViewing(inst)}>
                    <Globe className="h-4 w-4" />
                  </Button>
                )}
                <Button variant="ghost" size="icon" className="h-7 w-7" title={t.saveAsSessionProfile}
                  onClick={() => void saveSession(inst)} disabled={busyId === inst.id}>
                  <Save className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" title={t.stopBrowser}
                  onClick={() => void stop(inst.id)} disabled={busyId === inst.id}>
                  <Square className="h-4 w-4" />
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* ── Saved sessions ── */}
      <Card className="border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">{t.sessionProfiles}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">{t.sessionProfilesHint}</p>
          {profiles.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t.noSessionProfiles}</p>
          ) : (
            profiles.map((p) => (
              <div key={p.id} className="flex items-center gap-2 p-2 rounded border border-border">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{p.name}</p>
                  <p className="text-[11px] text-muted-foreground font-mono truncate">{p.originUrl ?? ""}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {refName(providers, p.providerId)} · {refName(fingerprints, p.fingerprintProfileId)} · {refName(proxies, p.proxyProfileId)}
                  </p>
                </div>
                <Button variant="outline" size="sm" className="h-7 text-xs shrink-0"
                  onClick={() => void openProfile(p.id)}>
                  {t.openProfile}
                </Button>
                <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive"
                  onClick={() => void deleteProfile(p.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Live screen. Mounting the iframe is what opens the connection, so it exists only
          while the dialog is open — closing it puts the browser back in the background
          without stopping it. */}
      <Dialog open={viewing !== null} onOpenChange={(o) => !o && setViewing(null)}>
        <DialogContent className="max-w-6xl w-full p-2">
          <div className="flex flex-wrap items-center justify-between gap-2 px-1 pb-2">
            <p className="text-xs text-muted-foreground">{t.liveViewHint}</p>
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
          </div>
          {viewing && (
            <iframe
              // THIS instance's own display. Asking for the provider showed the sidecar's
              // shared screen, where nothing is drawn — a black rectangle, every time.
              src={`${BASE}/api/live-view/${viewing.id}/`}
              title={t.liveViewTitle}
              className="w-full rounded border border-border bg-black"
              style={{ height: "70vh" }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
