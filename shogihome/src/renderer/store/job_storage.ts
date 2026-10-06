import { holdJobTab, releaseJobTab } from "./job_tab_guard";

type Reference = {
  requestId: string;
  serverInstanceId: string;
  ownerId?: string;
  controllerId?: string;
  controllerEpoch?: number;
  binding?: { epoch: number };
};

export class JobStorage<T extends Reference> {
  private readonly sessionKey: string;
  private readonly journalPrefix: string;
  constructor(
    private readonly kind: "analysis" | "game",
    private readonly legacyKey: string,
    private readonly decode: (raw: string | null) => T | undefined,
    private readonly projectJournal: (ref: T) => T = (ref) => ref,
    private readonly operations: (ref: T) => Array<{ id: string; reference: T }> = (ref) => [
      { id: "creation", reference: ref },
    ],
  ) {
    this.sessionKey = `shogihome-job-attachment:${kind}`;
    this.journalPrefix = `shogihome-job-journal:${kind}:`;
  }
  private key(ref: Reference): string {
    return `${this.journalPrefix}${ref.serverInstanceId}:${ref.requestId}:${ref.ownerId ?? ref.controllerId ?? "legacy"}`;
  }
  migrate(): void {
    for (const key of Object.keys(localStorage).filter(
      (key) => key === this.legacyKey || key.startsWith(`${this.legacyKey}:`),
    )) {
      const ref = this.decode(localStorage.getItem(key));
      if (!ref) continue;
      for (const operation of this.operations(this.projectJournal(ref))) {
        const target = `${this.key(ref)}:${operation.id}`;
        if (!localStorage.getItem(target))
          localStorage.setItem(target, JSON.stringify(operation.reference));
      }
      localStorage.removeItem(key);
    }
  }
  load(): T | undefined {
    return this.decode(sessionStorage.getItem(this.sessionKey));
  }
  save(ref: T): void {
    sessionStorage.setItem(this.sessionKey, JSON.stringify(ref));
    holdJobTab(this.kind, ref);
  }
  detach(ref: Reference): void {
    const current = this.decode(sessionStorage.getItem(this.sessionKey));
    if (
      current &&
      this.key(current) === this.key(ref) &&
      (current.controllerEpoch ?? current.binding?.epoch ?? 0) <=
        (ref.controllerEpoch ?? ref.binding?.epoch ?? 0)
    ) {
      sessionStorage.removeItem(this.sessionKey);
      releaseJobTab(this.kind);
    }
  }
  writeJournal(ref: T): void {
    for (const operation of this.operations(this.projectJournal(ref))) {
      localStorage.setItem(`${this.key(ref)}:${operation.id}`, JSON.stringify(operation.reference));
    }
  }
  forgetOperation(ref: Reference, id: string): void {
    localStorage.removeItem(`${this.key(ref)}:${id}`);
  }
  forgetJournal(ref: Reference): void {
    const prefix = this.key(ref);
    for (const key of Object.keys(localStorage).filter(
      (key) => key === prefix || key.startsWith(`${prefix}:`),
    ))
      localStorage.removeItem(key);
  }
  journal(): T[] {
    this.migrate();
    return Object.keys(localStorage)
      .filter((key) => key.startsWith(this.journalPrefix))
      .map((key) => this.decode(localStorage.getItem(key)))
      .filter((ref): ref is T => !!ref);
  }
}

export function isReloadNavigation(): boolean {
  const navigation = performance.getEntriesByType?.("navigation")[0] as
    PerformanceNavigationTiming | undefined;
  return navigation?.type === "reload" || navigation?.type === "back_forward";
}
