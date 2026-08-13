import { useEffect, useMemo, useState } from "react";
import { Link, useRoute, useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  ArrowLeft,
  Save,
  Plus,
  Crosshair,
  X,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  StepEditor,
  type WorkflowStep,
  type SavedCredentialOption,
  type ConditionType,
  type ThenActionType,
  type ConditionalAction,
} from "@/components/StepEditor";

import {
  useCreateTask,
  useUpdateTask,
  useGetTask,
  getGetTaskQueryKey,
  getListTasksQueryKey,
  getGetTasksSummaryQueryKey,
} from "@workspace/api-client-react";
import { useLang } from "@/contexts/lang-context";
import type { Translations } from "@/i18n/translations";
import type { WorkflowStep as ApiWorkflowStep } from "@workspace/api-client-react";

const thenActionSchema = z
  .object({
    type: z.enum([
      "click",
      "fill",
      "navigate",
      "wait",
      "keypress",
      "screenshot",
      "scroll",
      "continue",
      "exitSuccess",
      "exitFailure",
    ]),
    selector: z.string().optional(),
    selectorType: z.enum(["text", "css", "xpath"]).optional(),
    url: z.string().optional(),
    value: z.string().optional(),
    ms: z.number().optional(),
    key: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    message: z.string().optional(),
  })
  .optional();

const stepSchema = z.object({
  type: z.enum([
    "navigate",
    "click",
    "fill",
    "wait",
    "waitFor",
    "screenshot",
    "scroll",
    "hover",
    "keypress",
    "select",
    "switchToNewPage",
    "login",
    "condition",
    "dismissPopups",
    "cfVerify",
  ]),
  url: z.string().optional(),
  selector: z.string().optional(),
  selectorType: z.enum(["text", "css", "xpath"]).optional(),
  value: z.string().optional(),
  ms: z.number().optional(),
  timeout: z.number().optional(),
  key: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  loginMethod: z.enum(["form", "github", "google", "cookie"]).optional(),
  loginUrl: z.string().optional(),
  credentialId: z.number().optional(),
  credentialSource: z.enum(["saved", "inline"]).optional(),
  inlineUsername: z.string().optional(),
  inlinePassword: z.string().optional(),
  inlineTotp: z.string().optional(),
  successSelector: z.string().optional(),
  successText: z.string().optional(),
  cookieMode: z.boolean().optional(),
  sessionKey: z.string().optional(),
  cookies: z.string().optional(),
  conditionType: z
    .enum([
      "text_contains",
      "text_not_contains",
      "element_visible",
      "element_not_visible",
      "element_clickable",
      "element_not_clickable",
      "url_contains",
    ])
    .optional(),
  conditionValue: z.string().optional(),
  conditionSelector: z.string().optional(),
  maxReloads: z.number().optional(),
  thenAction: thenActionSchema,
  elseAction: thenActionSchema,
});

/**
 * Built with `t` rather than at module level: zod bakes its messages in at schema
 * construction, so a module-level schema would freeze one language's validation text for
 * the life of the tab and show Chinese errors in English mode.
 */
const makeFormSchema = (t: Translations) => z.object({
  name: z.string().min(1, t.taskNameRequired),
  targetUrl: z.string().url(t.enterValidUrl).min(1, t.targetUrlRequired),
  cronExpression: z.string().optional(),
  // Kept as strings so the inputs can be cleared while editing; parsed on submit.
  retryCount: z.string().optional(),
  retryIntervalMinutes: z.string().optional(),
  steps: z.array(stepSchema).default([]),
});

type FormValues = z.infer<ReturnType<typeof makeFormSchema>>;

type BrowserProvider = "playwright" | "puppeteer" | "seleniumbase" | "camoufox";

type ProxyType =
  | "http"
  | "socks5"
  | "warp"
  | "vless"
  | "vmess"
  | "trojan"
  | "hy2"
  | "tuic"
  | "ss";

interface BrowserConfigState {
  proxyUrl: string;
  proxyType: ProxyType;
  /** WARP only — how many fresh WARP identities (exit IPs) to try when reCAPTCHA blocks the audio challenge. */
  warpRotations: string;
  headed: boolean;
  stealth: boolean;
  blockAds: boolean;
  ignoreHTTPS: boolean;
  sessionTimeoutMs: string;
  // Fingerprint spoofing (cf-proxy / SeleniumBase only)
  fpOs: "" | "windows" | "mac";
  fpTimezone: string;
  fpLocale: string;
  fpAutoGeo: boolean;
  // Named provider (Providers page) — the ONLY way to pick a backend. null means "use the
  // provider flagged as default on that page"; the backend is never configured inline.
  providerId: number | null;
  // Saved profiles (override the inline fingerprint/proxy above when set)
  fingerprintProfileId: number | null;
  proxyProfileId: number | null;
  // Unified dropdown selection (single source of truth for the UI):
  //   proxySel: "none" | "custom" | "warp" | "<profileId>"
  //   fpSel:    "none" | "custom" | "<profileId>"
  proxySel: string;
  fpSel: string;
}

