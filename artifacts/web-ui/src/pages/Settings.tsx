import { useState, useEffect, useRef, FormEvent } from "react";
import {
  RefreshCw, KeyRound, Loader2, CheckCircle2, AlertTriangle, Archive,
  Globe, Wifi, WifiOff, ShieldCheck, Timer, Info, Server,
  Database, Cpu, FileText,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Link } from "wouter";
import { usePollingInterval, POLLING_OPTIONS, type PollingIntervalMs } from "@/hooks/use-polling-interval";
import { useLang } from "@/contexts/lang-context";
import { useToast } from "@/hooks/use-toast";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");


  // ── Retention / Cleanup Settings ─────────────────────────────────────────────

  interface RetentionConfig {
    logRetentionDays: number;
    maxScreenshotsMb: number;
  }

  function RetentionSection() {
    const { t } = useLang();
    const [config, setConfig] = useState<RetentionConfig | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [cleaning, setCleaning] = useState(false);
    const [logDays, setLogDays] = useState("");
    const [maxMb, setMaxMb] = useState("");
    const { toast } = useToast();

    useEffect(() => {
      fetch(`${BASE}/api/settings/retention`, { credentials: "same-origin" })
        .then((r) => r.ok ? r.json() as Promise<RetentionConfig> : null)
        .then((d) => {
          if (d) {
            setConfig(d);
            setLogDays(String(d.logRetentionDays));
            setMaxMb(String(d.maxScreenshotsMb));
          }
          setLoading(false);
        })
        .catch(() => setLoading(false));
    }, []);

    const handleSave = async (e: FormEvent) => {
      e.preventDefault();
      setSaving(true);
      try {
        const res = await fetch(`${BASE}/api/settings/retention`, {
          method: "PUT",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            logRetentionDays: parseInt(logDays, 10) || 0,
            maxScreenshotsMb: parseInt(maxMb, 10) || 0,
          }),
        });
        if (res.ok) {
          toast({ title: t.retentionSaved, variant: "success" });
        } else {
          toast({ title: t.saveFailed, variant: "destructive" });
        }
      } catch {
        toast({ title: t.networkError, variant: "destructive" });
      } finally {
        setSaving(false);
      }
    };

    const handleCleanupNow = async () => {
      setCleaning(true);
      try {
        const res = await fetch(`${BASE}/api/settings/retention/cleanup`, {
          method: "POST",
          credentials: "same-origin",
        });
        if (res.ok) {
          toast({ title: t.cleanupComplete, description: t.cleanupCompleteDesc, variant: "success" });
        } else {
          toast({ title: t.cleanupFailed, variant: "destructive" });
        }
      } catch {
        toast({ title: "Network error", variant: "destructive" });
      } finally {
        setCleaning(false);
      }
    };

    return (
      <div className="space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-4 w-4 animate-spin" /> {t.loading}</div>
        ) : (
          <form onSubmit={handleSave} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="logDays">{t.logRetentionDays}</Label>
                <Input
                  id="logDays"
                  type="number"
                  min="0"
                  value={logDays}
                  onChange={(e) => setLogDays(e.target.value)}
                  placeholder="7"
                />
                <p className="text-xs text-muted-foreground">{t.logRetentionDesc}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="maxMb">{t.maxScreenshotStorage}</Label>
                <Input
                  id="maxMb"
                  type="number"
                  min="0"
                  value={maxMb}
                  onChange={(e) => setMaxMb(e.target.value)}
                  placeholder="1024"
                />
                <p className="text-xs text-muted-foreground">{t.maxScreenshotDesc}</p>
              </div>
            </div>
            <div className="flex gap-2 flex-wrap">
              <Button type="submit" disabled={saving} size="sm">
                {saving ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />{t.saving}</> : t.saveTask}
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={cleaning} onClick={handleCleanupNow}>
                {cleaning ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />{t.loading}</> : t.runCleanupNow}
              </Button>
            </div>
          </form>
        )}
      </div>
    );
  }

  // ── About / System Info ───────────────────────────────────────────────────────

