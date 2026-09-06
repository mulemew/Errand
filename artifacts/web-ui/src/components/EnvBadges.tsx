import { FaWindows, FaApple, FaLinux, FaAndroid } from "react-icons/fa";
import type { IconType } from "react-icons";

/**
 * The two badges that say what environment something runs in: which OS the fingerprint
 * claims, and where its traffic comes out.
 *
 * Shared because a task and a fingerprint browser are the same kind of thing here — an
 * environment made of a fingerprint and a proxy — and they should be recognisable by the
 * same two marks in either list.
 */

export type ExitGeo = {
  direct?: boolean;
  ok?: boolean;
  exitIp?: string;
  country?: string;
  countryCode?: string;
  city?: string;
  region?: string;
};

/** Fingerprint OS → brand logo. Unknown falls back to Linux, which is the default. */
export function osMeta(os?: string | null): { Icon: IconType; label: string } {
  const v = (os ?? "").toLowerCase();
  if (v.includes("win")) return { Icon: FaWindows, label: "Windows" };
  if (v.includes("mac") || v.includes("darwin") || v.includes("apple") || v.includes("ios") || v.includes("iphone"))
    return { Icon: FaApple, label: "macOS / iOS" };
  if (v.includes("android")) return { Icon: FaAndroid, label: "Android" };
  return { Icon: FaLinux, label: v ? "Linux" : "Linux (default)" };
}

/**
 * Country flag for a cached exit-IP geolocation. Never queries anything on render.
 *
 * An <img> from flagcdn rather than a flag emoji: Windows browsers do not render
 * regional-indicator pairs and show the two letters instead.
 */
export function ExitFlag({
  geo,
  label,
  className = "flex items-center border-l border-border pl-3",
}: {
  geo?: ExitGeo | null;
  label?: string | null;
  className?: string;
}) {
  const cc = geo?.countryCode?.toLowerCase();
  if (!geo?.ok || !cc || cc.length !== 2) return null;
  const loc = [geo.city, geo.region, geo.country].filter(Boolean).join(", ");
  // With a saved proxy profile the profile NAME is more use than the raw IP and city.
  const tip = label
    ? label
    : `${geo.direct ? "Host exit IP" : "Proxy exit IP"}: ${geo.exitIp ?? ""}${loc ? " · " + loc : ""}`;
  return (
    <span className={className} title={tip}>
      <img
        src={`https://flagcdn.com/20x15/${cc}.png`}
        srcSet={`https://flagcdn.com/40x30/${cc}.png 2x`}
        width={20}
        height={15}
        alt={geo.countryCode}
        loading="lazy"
        className="rounded-[1px]"
      />
    </span>
  );
}
