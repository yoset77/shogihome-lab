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
  /** Text + opener target: the QR payload when present, else the PC URL. */
  displayedUrl: string;
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
    bind: info.bind ?? "0.0.0.0",
    autoOrigins: info.autoOrigins ?? true,
    hasQr: !!qrUrl,
    qrUrl,
    openDisabled: !info.allowed,
  };
}

/**
 * Display state for a failed refresh: everything is cleared so no stale
 * URL stays actionable and no stale QR stays scannable.
 */
export function clearedPcUrlDisplay(): PcUrlDisplay {
  return {
    displayedUrl: "",
    bind: "0.0.0.0",
    autoOrigins: true,
    hasQr: false,
    qrUrl: null,
    openDisabled: true,
  };
}