interface SystemInfo {
  version: string;
  nodeVersion: string;
  platform: string;
  uptimeSeconds: number;
  dbStatus: "connected" | "error";
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function AboutSection() {
  const { t } = useLang();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${BASE}/api/settings/system-info`, { credentials: "same-origin" })
      .then((r) => r.ok ? r.json() : null)
      .then((d: SystemInfo | null) => { setInfo(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const rows: Array<{ icon: React.ReactNode; label: string; value: React.ReactNode }> = info
    ? [
        {
          icon: <Info className="h-4 w-4 text-muted-foreground" />,
          label: t.version,
          value: <span className="font-mono text-sm">{info.version}</span>,
        },
        {
          icon: <Cpu className="h-4 w-4 text-muted-foreground" />,
          label: "Node.js",
          value: <span className="font-mono text-sm">{info.nodeVersion}</span>,
        },
        {
          icon: <Server className="h-4 w-4 text-muted-foreground" />,
          label: t.platform,
          value: <span className="font-mono text-sm">{info.platform}</span>,
        },
        {
          icon: <RefreshCw className="h-4 w-4 text-muted-foreground" />,
          label: t.uptime,
          value: <span className="font-mono text-sm">{formatUptime(info.uptimeSeconds)}</span>,
        },
        {
          icon: <Database className="h-4 w-4 text-muted-foreground" />,
          label: t.database,
          value: info.dbStatus === "connected" ? (
            <span className="flex items-center gap-1.5 text-green-600 dark:text-green-400 font-mono text-sm">
              <Wifi className="h-3 w-3" /> {t.dbConnected}
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-destructive font-mono text-sm">
              <WifiOff className="h-3 w-3" /> {t.dbError}
            </span>
          ),
        },
      ]
    : [];

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex items-center justify-between py-2 border-b border-border last:border-0">
            <div className="h-4 w-24 bg-muted rounded animate-pulse" />
            <div className="h-4 w-32 bg-muted rounded animate-pulse" />
          </div>
        ))}
      </div>
    );
  }

  if (!info) {
    return <p className="text-sm text-muted-foreground">{t.systemInfoFailed}</p>;
  }

  return (
    <dl className="space-y-0 divide-y divide-border">
      {rows.map(({ icon, label, value }) => (
        <div key={label} className="flex items-center justify-between py-3">
          <dt className="flex items-center gap-2 text-sm text-muted-foreground">
            {icon}
            {label}
          </dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const INTERVAL_LABELS: Record<PollingIntervalMs, string> = {
  1000: "1 second — fastest, higher server load",
  2000: "2 seconds — balanced (default)",
  5000: "5 seconds — slower, reduced network usage",
};

// ── Task Timeout Section ──────────────────────────────────────────────────────

const TIMEOUT_OPTIONS: Array<{ minutes: number; label: string; sublabel: string }> = [
  { minutes: 0,  label: "disabled", sublabel: "Tasks run until they finish or crash" },
  { minutes: 5,  label: "5 min", sublabel: "Short tasks / quick logins" },
  { minutes: 10, label: "10 min", sublabel: "Recommended for most workflows" },
  { minutes: 30, label: "30 min", sublabel: "Default — long-running workflows" },
  { minutes: 60, label: "60 min", sublabel: "Very slow sites or complex pipelines" },
];

function TaskTimeoutSection() {
  const { t } = useLang();
  const { toast } = useToast();
  const [timeoutMinutes, setTimeoutMinutes] = useState<number>(30);
  const [custom, setCustom] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`${BASE}/api/settings/task-timeout`, { credentials: "same-origin" })
      .then((r) => r.json())
      .then((data: { timeoutMinutes: number }) => {
        setTimeoutMinutes(data.timeoutMinutes);
        const isPreset = TIMEOUT_OPTIONS.some((o) => o.minutes === data.timeoutMinutes);
        if (!isPreset) setCustom(String(data.timeoutMinutes));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const isCustomSelected = !TIMEOUT_OPTIONS.some((o) => o.minutes === timeoutMinutes);

  const handleSave = async () => {
    const value = isCustomSelected ? Number(custom) : timeoutMinutes;
    if (!Number.isFinite(value) || value < 0) {
      toast({ title: t.saveFailed, description: "Enter a positive number of minutes, or 0 to disable.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${BASE}/api/settings/task-timeout`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeoutMinutes: Math.floor(value) }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        toast({ title: t.saveFailed, description: data.error, variant: "destructive" });
        return;
      }
      setTimeoutMinutes(Math.floor(value));
      toast({ title: t.timeoutSaved, variant: "success" });
    } catch {
      toast({ title: "Network error", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-6 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {TIMEOUT_OPTIONS.map(({ minutes, label, sublabel }) => {
        const selected = !isCustomSelected && timeoutMinutes === minutes;
        return (
          <button
            key={minutes}
            type="button"
            onClick={() => { setTimeoutMinutes(minutes); setCustom(""); }}
            className={`w-full flex items-center justify-between p-3 rounded-md border text-left transition-all duration-150 ${
              selected
                ? "border-primary bg-primary/5 text-foreground"
                : "border-border bg-card hover:bg-accent/40 text-muted-foreground hover:text-foreground"
            }`}
          >
            <div className="flex items-center gap-3">
              <div className={`flex-shrink-0 h-3 w-3 rounded-full border-2 ${
                selected ? "border-primary bg-primary" : "border-muted-foreground"
              }`} />
              <span className="font-mono font-semibold text-sm">{label === "disabled" ? t.timeoutDisabled : label}</span>
            </div>
            <span className="text-xs font-mono opacity-70">{sublabel}</span>
          </button>
        );
      })}

      {/* Custom value */}
      <div
        className={`flex items-center gap-3 p-3 rounded-md border transition-all duration-150 ${
          isCustomSelected
            ? "border-primary bg-primary/5"
            : "border-border bg-card hover:bg-accent/40"
        }`}
      >
        <div className={`flex-shrink-0 h-3 w-3 rounded-full border-2 ${
          isCustomSelected ? "border-primary bg-primary" : "border-muted-foreground"
        }`} />
        <span className="font-mono font-semibold text-sm shrink-0">{t.timeoutCustom}</span>
        <Input
          type="number"
          min={1}
          value={custom}
          onChange={(e) => {
            setCustom(e.target.value);
            const n = Number(e.target.value);
            if (e.target.value && Number.isFinite(n)) setTimeoutMinutes(n);
          }}
          placeholder="e.g. 45"
          className="h-7 w-24 font-mono text-sm px-2"
          onClick={(e) => e.stopPropagation()}
        />
        <span className="text-xs text-muted-foreground">{t.timeoutMinutes}</span>
      </div>

      <Button onClick={handleSave} disabled={saving} className="mt-1">
        {saving ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />{t.saving}</> : t.saveTask}
      </Button>
    </div>
  );
}

// ── Captcha Section ───────────────────────────────────────────────────────────

type CaptchaProviderType = "none" | "2captcha" | "capsolver" | "anticaptcha";

interface CaptchaConfig {
  provider: CaptchaProviderType;
  /** reCAPTCHA audio solver — independent of the paid provider above. */
  sttOrder?: string;
  witAiToken?: string;
  witAiTokenSet?: boolean;
  /** Read-only: what the environment supplies when the fields above are empty. */
  sttOrderEnv?: string;
  witAiTokenFromEnv?: boolean;
  twoCaptchaApiKey: string;
  capsolverApiKey: string;
  anticaptchaApiKey: string;
  twoCaptchaKeySet?: boolean;
  capsolverKeySet?: boolean;
  anticaptchaKeySet?: boolean;
}

const CAPTCHA_PROVIDER_OPTIONS: Array<{
  value: CaptchaProviderType;
  label: string;
  description: string;
  keyField: keyof CaptchaConfig;
  keyLabel: string;
  placeholder: string;
  docsUrl: string;
}> = [
  {
    value: "2captcha",
    label: "2Captcha",
    description: "Human-powered solving. Supports reCAPTCHA, hCaptcha, Turnstile, and image captchas.",
    keyField: "twoCaptchaApiKey",
    keyLabel: "2Captcha API Key",
    placeholder: "Paste your 2captcha.com API key",
    docsUrl: "https://2captcha.com/enterpage",
  },
  {
    value: "capsolver",
    label: "Capsolver",
    description: "AI-powered solver. Fast and cost-effective for reCAPTCHA and hCaptcha.",
    keyField: "capsolverApiKey",
    keyLabel: "Capsolver API Key",
    placeholder: "Paste your capsolver.com API key",
    docsUrl: "https://capsolver.com",
  },
  {
    value: "anticaptcha",
    label: "Anti-Captcha",
    description: "Human-powered solving. Supports reCAPTCHA v2/v3, hCaptcha, Turnstile, and image captchas.",
    keyField: "anticaptchaApiKey",
    keyLabel: "Anti-Captcha API Key",
    placeholder: "Paste your anti-captcha.com API key",
    docsUrl: "https://anti-captcha.com",
  },
];

function CaptchaSection() {
  const { t } = useLang();
  const { toast } = useToast();
  const [config, setConfig] = useState<CaptchaConfig>({
    provider: "none",
    sttOrder: "",
    witAiToken: "",
    twoCaptchaApiKey: "",
    capsolverApiKey: "",
    anticaptchaApiKey: "",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`${BASE}/api/settings/captcha`, { credentials: "same-origin" })
      .then((r) => r.json())
      .then((data: CaptchaConfig) => setConfig(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${BASE}/api/settings/captcha`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        toast({ title: t.saveFailed, description: data.error, variant: "destructive" });
        return;
      }
      toast({ title: t.captchaSaved, variant: "success" });
    } catch {
      toast({ title: "Network error", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-6 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  const activeOption = CAPTCHA_PROVIDER_OPTIONS.find((o) => o.value === config.provider);
  const activeKeyIsSet =
    config.provider === "2captcha" ? config.twoCaptchaKeySet :
    config.provider === "capsolver" ? config.capsolverKeySet :
    config.provider === "anticaptcha" ? config.anticaptchaKeySet : false;

  return (
    <div className="space-y-5">
      {/* Provider selection */}
      <div className="space-y-2">
        <Label>{t.captchaProvider}</Label>
        <div className="space-y-2">
          {/* None option */}
          <button
            type="button"
            onClick={() => setConfig((c) => ({ ...c, provider: "none" }))}
            className={`w-full flex items-center gap-3 p-3 rounded-md border text-left transition-all duration-150 ${
              config.provider === "none"
                ? "border-primary bg-primary/5 text-foreground"
                : "border-border bg-card hover:bg-accent/40 text-muted-foreground hover:text-foreground"
            }`}
          >
            <div className={`flex-shrink-0 h-3 w-3 rounded-full border-2 ${
              config.provider === "none" ? "border-primary bg-primary" : "border-muted-foreground"
            }`} />
            <div>
              <p className="font-mono font-semibold text-sm">{t.noCaptcha}</p>
              <p className="text-xs mt-0.5 opacity-70">{t.captchaNoneHint}</p>
            </div>
          </button>

          {CAPTCHA_PROVIDER_OPTIONS.map(({ value, label, description }) => {
            const selected = config.provider === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => setConfig((c) => ({ ...c, provider: value }))}
                className={`w-full flex items-center gap-3 p-3 rounded-md border text-left transition-all duration-150 ${
                  selected
                    ? "border-primary bg-primary/5 text-foreground"
                    : "border-border bg-card hover:bg-accent/40 text-muted-foreground hover:text-foreground"
                }`}
              >
                <div className={`flex-shrink-0 h-3 w-3 rounded-full border-2 ${
                  selected ? "border-primary bg-primary" : "border-muted-foreground"
                }`} />
                <div className="min-w-0">
                  <p className="font-mono font-semibold text-sm">{label}</p>
                  <p className="text-xs mt-0.5 opacity-70">{description}</p>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* API Key input — only shown when a provider is selected */}
      {activeOption && (
        <div className="space-y-2">
          <Label htmlFor="captchaApiKey">{activeOption.keyLabel}</Label>
          <Input
            id="captchaApiKey"
            type="text"
            value={(config[activeOption.keyField] as string) ?? ""}
            onChange={(e) =>
              setConfig((c) => ({ ...c, [activeOption.keyField]: e.target.value }))
            }
            placeholder={activeKeyIsSet ? "Key saved — paste to replace" : activeOption.placeholder}
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            Get your key at{" "}
            <a href={activeOption.docsUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
              {activeOption.docsUrl.replace("https://", "")}
            </a>
            {activeKeyIsSet && (
              <span className="ml-2 text-green-600 dark:text-green-400 font-medium">✓ {t.valueSaved}</span>
            )}
          </p>
        </div>
      )}

      {/* Audio solving — deliberately OUTSIDE the provider block: the reCAPTCHA audio
          challenge is answered locally and works whether or not a paid provider is set. */}
      <div className="space-y-3 rounded-md border border-border p-3">
        <div>
          <p className="text-sm font-semibold">{t.audioSolverTitle}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{t.audioSolverHint}</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="sttOrder">{t.sttOrderLabel}</Label>
          <Input
            id="sttOrder"
            type="text"
            value={config.sttOrder ?? ""}
            onChange={(e) => setConfig((c) => ({ ...c, sttOrder: e.target.value }))}
            placeholder="whisper,witai,google"
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            {t.sttOrderHint}
            {!config.sttOrder?.trim() && config.sttOrderEnv && (
              <span className="ml-1">{t.savedInEnv.replace("{v}", config.sttOrderEnv)}</span>
            )}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="witAiToken">{t.witAiTokenLabel}</Label>
          <Input
            id="witAiToken"
            type="text"
            value={config.witAiToken ?? ""}
            onChange={(e) => setConfig((c) => ({ ...c, witAiToken: e.target.value }))}
            placeholder={config.witAiTokenSet ? t.leaveEmptyToKeep : "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"}
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            {t.witAiTokenHint}
            {config.witAiTokenSet && (
              <span className="ml-2 text-green-600 dark:text-green-400 font-medium">✓ {t.valueSaved}</span>
            )}
            {!config.witAiTokenSet && config.witAiTokenFromEnv && (
              <span className="ml-1">{t.savedInEnv.replace("{v}", t.envTokenPresent)}</span>
            )}
          </p>
        </div>
      </div>

      <Button onClick={handleSave} disabled={saving}>
        {saving ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />{t.saving}</> : "Save"}
      </Button>
    </div>
  );
}

// ── Log Level Section ───────────────────────────────────────────────────────────

type LogLevelValue = "error" | "warn" | "info" | "debug" | "trace";

function LogLevelSection() {
  const { t } = useLang();
  const { toast } = useToast();
  const [level, setLevel] = useState<LogLevelValue>("info");
  const [envLevel, setEnvLevel] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`${BASE}/api/settings/logging`, { credentials: "same-origin" })
      .then((r) => r.json())
      .then((d: { level?: LogLevelValue; envLevel?: string }) => {
        if (d.level) setLevel(d.level);
        setEnvLevel(d.envLevel ?? "");
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const save = async (next: LogLevelValue) => {
    const previous = level;
    setLevel(next);
    setSaving(true);
    try {
      const res = await fetch(`${BASE}/api/settings/logging`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level: next }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setLevel(previous);
        toast({ title: t.saveFailed, description: data.error, variant: "destructive" });
        return;
      }
      toast({ title: t.logLevelSaved, variant: "success" });
    } catch {
      setLevel(previous);
      toast({ title: "Network error", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-6 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  const OPTIONS: Array<{ value: LogLevelValue; hint: string }> = [
    { value: "error", hint: t.logLevelError },
    { value: "warn", hint: t.logLevelWarn },
    { value: "info", hint: t.logLevelInfo },
    { value: "debug", hint: t.logLevelDebug },
    { value: "trace", hint: t.logLevelTrace },
  ];

  return (
    <div className="space-y-3">
      {OPTIONS.map(({ value, hint }) => (
        <button
          key={value}
          type="button"
          disabled={saving}
          onClick={() => value !== level && save(value)}
          className={`w-full flex items-center gap-3 p-3 rounded-md border text-left transition-all duration-150 ${
            level === value
              ? "border-primary bg-primary/5 text-foreground"
              : "border-border bg-card hover:bg-accent/40 text-muted-foreground hover:text-foreground"
          }`}
        >
          <div className={`flex-shrink-0 h-3 w-3 rounded-full border-2 ${
            level === value ? "border-primary bg-primary" : "border-muted-foreground"
          }`} />
          <div className="min-w-0">
            <p className="font-mono font-semibold text-sm">{value}</p>
            <p className="text-xs mt-0.5 opacity-70">{hint}</p>
          </div>
        </button>
      ))}
      {envLevel && envLevel !== level && (
        <p className="text-xs text-muted-foreground">{t.logLevelFromEnv.replace("{v}", envLevel)}</p>
      )}
    </div>
  );
}

// ── Concurrency Section ─────────────────────────────────────────────────────────

interface ConcurrencyState {
  maxConcurrent: number;
  maxQueueDepth: number;
  queueTimeoutSecs: number;
  running: number;
  queued: number;
}

function ConcurrencySection() {
  const { t } = useLang();
  const { toast } = useToast();
  const [config, setConfig] = useState<ConcurrencyState>({ maxConcurrent: 3, maxQueueDepth: 10, queueTimeoutSecs: 300, running: 0, queued: 0 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const isDirty = useRef(false);

  const load = () =>
    fetch(`${BASE}/api/settings/concurrency`, { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((d: ConcurrencyState) => {
        if (isDirty.current) {
          setConfig((c) => ({ ...c, running: d.running, queued: d.queued }));
        } else {
          setConfig(d);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));

  useEffect(() => { load(); const id = setInterval(load, 3000); return () => clearInterval(id); }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${BASE}/api/settings/concurrency`, {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxConcurrent: config.maxConcurrent, maxQueueDepth: config.maxQueueDepth, queueTimeoutSecs: config.queueTimeoutSecs }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) { toast({ title: t.saveFailed, description: data.error, variant: 'destructive' }); return; }
      isDirty.current = false; toast({ title: t.retentionSaved, variant: 'success' });
    } catch { toast({ title: t.networkError, variant: 'destructive' }); }
    finally { setSaving(false); }
  };

  if (loading) return <div className='flex items-center gap-2 py-6 text-muted-foreground text-sm'><Loader2 className='h-4 w-4 animate-spin' /> Loading…</div>;

  return (
    <div className='space-y-5'>
      {/* Live status badge */}
      <div className='flex items-center gap-3 flex-wrap'>
        <div className='flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm'>
          <span className='text-muted-foreground text-xs'>{t.runningStream}</span>
          <span className={`font-mono font-bold text-base ${config.running > 0 ? 'text-primary' : 'text-foreground'}`}>{config.running}</span>
          <span className='text-muted-foreground text-xs'>/ {config.maxConcurrent}</span>
        </div>
        <div className='flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm'>
          <span className='text-muted-foreground text-xs'>{t.statusQueued}</span>
          <span className={`font-mono font-bold text-base ${config.queued > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'}`}>{config.queued}</span>
          {config.maxQueueDepth > 0 && <span className='text-muted-foreground text-xs'>/ {config.maxQueueDepth}</span>}
        </div>
        <p className='text-xs text-muted-foreground'>{t.liveUpdatesEvery3s}</p>
      </div>

      {/* Max concurrent */}
      <div className='space-y-2'>
        <Label htmlFor='maxConcurrent'>{t.fallbackConcurrency}</Label>
        <div className='flex items-center gap-3'>
          <Input id='maxConcurrent' type='number' min={1} max={50}
            value={config.maxConcurrent}
            onChange={(e) => { isDirty.current = true; const n = Math.max(1, parseInt(e.target.value, 10) || 1); setConfig((c) => ({ ...c, maxConcurrent: n })); }}
            className='h-9 w-24 font-mono text-sm' />
          <span className='text-xs text-muted-foreground'>{t.unitSessions}</span>
        </div>
        <p className='text-xs text-muted-foreground'>{t.fallbackConcurrencyHint}</p>
      </div>

      {/* Max queue depth */}
      <div className='space-y-2'>
        <Label htmlFor='maxQueueDepth'>{t.maxQueueDepthLabel}</Label>
        <div className='flex items-center gap-3'>
          <Input id='maxQueueDepth' type='number' min={0} max={200}
            value={config.maxQueueDepth}
            onChange={(e) => { isDirty.current = true; const n = Math.max(0, parseInt(e.target.value, 10) || 0); setConfig((c) => ({ ...c, maxQueueDepth: n })); }}
            className='h-9 w-24 font-mono text-sm' />
          <span className='text-xs text-muted-foreground'>{t.unitTasksZeroUnlimited}</span>
        </div>
        <p className='text-xs text-muted-foreground'>{t.maxQueueDepthHint}</p>
      </div>

      {/* Queue timeout */}
      <div className='space-y-2'>
        <Label htmlFor='queueTimeout'>{t.queueWaitTimeout}</Label>
        <div className='flex items-center gap-3'>
          <Input id='queueTimeout' type='number' min={0}
            value={config.queueTimeoutSecs}
            onChange={(e) => { isDirty.current = true; const n = Math.max(0, parseInt(e.target.value, 10) || 0); setConfig((c) => ({ ...c, queueTimeoutSecs: n })); }}
            className='h-9 w-24 font-mono text-sm' />
          <span className='text-xs text-muted-foreground'>{t.unitSecondsZeroForever}</span>
        </div>
        <p className='text-xs text-muted-foreground'>{t.queueTimeoutHint}</p>
      </div>

      <Button onClick={handleSave} disabled={saving}>
        {saving ? <><Loader2 className='mr-2 h-4 w-4 animate-spin' />{t.saving}</> : t.saveTask}
      </Button>
    </div>
  );
}


// ── Main Settings Page ────────────────────────────────────────────────────────

export default function Settings() {
  const { t } = useLang();
  const [pollingInterval, setPollingInterval] = usePollingInterval();
  const { toast } = useToast();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);

  const handleSelect = (ms: PollingIntervalMs) => {
    setPollingInterval(ms);
    toast({
      title: t.pollingInterval,
      description: `${ms / 1000}s`,
      variant: "success",
    });
  };

  const handlePasswordSubmit = (e: FormEvent) => {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSuccess(false);

    if (newPassword !== confirmPassword) {
      setPasswordError(t.passwordMismatch);
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError(t.passwordMismatch);
      return;
    }

    setShowConfirmDialog(true);
  };

  const submitPasswordChange = async () => {
    setShowConfirmDialog(false);
    setPasswordLoading(true);
    try {
      const res = await fetch(`${BASE}/api/auth/password`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) {
        setPasswordError(data.error ?? t.passwordChangeFailed);
        return;
      }
      setPasswordSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch {
      setPasswordError(t.networkError);
    } finally {
      setPasswordLoading(false);
    }
  };

  return (
    <>
      <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              {t.changePassword}
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <span className="block">
                Changing your password will immediately sign out <strong>all other active sessions</strong> (other tabs and devices). This session will remain active.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={submitPasswordChange}>
              {t.passwordChanged}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="space-y-8 animate-in fade-in duration-500 max-w-2xl">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">{t.settings}</h1>
          <p className="text-muted-foreground mt-1 font-mono text-sm">{t.platformConfig}</p>
        </div>

        {/* ── Concurrency ── */}
          <Card className="border-border shadow-sm">
            <CardHeader className="bg-muted/20 border-b border-border pb-4">
              <CardTitle className="text-base flex items-center gap-2">
                <Cpu className="h-4 w-4 text-primary" /> {t.concurrencyControl}
              </CardTitle>
              <CardDescription className="text-xs mt-1">{t.concurrencyCardHint}</CardDescription>
            </CardHeader>
            <CardContent className="pt-6">
              <ConcurrencySection />
            </CardContent>
          </Card>

          {/* ── Browser Backend ──
              Everything about the backend (engine, endpoint, stealth, ad-blocking,
              HTTPS errors, session timeout, resolution) is configured per provider on
              the Providers page, including which one is the default. This section used
              to duplicate all of it in a second, competing place. */}
        <Card className="border-border shadow-sm">
          <CardHeader className="bg-muted/20 border-b border-border pb-4">
            <CardTitle className="text-base flex items-center gap-2">
              <Globe className="h-4 w-4 text-primary" /> {t.browserSettings}
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              {t.backendMovedToProviders}
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-6">
            <Link href="/providers">
              <Button variant="outline" size="sm" className="gap-2">
                <Server className="h-4 w-4" />{t.goToProvidersPage}
              </Button>
            </Link>
          </CardContent>
        </Card>

        {/* ── Task Timeout ── */}
        <Card className="border-border shadow-sm">
          <CardHeader className="bg-muted/20 border-b border-border pb-4">
            <CardTitle className="text-base flex items-center gap-2">
              <Timer className="h-4 w-4 text-primary" /> {t.taskTimeout}
            </CardTitle>
            <CardDescription className="text-xs mt-1">{t.taskTimeoutCardHint}</CardDescription>
          </CardHeader>
          <CardContent className="pt-6">
            <TaskTimeoutSection />
          </CardContent>
        </Card>

        {/* ── Captcha ── */}
        <Card className="border-border shadow-sm">
          <CardHeader className="bg-muted/20 border-b border-border pb-4">
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" /> {t.captchaSettings}
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              Configure a captcha solving service. When a task encounters a captcha, the solver
              is called automatically. If disabled, tasks that hit a captcha will pause and log
              a screenshot for manual review.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-6">
            <CaptchaSection />
          </CardContent>
        </Card>

        {/* ── Log level ── */}
        <Card className="border-border shadow-sm">
          <CardHeader className="bg-muted/20 border-b border-border pb-4">
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="h-4 w-4 text-primary" /> {t.logLevelTitle}
            </CardTitle>
            <CardDescription className="text-xs mt-1">{t.logLevelCardHint}</CardDescription>
          </CardHeader>
          <CardContent className="pt-6">
            <LogLevelSection />
          </CardContent>
        </Card>

        {/* ── Live Polling Interval ── */}
        <Card className="border-border shadow-sm">
          <CardHeader className="bg-muted/20 border-b border-border pb-4">
            <CardTitle className="text-base flex items-center gap-2">
              <RefreshCw className="h-4 w-4 text-primary" /> Live Polling Interval
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              How often the dashboard and task detail page refresh while a task is running.
              Polling pauses automatically when no tasks are active.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-6 space-y-3">
            {POLLING_OPTIONS.map((ms) => (
              <button
                key={ms}
                onClick={() => handleSelect(ms)}
                className={`w-full flex items-center justify-between p-4 rounded-md border text-left transition-all duration-150 ${
                  pollingInterval === ms
                    ? "border-primary bg-primary/5 text-foreground"
                    : "border-border bg-card hover:bg-accent/40 text-muted-foreground hover:text-foreground"
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className={`h-3 w-3 rounded-full border-2 flex-shrink-0 ${
                    pollingInterval === ms
                      ? "border-primary bg-primary"
                      : "border-muted-foreground"
                  }`} />
                  <span className="font-mono font-semibold text-sm">{ms / 1000}s</span>
                </div>
                <span className="text-xs font-mono">{INTERVAL_LABELS[ms]}</span>
              </button>
            ))}
          </CardContent>
        </Card>

        {/* ── Change Password ── */}
        <Card className="border-border shadow-sm">
          <CardHeader className="bg-muted/20 border-b border-border pb-4">
            <CardTitle className="text-base flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-primary" /> Change Password
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              Update your dashboard login password. The new password will take effect immediately.
              Other active sessions will be signed out; this tab stays logged in.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-6">
            {passwordSuccess ? (
              <div className="flex items-center gap-3 rounded-md border border-green-200 bg-green-50 px-4 py-3 text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200">
                <CheckCircle2 className="h-5 w-5 flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium">Password changed successfully</p>
                  <p className="text-xs mt-0.5 opacity-80">You are still logged in. Other active sessions have been signed out.</p>
                </div>
              </div>
            ) : (
              <form onSubmit={handlePasswordSubmit} className="space-y-4 max-w-sm">
                <div className="space-y-2">
                  <Label htmlFor="currentPassword">Current Password</Label>
                  <Input
                    id="currentPassword"
                    type="password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="Enter current password"
                    disabled={passwordLoading}
                    required
                    autoComplete="current-password"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="newPassword">New Password</Label>
                  <Input
                    id="newPassword"
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Min. 8 characters"
                    disabled={passwordLoading}
                    required
                    autoComplete="new-password"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="confirmPassword">Confirm New Password</Label>
                  <Input
                    id="confirmPassword"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter new password"
                    disabled={passwordLoading}
                    required
                    autoComplete="new-password"
                  />
                </div>

                {passwordError && (
                  <p className="text-sm text-destructive">{passwordError}</p>
                )}

                <Button
                  type="submit"
                  disabled={passwordLoading || !currentPassword || !newPassword || !confirmPassword}
                >
                  {passwordLoading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Updating…
                    </>
                  ) : (
                    "Update password"
                  )}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>

        {/* ── Retention / Cleanup ── */}
          <Card className="border-border shadow-sm">
            <CardHeader className="bg-muted/20 border-b border-border pb-4">
              <CardTitle className="text-base flex items-center gap-2">
                <Archive className="h-4 w-4 text-primary" /> Data Retention
              </CardTitle>
              <CardDescription className="text-xs mt-1">
                How long logs and screenshots are kept. Cleanup runs automatically at 03:30 each night.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-4">
              <RetentionSection />
            </CardContent>
          </Card>

          {/* ── About / System Info ── */}
        <Card className="border-border shadow-sm">
          <CardHeader className="bg-muted/20 border-b border-border pb-4">
            <CardTitle className="text-base flex items-center gap-2">
              <Info className="h-4 w-4 text-primary" /> {t.aboutSystem}
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              Runtime environment details for this Errand instance.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-4">
            <AboutSection />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
