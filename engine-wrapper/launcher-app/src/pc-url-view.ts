// Pure mapping from the `get_pc_url` payload to dashboard display state.
// Kept side-effect free so the URL/QR/stale-clearing rules are unit
// tested; `dashboard.ts` only applies the result to the DOM.

export interface PcUrlInfo {
  url: string;
  allowed: boolean;
  qrUrl: string | null | undefined;
  bind?: string;
  autoOrigins?: boolean;
}

export interface PcUrlDisplay {
  /** Text target: the QR payload when present, else the PC URL. */
  displayedUrl: string;
  /**
   * Opener target for this PC: the PC URL (loopback-first when available,
   * so the browser prefers a secure context over the LAN URL). In strict
   * or proxy setups it can be a LAN or proxy origin instead.
   */
  openUrl: string;
  bind: string;
  autoOrigins: boolean;
  hasQr: boolean;
  qrUrl: string | null;
  openDisabled: boolean;
}

/** Map a successful `get_pc_url` payload to display state. */
export function resolvePcUrlDisplay(info: PcUrlInfo): PcUrlDisplay {
  const qrUrl = info.qrUrl ?? null;
  return {
    displayedUrl: qrUrl ?? info.url,
    openUrl: info.url,
    bind: info.bind ?? "0.0.0.0",
    autoOrigins: info.autoOrigins ?? true,
    hasQr: !!qrUrl,
    qrUrl,
    openDisabled: !info.allowed,
  };
}

/**
 * Whether the displayed URL text is actionable. Mirrors the DOM wiring in
 * `dashboard.ts`: no handler or pointer cursor when the PC URL is not
 * allowed or no open target exists (e.g. cleared state).
 */
export function isPcUrlClickable(display: Pick<PcUrlDisplay, "openUrl" | "openDisabled">): boolean {
  return !display.openDisabled && display.openUrl !== "";
}

/**
 * Pick the URL to open in this PC's browser. The cached open target wins
 * when present; otherwise a freshly fetched payload is used only when it
 * is allowed and carries a URL. Returns null when there is nothing safe
 * to open (e.g. cleared state or disallowed strict origins).
 */
export function selectPcOpenTarget(
  cachedOpenUrl: string,
  fresh: Pick<PcUrlInfo, "url" | "allowed"> | null,
): string | null {
  if (cachedOpenUrl) return cachedOpenUrl;
  if (fresh && fresh.allowed && fresh.url) return fresh.url;
  return null;
}

/**
 * Display state for a failed refresh: everything is cleared so no stale
 * URL stays actionable and no stale QR stays scannable.
 */
export function clearedPcUrlDisplay(): PcUrlDisplay {
  return {
    displayedUrl: "",
    openUrl: "",
    bind: "0.0.0.0",
    autoOrigins: true,
    hasQr: false,
    qrUrl: null,
    openDisabled: true,
  };
}
