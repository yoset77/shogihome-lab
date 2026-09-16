// Generation guard for async PC URL / QR refreshes. A slow older
// `getPcUrl` + QR render must never overwrite a newer one (rapid restarts,
// `launcher-status` racing a manual refresh, language switches).
export class PcUrlSession {
  private seq = 0;

  /** Begin a new refresh generation; the caller renders only if current. */
  next(): number {
    this.seq += 1;
    return this.seq;
  }

  /** True when `id` is the latest generation. */
  isCurrent(id: number): boolean {
    return id === this.seq;
  }
}