/** URL-safe random token for the webhook's Authorization header. */
/** Random webhook token — Web Crypto only; this is an auth secret. */
function genWebhookToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const defaultBrowserConfig: BrowserConfigState = {
  proxyUrl: "",
  proxyType: "http",
  warpRotations: "",
  headed: false,
  stealth: false,
  blockAds: false,
  ignoreHTTPS: false,
  sessionTimeoutMs: "",
  fpOs: "",
  fpTimezone: "",
  fpLocale: "",
  fpAutoGeo: true,
  providerId: null,
  fingerprintProfileId: null,
  proxyProfileId: null,
  proxySel: "none",
  fpSel: "none",
};

/** Infer the proxyType from a manual proxy URL's scheme (the node-type dropdown was
 *  removed — the scheme in the URL already says what it is). Mirrors the api-server. */
function inferProxyType(url: string): ProxyType {
  const scheme = (url.split("://")[0] || "").toLowerCase();
  const norm =
    scheme === "socks5h" ? "socks5" : scheme === "https" ? "http" : scheme === "hysteria2" ? "hy2" : scheme;
  const allowed: ProxyType[] = ["http", "socks5", "vless", "vmess", "trojan", "hy2", "tuic", "ss"];
  return (allowed.includes(norm as ProxyType) ? norm : "http") as ProxyType;
}

const PROVIDER_LABELS: Record<BrowserProvider, string> = {
  playwright: "Playwright",
  puppeteer: "Puppeteer",
  seleniumbase: "SeleniumBase (CF Bypass)",
  camoufox: "Camoufox (anti-detect Firefox)",
};

/**
 * A small numeric field for one unit of a duration (day / hour / minute).
 * Fixes the old input's UX bugs: it accepts an empty value while editing,
 * supports pasting/replacing without a sticky leading "1", and only clamps
 * to a valid number on blur.
 */
function DurationField({
  label,
  value,
  onChange,
  max = 999,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  max?: number;
}) {
  return (
    <div className="flex items-center gap-1">
      <input
        type="number"
        inputMode="numeric"
        min={0}
        max={max}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => {
          const raw = e.target.value.trim();
          if (raw === "") {
            onChange("0");
            return;
          }
          const n = parseInt(raw, 10);
          onChange(String(isNaN(n) ? 0 : Math.min(max, Math.max(0, n))));
        }}
        className="w-16 h-9 rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring font-mono"
      />
      <span className="text-sm text-muted-foreground">{label}</span>
    </div>
  );
}

