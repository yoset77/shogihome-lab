import { randomUUID } from "node:crypto";
import type { SessionRelayPayload } from "@/common/engine/relay_protocol";
import { EngineSession } from "./session";
import { EngineState, type EngineConfig } from "./types";
import { ENGINE_STOP_TIMEOUT_MS } from "@/server/config";

export interface ResearchSearch {
  readonly finished: Promise<void>;
  stop(): Promise<void>;
  cancel(): Promise<void>;
}

export interface ResearchEngine {
  launch(config: EngineConfig, timeoutSeconds: number, signal: AbortSignal): Promise<void>;
  setMultiPV(value: number): void;
  readyNewGame(): void;
  startResearch(
    position: string,
    onOutput: (line: string) => void,
    signal: AbortSignal,
  ): Promise<ResearchSearch>;
  close(): Promise<void>;
}

export interface GameEngine extends ResearchEngine {
  startSearch(
    position: string,
    go: string,
    onOutput: (line: string) => void,
    signal: AbortSignal,
  ): Promise<ResearchSearch>;
  cancelAll(): Promise<void>;
  gameover(result: string): void;
}

export class InternalEngine implements ResearchEngine {
  private session = new EngineSession(`internal-${randomUUID()}`, undefined, "internal");
  private nextSearchId = 0;
  private closing?: Promise<void>;

  private wait(predicate: () => boolean, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {};
      const finish = (error?: Error) => {
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(new Error("Engine operation cancelled"));
      const check = (event?: SessionRelayPayload) => {
        if (predicate()) finish();
        else if (event?.type === "error") finish(new Error(event.message));
        else if (this.session.internalSnapshot.state === EngineState.STOPPED)
          finish(new Error("Engine closed unexpectedly"));
      };
      const timer = setTimeout(() => finish(new Error("Engine operation timed out")), timeoutMs);
      unsubscribe = this.session.subscribeInternal(check);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else check();
    });
  }

  async launch(config: EngineConfig, timeoutSeconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error("Engine operation cancelled");
    this.session.startInternalEngine(config);
    await this.wait(
      () => this.session.internalSnapshot.state === EngineState.READY,
      timeoutSeconds * 1000,
      signal,
    );
  }

  setMultiPV(value: number): void {
    this.session.dispatchInternal({
      type: "usi",
      command: `setoption name MultiPV value ${value}`,
    });
  }

  readyNewGame(): void {
    this.session.dispatchInternal({ type: "usi", command: "usinewgame" });
  }

  async startResearch(
    position: string,
    onOutput: (line: string) => void,
    signal: AbortSignal,
  ): Promise<ResearchSearch> {
    return this.startSearch(position, "go infinite", onOutput, signal);
  }

  async startSearch(
    position: string,
    go: string,
    onOutput: (line: string) => void,
    signal: AbortSignal,
  ): Promise<ResearchSearch> {
    if (signal.aborted) throw new Error("Engine operation cancelled");
    const searchId = ++this.nextSearchId;
    const instanceId = this.session.internalSnapshot.instanceId;
    const unsubscribe = this.session.subscribeInternal((event) => {
      if (
        event.type === "engineOutput" &&
        event.instanceId === instanceId &&
        event.searchId === searchId &&
        this.session.internalSnapshot.cancelled < searchId &&
        !signal.aborted
      )
        onOutput(event.output);
    });
    this.session.dispatchInternal({
      type: "search",
      instanceId,
      searchId,
      position,
      go,
    });
    const finished = this.wait(
      () =>
        this.session.internalSnapshot.instanceId === instanceId &&
        (this.session.internalSnapshot.terminal?.searchId === searchId ||
          (this.session.internalSnapshot.cancelled >= searchId &&
            this.session.internalSnapshot.settled >= searchId)),
      24 * 60 * 60 * 1000,
    );
    // The owner may still be waiting for the search to start when the engine fails.
    void finished.catch(() => {});
    try {
      await this.wait(
        () =>
          this.session.internalSnapshot.active === searchId ||
          this.session.internalSnapshot.terminal?.searchId === searchId,
        ENGINE_STOP_TIMEOUT_MS + 1000,
        signal,
      );
    } catch (error) {
      unsubscribe();
      throw error;
    }
    const stop = async (cancel: boolean) => {
      if (cancel)
        this.session.dispatchInternal({ type: "cancelSearch", instanceId, through: searchId });
      else this.session.dispatchInternal({ type: "stopSearch", instanceId, searchId });
      await this.wait(
        () =>
          cancel
            ? this.session.internalSnapshot.settled >= searchId
            : this.session.internalSnapshot.terminal?.searchId === searchId,
        ENGINE_STOP_TIMEOUT_MS + 1000,
      );
    };
    const completion = finished.finally(unsubscribe);
    void completion.catch(() => {});
    return { finished: completion, stop: () => stop(false), cancel: () => stop(true) };
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.session.dispatchInternal({ type: "stopEngine" });
      try {
        await this.wait(
          () =>
            [EngineState.STOPPED, EngineState.UNINITIALIZED].includes(
              this.session.internalSnapshot.state,
            ),
          ENGINE_STOP_TIMEOUT_MS,
        );
      } finally {
        this.session.destroyInternal();
      }
    })();
    return this.closing;
  }

  gameover(result: string): void {
    this.session.dispatchInternal({ type: "usi", command: `gameover ${result}` });
  }

  async cancelAll(): Promise<void> {
    const through = this.nextSearchId;
    if (!through) return;
    const instanceId = this.session.internalSnapshot.instanceId;
    this.session.dispatchInternal({ type: "cancelSearch", instanceId, through });
    await this.wait(
      () => this.session.internalSnapshot.settled >= through,
      ENGINE_STOP_TIMEOUT_MS + 1000,
    );
  }
}
