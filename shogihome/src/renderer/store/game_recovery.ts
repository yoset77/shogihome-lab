import { counter, identifier, object } from "@/common/analysis/validation";

export type GameRecoveryReference = {
  requestId: string;
  serverInstanceId: string;
  controllerId: string;
  sessionId?: string;
  recoveryId?: string;
  connectionId?: string;
  controllerEpoch?: number;
  controllerGeneration?: number;
};

const PREFIX = "shogihome-game-recovery:";

function decode(raw: string | null): GameRecoveryReference | undefined {
  try {
    if (!raw) return;
    const input = object(JSON.parse(raw));
    if (input.version !== 1) return;
    return {
      requestId: identifier(input.requestId),
      serverInstanceId: identifier(input.serverInstanceId),
      controllerId: identifier(input.controllerId),
      ...(input.sessionId === undefined ? {} : { sessionId: identifier(input.sessionId) }),
      ...(input.recoveryId === undefined ? {} : { recoveryId: identifier(input.recoveryId) }),
      ...(input.connectionId === undefined ? {} : { connectionId: identifier(input.connectionId) }),
      ...(input.controllerEpoch === undefined
        ? {}
        : { controllerEpoch: counter(input.controllerEpoch) }),
      ...(input.controllerGeneration === undefined
        ? {}
        : { controllerGeneration: counter(input.controllerGeneration) }),
    };
  } catch {
    return;
  }
}

function newer(a: GameRecoveryReference, b: GameRecoveryReference): boolean {
  const generation = (a.controllerGeneration ?? 0) - (b.controllerGeneration ?? 0);
  return (
    generation > 0 || (generation === 0 && (a.controllerEpoch ?? 0) > (b.controllerEpoch ?? 0))
  );
}

// Durable discovery is separate from tab attachment intent and unconfirmed operations.
export class GameRecoveryStorage {
  private key(ref: GameRecoveryReference): string {
    return `${PREFIX}${ref.serverInstanceId}:${ref.requestId}:${ref.controllerId}`;
  }

  list(): GameRecoveryReference[] {
    return Object.keys(localStorage)
      .filter((key) => key.startsWith(PREFIX))
      .map((key) => decode(localStorage.getItem(key)))
      .filter((ref): ref is GameRecoveryReference => !!ref);
  }

  get(ref: GameRecoveryReference): GameRecoveryReference | undefined {
    return decode(localStorage.getItem(this.key(ref)));
  }

  save(ref: GameRecoveryReference): void {
    const current = this.get(ref);
    if (current && newer(current, ref)) return;
    localStorage.setItem(
      this.key(ref),
      JSON.stringify({
        version: 1,
        requestId: ref.requestId,
        serverInstanceId: ref.serverInstanceId,
        controllerId: ref.controllerId,
        sessionId: ref.sessionId,
        recoveryId: ref.recoveryId,
        connectionId: ref.connectionId,
        controllerEpoch: ref.controllerEpoch,
        controllerGeneration: ref.controllerGeneration,
      }),
    );
  }

  forget(ref: GameRecoveryReference): void {
    const current = this.get(ref);
    if (current && !newer(current, ref)) localStorage.removeItem(this.key(ref));
  }
}