export default function TaskForm() {
  const { t } = useLang();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [matchEdit, paramsEdit] = useRoute("/tasks/:id/edit");
  const isEditMode = matchEdit && paramsEdit?.id !== undefined;
  const taskId = isEditMode ? parseInt(paramsEdit.id, 10) : undefined;

  const { data: task, isLoading: isLoadingTask } = useGetTask(
    taskId as number,
    {
      query: {
        enabled: isEditMode && !!taskId,
        queryKey: getGetTaskQueryKey(taskId as number),
      },
    },
  );

  const [savedCredentials, setSavedCredentials] = useState<
    Array<{ id: number; name: string; username: string }>
  >([]);
  const [webhookEnabled, setWebhookEnabled] = useState(false);
  const [webhookToken, setWebhookToken] = useState("");
  const [browserConfig, setBrowserConfig] =
    useState<BrowserConfigState>(defaultBrowserConfig);
  const [browserConfigExpanded, setBrowserConfigExpanded] = useState(false);
  const [fingerprintProfiles, setFingerprintProfiles] = useState<
    Array<{ id: number; name: string; os: string; config?: { fp?: string; preset?: unknown } | null }>
  >([]);
  const [proxyProfiles, setProxyProfiles] = useState<Array<{ id: number; name: string }>>([]);
  const [providers, setProviders] = useState<
    Array<{ id: number; name: string; type: string; concurrency: number; enabled: boolean; isDefault?: boolean; healthy: boolean | null }>
  >([]);

  // Providers + fingerprint profiles gate the dropdowns below, so track when they have
  // actually arrived: before that "this backend can't use fingerprints" is just ignorance,
  // and acting on it would wipe a saved selection while the page is still loading.
  const [refsLoaded, setRefsLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/saved-credentials")
      .then((r) => r.json())
      .then(setSavedCredentials)
      .catch(() => {});
    fetch("/api/proxy-profiles").then((r) => r.json()).then(setProxyProfiles).catch(() => {});
    Promise.all([
      fetch("/api/fingerprint-profiles").then((r) => r.json()).then(setFingerprintProfiles),
      fetch("/api/providers").then((r) => r.json()).then(setProviders),
    ])
      .catch(() => {})
      .finally(() => setRefsLoaded(true));
  }, []);

  // ── Which backend this task actually runs on ─────────────────────────────────
  // The engine is ONLY ever a provider now (the Settings browser-backend section is gone):
  // either the one picked here, or the provider flagged as default on the Providers page.
  // Its TYPE decides which options below even apply.
  const defaultProvider = providers.find((p) => p.isDefault && p.enabled) ?? null;
  const activeProvider =
    browserConfig.providerId != null
      ? (providers.find((p) => p.id === browserConfig.providerId) ?? null)
      : defaultProvider;
  const activeProviderType = activeProvider?.type ?? null;
  /** A profile carrying a browserforge pickle / real-device preset — camoufox reproduces
   *  those at engine level; cf-proxy (sb) has no way to apply them. */
  const isGeneratedFp = (p: { config?: { fp?: string; preset?: unknown } | null }) =>
    !!(p.config?.fp || (p.config?.preset !== undefined && p.config?.preset !== null));
  // camoufox = every profile; seleniumbase = only the plain os/timezone/locale ones;
  // playwright/puppeteer = no fingerprint support at all (section hidden).
  const supportsFingerprint = activeProviderType === "camoufox" || activeProviderType === "seleniumbase";
  const selectableFingerprints =
    activeProviderType === "camoufox" ? fingerprintProfiles : fingerprintProfiles.filter((p) => !isGeneratedFp(p));

  // Switching to a backend that can't use the currently selected fingerprint must not
  // silently save an unusable combination — drop back to "不使用".
  useEffect(() => {
    const sel = browserConfig.fpSel;
    if (!refsLoaded || sel === "none") return;
    // "custom" is no longer offered: an existing task that was saved with a hand-typed
    // OS/timezone spoof falls back to "不使用" here rather than showing a blank dropdown.
    if (!supportsFingerprint || !selectableFingerprints.some((p) => String(p.id) === sel)) {
      setBrowserConfig((s) => ({ ...s, fpSel: "none", fingerprintProfileId: null }));
    }
  }, [refsLoaded, activeProviderType, supportsFingerprint, selectableFingerprints, browserConfig.fpSel]);

  const createTask = useCreateTask();
  const updateTask = useUpdateTask();

  const formSchema = useMemo(() => makeFormSchema(t), [t]);
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      targetUrl: "",
      cronExpression: "",
      retryCount: "",
      retryIntervalMinutes: "",
      steps: [],
    },
  });

  const targetUrl = form.watch("targetUrl");
  const steps = form.watch("steps");
  const [importedCount, setImportedCount] = useState<number | null>(null);
  const [scheduleType, setScheduleType] = useState<
    "none" | "cron" | "random" | "after_completion"
  >("none");
  // Delay-after-completion, expressed as a free combination of days / hours /
  // minutes. Stored as raw strings so the inputs can be cleared, pasted into,
  // and edited freely (no forced "1" on every keystroke). Clamped only when the
  // cron value is built in onSubmit.
  const [acDays, setAcDays] = useState("0");
  const [acHours, setAcHours] = useState("0");
  const [acMinutes, setAcMinutes] = useState("60");
  // Random-interval window, also a free d/h/m combination.
  const [rwDays, setRwDays] = useState("1");
  const [rwHours, setRwHours] = useState("0");
  const [rwMinutes, setRwMinutes] = useState("0");
  const [randomCount, setRandomCount] = useState("1");

  // Load steps recorded by the Step Recorder (only in create mode)
  useEffect(() => {
    if (isEditMode) return;
    const stored = sessionStorage.getItem("recorder_steps");
    if (!stored) return;
    sessionStorage.removeItem("recorder_steps");
    try {
      const parsed = JSON.parse(stored) as WorkflowStep[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        form.setValue("steps", parsed as never, { shouldDirty: true });
        setImportedCount(parsed.length);
      }
    } catch {}
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isEditMode && task) {
      const cron = task.cronExpression || "";
      const splitDHM = (totalMinutes: number) => ({
        d: Math.floor(totalMinutes / 1440),
        h: Math.floor((totalMinutes % 1440) / 60),
        m: totalMinutes % 60,
      });
      if (cron.startsWith("@random:")) {
        const parts = cron.split(":");
        setScheduleType("random");
        const windowMinutes = parseInt(parts[1] ?? "1440", 10) || 1440;
        const { d, h, m } = splitDHM(windowMinutes);
        setRwDays(String(d));
        setRwHours(String(h));
        setRwMinutes(String(m));
        setRandomCount(parts[2] ?? "1");
      } else if (cron.startsWith("@after_completion:")) {
        setScheduleType("after_completion");
        const total = parseInt(cron.split(":")[1] ?? "60", 10) || 60;
        const { d, h, m } = splitDHM(total);
        setAcDays(String(d));
        setAcHours(String(h));
        setAcMinutes(String(m));
      } else if (cron) {
        setScheduleType("cron");
      } else {
        setScheduleType("none");
      }
      form.reset({
        name: task.name,
        targetUrl: task.targetUrl,
        cronExpression: cron.startsWith("@random:") ? "" : cron,
        retryCount: task.retryCount != null ? String(task.retryCount) : "",
        retryIntervalMinutes:
          task.retryIntervalMinutes != null ? String(task.retryIntervalMinutes) : "",
        steps: (task.steps as WorkflowStep[] | null | undefined) ?? [],
      });
      setWebhookEnabled(task.webhookEnabled === true);
      setWebhookToken(task.webhookToken ?? "");

      // Load browserConfig from task
      const bc = task.browserConfig as
        | Record<string, unknown>
        | null
        | undefined;
      if (bc && typeof bc === "object") {
        setBrowserConfig({
          proxyUrl: (bc.proxyUrl as string) || "",
          proxyType: (bc.proxyType as ProxyType) || "http",
          warpRotations:
            bc.warpRotations === null || bc.warpRotations === undefined ? "" : String(bc.warpRotations),
          headed: (bc.headed as boolean) || false,
          stealth: (bc.stealth as boolean) || false,
          blockAds: (bc.blockAds as boolean) || false,
          ignoreHTTPS: (bc.ignoreHTTPS as boolean) || false,
          sessionTimeoutMs: bc.sessionTimeoutMs
            ? String(bc.sessionTimeoutMs)
            : "",
          fpOs: ((bc.fingerprint as Record<string, unknown> | undefined)?.os as
            | ""
            | "windows"
            | "mac") || "",
          fpTimezone:
            ((bc.fingerprint as Record<string, unknown> | undefined)?.timezone as string) || "",
          fpLocale:
            ((bc.fingerprint as Record<string, unknown> | undefined)?.locale as string) || "",
          fpAutoGeo:
            ((bc.fingerprint as Record<string, unknown> | undefined)?.autoGeo as boolean) ?? true,
          providerId: (bc.providerId as number | null) ?? null,
          fingerprintProfileId: (bc.fingerprintProfileId as number | null) ?? null,
          proxyProfileId: (bc.proxyProfileId as number | null) ?? null,
          // Derive the unified dropdown selection from the stored config so existing
          // tasks round-trip: saved profile → its id; warp → "warp"; a manual proxy
          // URL → "custom"; likewise a manual fingerprint (fpOs set) → "custom".
          proxySel:
            bc.proxyProfileId != null
              ? String(bc.proxyProfileId)
              : bc.proxyType === "warp"
                ? "warp"
                : (bc.proxyUrl as string)
                  ? "custom"
                  : "none",
          fpSel:
            bc.fingerprintProfileId != null
              ? String(bc.fingerprintProfileId)
              : (bc.fingerprint as Record<string, unknown> | undefined)?.os
                ? "custom"
                : "none",
        });
        setBrowserConfigExpanded(true);
      }
    }
  }, [isEditMode, task, form]);

  const buildBrowserConfigPayload = () => {
    // ── Proxy: derive everything from the single dropdown selection ──────────────
    const psel = browserConfig.proxySel;
    let proxyProfileId: number | null = null;
    let proxyUrl: string | null = null;
    let proxyType: ProxyType | null = null;
    let warpRotations: number | null = null;
    if (psel === "custom") {
      const u = browserConfig.proxyUrl.trim();
      proxyUrl = u || null;
      proxyType = u ? inferProxyType(u) : null; // node-type inferred from the URL scheme
    } else if (psel === "warp") {
      proxyType = "warp";
      // WARP-only knob; blank means "use the RECAPTCHA_MAX_IP_ROTATIONS default".
      warpRotations = browserConfig.warpRotations.trim() !== "" ? Number(browserConfig.warpRotations) : null;
    } else if (psel !== "none") {
      proxyProfileId = Number(psel); // a saved proxy profile
    }

    // ── Fingerprint: profile id, manual fields, or nothing ──────────────────────
    const fsel = browserConfig.fpSel;
    let fingerprintProfileId: number | null = null;
    let fingerprint: Record<string, unknown> | null = null;
    if (fsel !== "none" && fsel !== "custom") {
      fingerprintProfileId = Number(fsel); // a saved fingerprint profile
    }

    return {
      // The backend engine comes from the chosen provider (or the default one). When
      // neither is known the key is omitted entirely so the server-side default applies
      // instead of pinning a stale engine on the task.
      ...(activeProviderType ? { provider: activeProviderType } : {}),
      providerId: browserConfig.providerId ?? null,
      fingerprintProfileId,
      proxyProfileId,
      proxyUrl,
      proxyType,
      warpRotations,
      // stealth / blockAds / ignoreHTTPS / sessionTimeoutMs now live on the Provider
      // (Providers page); not sent per-task anymore.
      fingerprint,
    };
  };

  const onSubmit = (values: FormValues) => {
    // 仅 Cookie 登录没有可回退的登录流程：会话检查就是整个步骤，而检查只认「登录成功文字 /
    // 选择器」。两个都空时运行期只会得到「cookie 无效」，所以在保存时就挡住。
    const badCookieStep = (values.steps as Array<Record<string, unknown>>).findIndex(
      (s) =>
        s.type === "login" &&
        s.loginMethod === "cookie" &&
        !String(s.successText ?? "").trim() &&
        !String(s.successSelector ?? "").trim(),
    );
    if (badCookieStep !== -1) {
      toast({
        title: t.cookieOnlyNoCriterionTitle,
        description: t.cookieOnlyNoCriterionDesc.replace("{n}", String(badCookieStep + 1)),
        variant: "destructive",
      });
      return;
    }

    const toMinutes = (d: string, h: string, m: string) =>
      (parseInt(d || "0", 10) || 0) * 1440 +
      (parseInt(h || "0", 10) || 0) * 60 +
      (parseInt(m || "0", 10) || 0);

    const randomWindowMinutes = Math.max(1, toMinutes(rwDays, rwHours, rwMinutes));
    const afterCompletionMinutes = Math.max(1, toMinutes(acDays, acHours, acMinutes));
    const randomCountN = Math.max(1, parseInt(randomCount || "1", 10) || 1);

    const cronValue =
      scheduleType === "random"
        ? `@random:${randomWindowMinutes}:${randomCountN}`
        : scheduleType === "after_completion"
          ? `@after_completion:${afterCompletionMinutes}`
          : scheduleType === "cron"
            ? values.cronExpression || null
            : null;
    // Blank / 0 / junk all mean "no auto-retry" — send null so the column is cleared.
    const _n = (s?: string): number | null => {
      const v = parseInt((s ?? "").trim(), 10);
      return Number.isFinite(v) && v > 0 ? v : null;
    };
    const retryCountValue = _n(values.retryCount);
    // Interval only matters when retries are on; default 5m if left blank.
    const retryIntervalValue = retryCountValue ? (_n(values.retryIntervalMinutes) ?? 5) : null;
    const stepsPayload =
      values.steps.length > 0 ? (values.steps as ApiWorkflowStep[]) : null;
    // Cast: browserConfig is jsonb (accepts any shape at runtime); the generated
    // api-client-react TaskBrowserConfig type lags the spec (no camoufox / profile ids
    // until its codegen is re-run in CI), so the payload is structurally wider here.
    const browserConfigPayload = buildBrowserConfigPayload() as unknown as Parameters<typeof createTask.mutate>[0]["data"]["browserConfig"];

    if (isEditMode && taskId) {
      updateTask.mutate(
        {
          id: taskId,
          data: {
            name: values.name,
            targetUrl: values.targetUrl,
            cronExpression: cronValue,
            retryCount: retryCountValue,
            retryIntervalMinutes: retryIntervalValue,
            webhookEnabled,
            // A token is required for the webhook to work at all; mint one rather
            // than persisting "enabled with no token" (which always 401s).
            webhookToken: webhookEnabled ? webhookToken || genWebhookToken() : null,
            steps: stepsPayload,
            browserConfig: browserConfigPayload,
          },
        },
        {
          onSuccess: () => {
            toast({
              title: t.taskUpdated,
              description: "The automation job has been updated.",
              variant: "success",
            });
            queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
            queryClient.invalidateQueries({
              queryKey: getGetTaskQueryKey(taskId),
            });
            setLocation(`/tasks/${taskId}`);
          },
          onError: (err) => {
            toast({
              title: t.failedToSave,
              description: err instanceof Error ? err.message : t.networkError,
              variant: "destructive",
            });
          },
        },
      );
    } else {
      createTask.mutate(
        {
          data: {
            name: values.name,
            targetUrl: values.targetUrl,
            cronExpression: cronValue,
            retryCount: retryCountValue,
            retryIntervalMinutes: retryIntervalValue,
            webhookEnabled,
            // A token is required for the webhook to work at all; mint one rather
            // than persisting "enabled with no token" (which always 401s).
            webhookToken: webhookEnabled ? webhookToken || genWebhookToken() : null,
            steps: stepsPayload,
            browserConfig: browserConfigPayload,
          },
        },
        {
          onSuccess: (newTask) => {
            toast({
              title: t.taskCreated,
              description: "The automation job has been configured.",
              variant: "success",
            });
            queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
            queryClient.invalidateQueries({
              queryKey: getGetTasksSummaryQueryKey(),
            });
            setLocation(`/tasks/${newTask.id}`);
          },
          onError: (err) => {
            toast({
              title: t.failedToSave,
              description: err instanceof Error ? err.message : "Unknown error",
              variant: "destructive",
            });
          },
        },
      );
    }
  };

  if (isEditMode && isLoadingTask) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-96 w-full max-w-2xl" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center gap-4">
        <Link href={isEditMode ? `/tasks/${taskId}` : "/"}>
          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {isEditMode ? "Edit Configuration" : "New Mission"}
          </h1>
          <p className="text-sm text-muted-foreground font-mono">
            {isEditMode
              ? `Task ID: ${taskId}`
              : "Setup a new headless browser automation job"}
          </p>
        </div>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          {/* General Settings */}
          <Card className="border-border shadow-sm">
            <CardHeader className="border-b border-border pb-4 bg-muted/20">
              <CardTitle className="text-base font-semibold">
                General Settings
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 pt-6">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t.taskName}</FormLabel>
                    <FormControl>
                      <Input
                        placeholder={t.taskNamePlaceholder}
                        {...field}
                        className="font-mono text-sm"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="targetUrl"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t.startingUrl}</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="https://example.com"
                          {...field}
                          className="font-mono text-sm"
                        />
                      </FormControl>
                      <FormDescription className="text-xs">
                        Used as the default login URL for Login steps
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {/* ── Schedule ─────────────────────────────────────────── */}
                <div className="space-y-3">
                  <div>
                    <p className="text-sm font-medium leading-none mb-2">
                      Schedule{" "}
                      <span className="text-muted-foreground font-normal">
                        (Optional)
                      </span>
                    </p>
                    <div className="flex gap-1 p-1 bg-muted rounded-md w-fit">
                      {(
                        ["none", "cron", "random", "after_completion"] as const
                      ).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => setScheduleType(mode)}
                          className={`px-3 py-1 text-xs rounded font-medium transition-colors ${scheduleType === mode ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                        >
                          {mode === "none"
                            ? t.noSchedule
                            : mode === "cron"
                              ? t.cronExpression
                              : mode === "random"
                                ? "Random interval"
                                : t.afterCompletion}
                        </button>
                      ))}
                    </div>
                  </div>

                  {scheduleType === "after_completion" && (
                    <div className="space-y-3">
                      <div className="space-y-1.5">
                        <p className="text-xs font-medium text-muted-foreground">
                          Delay after run finishes
                        </p>
                        <div className="flex items-center gap-2">
                          <DurationField label={t.unitDays} value={acDays} onChange={setAcDays} />
                          <DurationField label={t.unitHours} value={acHours} onChange={setAcHours} />
                          <DurationField label={t.unitMinutes} value={acMinutes} onChange={setAcMinutes} />
                        </div>
                        <p className="text-[11px] text-muted-foreground leading-snug">
                          Next run triggers automatically this long after the
                          previous run <strong>ends</strong> ({t.unitDays} / {t.unitHours} / {t.unitMinutes} can be
                          combined freely). Perfect when the target site has a
                          cooldown timer that starts after each operation.
                        </p>
                      </div>
                    </div>
                  )}

                  {scheduleType === "cron" && (
                    <FormField
                      control={form.control}
                      name="cronExpression"
                      render={({ field }) => (
                        <FormItem>
                          <FormControl>
                            <Input
                              placeholder="0 0 * * *"
                              {...field}
                              className="font-mono text-sm"
                            />
                          </FormControl>
                          <FormDescription className="text-xs font-mono">
                            e.g. 0 0 * * * (Daily at midnight) · 0 * * * *
                            (Hourly)
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  )}

                  {scheduleType === "random" && (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5 col-span-2">
                        <p className="text-xs font-medium text-muted-foreground">
                          {t.randomWindowLabel}
                        </p>
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-muted-foreground">{t.unitEvery}</span>
                          <DurationField label={t.unitDays} value={rwDays} onChange={setRwDays} />
                          <DurationField label={t.unitHours} value={rwHours} onChange={setRwHours} />
                          <DurationField label={t.unitMinutes} value={rwMinutes} onChange={setRwMinutes} />
                        </div>
                      </div>
                      <div className="space-y-1.5 col-span-2">
                        <p className="text-xs font-medium text-muted-foreground">
                          {t.runsPerWindowLabel}
                        </p>
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min={1}
                            max={100}
                            value={randomCount}
                            onChange={(e) => setRandomCount(e.target.value)}
                            onBlur={(e) =>
                              setRandomCount(
                                String(
                                  Math.min(
                                    100,
                                    Math.max(1, parseInt(e.target.value, 10) || 1),
                                  ),
                                ),
                              )
                            }
                            className="w-20 h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring font-mono"
                          />
                          <span className="text-sm text-muted-foreground">{t.unitTimes}</span>
                        </div>
                      </div>
                      <p className="col-span-2 text-xs text-muted-foreground leading-relaxed">
                        {t.randomScheduleHint.replace("{n}", String(randomCount))}
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {/* Failure auto-retry — independent of the schedule above. */}
              <div className="space-y-2 pt-4 mt-4 border-t border-border">
                <p className="text-sm font-medium">{t.retryOnFailure}</p>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm text-muted-foreground">{t.retryAfterFailure}</span>
                  <FormField
                    control={form.control}
                    name="retryCount"
                    render={({ field }) => (
                      <FormItem className="space-y-0">
                        <FormControl>
                          <Input
                            type="number"
                            min={0}
                            placeholder="0"
                            className="w-20 h-9 font-mono"
                            {...field}
                          />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                  <span className="text-sm text-muted-foreground">{t.retryTimesEvery}</span>
                  <FormField
                    control={form.control}
                    name="retryIntervalMinutes"
                    render={({ field }) => (
                      <FormItem className="space-y-0">
                        <FormControl>
                          <Input
                            type="number"
                            min={1}
                            placeholder="5"
                            className="w-20 h-9 font-mono"
                            {...field}
                          />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                  <span className="text-sm text-muted-foreground">{t.unitMinutes}</span>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {t.retryHint}
                </p>
              </div>

              {/* Webhook trigger — lets an external monitor fire this task. */}
              <div className="space-y-2 pt-4 mt-4 border-t border-border">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">{t.webhookTrigger}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {t.webhookIntro}
                    </p>
                  </div>
                  <Switch
                    checked={webhookEnabled}
                    onCheckedChange={(v) => {
                      setWebhookEnabled(v);
                      // A webhook with no token would be refused anyway — mint one on
                      // enable so it works immediately instead of silently 401-ing.
                      if (v && !webhookToken) setWebhookToken(genWebhookToken());
                    }}
                  />
                </div>
                {webhookEnabled && (
                  <div className="space-y-2 pt-1">
                    <div className="space-y-1">
                      <label className="block text-xs font-medium">{t.authorizationLabel}</label>
                      <div className="flex items-center gap-2">
                        <Input
                          className="font-mono text-xs h-9"
                          value={webhookToken}
                          onChange={(e) => setWebhookToken(e.target.value)}
                          placeholder={t.autoGeneratedPlaceholder}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-9 shrink-0"
                          onClick={() => setWebhookToken(genWebhookToken())}
                        >
                          {t.regenerate}
                        </Button>
                      </div>
                    </div>
                    <div className="rounded-md bg-muted/40 border border-border p-2.5 space-y-1">
                      <p className="text-[10px] text-muted-foreground">
                        {isEditMode ? t.webhookUseThisEdit : t.webhookUseThisNew}
                      </p>
                      <pre className="text-[10px] font-mono whitespace-pre-wrap break-all leading-relaxed">
{`POST ${typeof window !== "undefined" ? window.location.origin : ""}/api/tasks/${taskId ?? t.taskIdPlaceholder}/webhook
Authorization: Bearer ${webhookToken || "<token>"}`}
                      </pre>
                      <p className="text-[10px] text-muted-foreground leading-snug">
                        {t.webhookAuthHint}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* ── Browser Backend ─────────────────────────────────────────── */}
          <Card className="border-border shadow-sm">
            <CardHeader
              className="border-b border-border pb-4 bg-muted/20 cursor-pointer select-none"
              onClick={() => setBrowserConfigExpanded((v) => !v)}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <CardTitle className="text-base font-semibold">
                    {t.browserBackendSection}
                  </CardTitle>
                  {browserConfig.providerId != null ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                      {activeProvider?.name ?? `Provider #${browserConfig.providerId}`}
                      {activeProviderType ? ` · ${PROVIDER_LABELS[activeProviderType as BrowserProvider]}` : ""}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                      {t.defaultShort}{defaultProvider ? ` · ${defaultProvider.name}` : ""}
                    </span>
                  )}
                </div>
                {browserConfigExpanded ? (
                  <ChevronUp className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                )}
              </div>
              <CardDescription className="text-xs mt-1">
                {t.backendSectionHint}
              </CardDescription>
            </CardHeader>

            {browserConfigExpanded && (
              <CardContent className="space-y-5 pt-5">
                  <div className="space-y-4">
                    {/* Backend = a provider, always. Engine/URL/stealth/… all live on the
                        Providers page; "Default" follows whichever provider is flagged there. */}
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">{t.providerField}</label>
                      <Select
                        value={browserConfig.providerId != null ? String(browserConfig.providerId) : "default"}
                        onValueChange={(v) =>
                          setBrowserConfig((s) => {
                            if (v === "default") {
                              return { ...s, providerId: null };
                            }
                            // The engine follows the provider's own type — nothing about
                            // the backend is stored on the task any more.
                            return { ...s, providerId: Number(v) };
                          })
                        }
                      >
                        <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="default">
                            {defaultProvider
                              ? t.defaultProviderIs.replace("{name}", defaultProvider.name).replace("{type}", defaultProvider.type)
                              : t.defaultProviderUnset}
                          </SelectItem>
                          {providers.filter((p) => p.enabled || p.id === browserConfig.providerId).map((p) => (
                            <SelectItem key={p.id} value={String(p.id)}>
                              {t.providerOptionLine.replace("{name}", p.name).replace("{type}", p.type).replace("{n}", String(p.concurrency))}{!p.enabled ? ` (${t.disabledSuffix})` : p.healthy === false ? " ⚠" : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-[11px] text-muted-foreground">
                        {t.providerFieldHint}
                        {defaultProvider ? "" : ` ${t.noDefaultProviderYet}`}
                      </p>
                    </div>

                    {/* Proxy — one dropdown: none / saved profiles / WARP / custom URL.
                        Manual fields appear only after choosing Custom or rotating WARP. */}
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">{t.proxyLabel}</label>
                      <Select
                        value={browserConfig.proxySel}
                        onValueChange={(v) => setBrowserConfig((s) => ({ ...s, proxySel: v }))}
                      >
                        <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">{t.proxyNone}</SelectItem>
                          {proxyProfiles.map((p) => (
                            <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                          ))}
                          <SelectItem value="warp">{t.proxyWarpRotate}</SelectItem>
                          <SelectItem value="custom">{t.proxyCustom}</SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-[11px] text-muted-foreground">{t.proxySelectHint}</p>

                      {/* Custom proxy address — scheme in the URL determines the node type */}
                      {browserConfig.proxySel === "custom" && (
                        <div className="pt-1 space-y-1.5">
                          <Input
                            placeholder={t.proxyUrlPlaceholder}
                            value={browserConfig.proxyUrl}
                            onChange={(e) => setBrowserConfig((s) => ({ ...s, proxyUrl: e.target.value }))}
                            className="font-mono text-sm"
                          />
                          <p className="text-[11px] text-muted-foreground">
                            {t.proxyCustomHint}
                          </p>
                        </div>
                      )}

                      {/* WARP-only: how many exit IPs to try when reCAPTCHA blocks audio */}
                      {browserConfig.proxySel === "warp" && (
                        <div className="mt-1 rounded-lg border border-border bg-muted/30 px-4 py-3 space-y-1.5">
                          <label htmlFor="warpRotations" className="block text-sm font-medium">
                            {t.warpRotationsLabel}
                          </label>
                          <Input
                            id="warpRotations"
                            type="number"
                            min={0}
                            max={50}
                            placeholder={t.warpRotationsPlaceholder}
                            value={browserConfig.warpRotations}
                            onChange={(e) => setBrowserConfig((s) => ({ ...s, warpRotations: e.target.value }))}
                            className="font-mono text-sm"
                          />
                          <p className="text-[11px] text-muted-foreground">
                            {t.warpRotationsHint}
                          </p>
                        </div>
                      )}
                    </div>

                    {/* Fingerprint — saved profiles only. The old Custom option let you
                        hand-type an OS/timezone/locale spoof, which is the legacy cf-proxy
                        trick: it paints a Linux browser as Windows at the JS layer only, so
                        the halves disagree under any real check. Camoufox fingerprints are
                        engine-level and come from a saved profile; anything hand-typed here
                        would be strictly worse than either using a profile or using nothing.
                        Timezone/locale live on the profile too. */}
                    {supportsFingerprint && (
                      <div className="space-y-1.5">
                        <label className="text-sm font-medium">{t.fingerprintFieldLabel}</label>
                        <Select
                          value={browserConfig.fpSel}
                          onValueChange={(v) => setBrowserConfig((s) => ({ ...s, fpSel: v }))}
                        >
                          <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {/* "None" means two different things. On SeleniumBase it is the
                                container's real Chrome-on-Linux identity; on Camoufox the engine
                                mints a fresh consistent fingerprint per launch. Saying "real
                                fingerprint" for both was simply wrong for one of them. */}
                            <SelectItem value="none">
                              {activeProviderType === "camoufox" ? t.fingerprintNoneRandom : t.fingerprintNoneReal}
                            </SelectItem>
                            {selectableFingerprints.map((p) => (
                              <SelectItem key={p.id} value={String(p.id)}>{p.name}（{p.os}）</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-[11px] text-muted-foreground">
                          {activeProviderType === "camoufox"
                            ? t.fingerprintHintCamoufox
                            : t.fingerprintHintSb}
                        </p>
                      </div>
                    )}

                    {/* Engine / CDP endpoint / stealth / ad blocking / HTTPS errors / session timeout /
                        resolution all live on the Provider (Providers page) now. */}
                  </div>
              </CardContent>
            )}
          </Card>

          {/* Workflow Steps */}
          <Card className="border-border shadow-sm">
            <CardHeader className="border-b border-border pb-4 bg-muted/20">
              <CardTitle className="text-base font-semibold">
                Workflow Steps
              </CardTitle>
              <CardDescription className="text-xs">
                Chain actions: add a Login step to authenticate, then navigate,
                click, fill forms, and more.
                {steps.length > 0 && (
                  <span className="ml-2 font-mono text-primary">
                    {steps.length} step{steps.length !== 1 ? "s" : ""}
                  </span>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-5 space-y-4">
              {importedCount !== null && (
                <div className="flex items-center justify-between gap-3 rounded-md border border-primary/20 bg-primary/5 px-3 py-2.5 text-sm">
                  <div className="flex items-center gap-2 text-primary">
                    <Crosshair className="h-4 w-4 flex-shrink-0" />
                    <span>
                      <span className="font-semibold">
                        {importedCount} step{importedCount !== 1 ? "s" : ""}
                      </span>{" "}
                      imported from Step Recorder — review and adjust before
                      saving.
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setImportedCount(null)}
                    className="text-primary/60 hover:text-primary transition-colors"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              )}
              <StepEditor
                savedCredentials={savedCredentials}
                steps={steps as WorkflowStep[]}
                onChange={(newSteps) => form.setValue("steps", newSteps)}
                taskTargetUrl={targetUrl}
              />
            </CardContent>
          </Card>

          <div className="flex justify-end gap-4 pt-4 border-t border-border">
            <Link href={isEditMode ? `/tasks/${taskId}` : "/"}>
              <Button variant="ghost" type="button">
                Cancel
              </Button>
            </Link>
            <Button
              type="submit"
              disabled={createTask.isPending || updateTask.isPending}
              className="font-semibold px-8 shadow-sm"
            >
              {isEditMode ? (
                <>
                  <Save className="mr-2 h-4 w-4" /> {t.saveChanges}
                </>
              ) : (
                <>
                  <Plus className="mr-2 h-4 w-4" /> {t.createTaskAction}
                </>
              )}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
