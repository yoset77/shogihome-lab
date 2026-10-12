import { JobAttachment } from "@/server/jobs/attachment";
import { GameSession } from "@/server/game/session";
import { gameRequest } from "./helpers/game";
import type { JobAttachRequest, JobBinding } from "@/common/jobs/types";

describe.each(["analysis", "game"] as const)("%s control contract", (kind) => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function control() {
    if (kind === "analysis") {
      const attachment = new JobAttachment();
      return {
        claim: (request: JobAttachRequest) => attachment.claim(request),
        status: () => attachment.status(),
      };
    }
    const request = gameRequest();
    request.settings.black = request.settings.white = { uri: "lan-engine:test", name: "AI" };
    const session = new GameSession("session", request);
    return {
      claim: (request: JobAttachRequest): JobBinding & { screenId: string } => {
        const snapshot = session.attach(request);
        return {
          ownerId: snapshot.controllerOwnerId!,
          epoch: snapshot.controllerEpoch,
          recoveryId: snapshot.controllerRecoveryId,
          screenId: request.screenId,
        };
      },
      status: () => session.attachment(),
    };
  }

  it("rejects a live copied screen and incorrect recovery credentials", () => {
    const state = control();
    const first = state.claim({ ownerId: "owner", epoch: 0, screenId: "first", takeover: false });
    expect(() => state.claim({ ...first, screenId: "copy", takeover: false })).toThrow(
      expect.objectContaining({ status: 423 }),
    );
    expect(() => state.claim({ ...first, recoveryId: "wrong", takeover: false })).toThrow(
      expect.objectContaining({ status: 409 }),
    );
  });

  it("renews a recovered screen's lease and fences its predecessor", async () => {
    const state = control();
    const first = state.claim({ ownerId: "owner", epoch: 0, screenId: "first", takeover: false });
    await vi.advanceTimersByTimeAsync(30_001);
    const recovered = state.claim({ ...first, screenId: "second", takeover: false });
    expect(recovered.epoch).toBeGreaterThan(first.epoch);
    expect(state.status().attached).toBe(true);
    expect(() => state.claim({ ...first, takeover: false })).toThrow();
    expect(state.claim({ ...recovered, takeover: false }).epoch).toBe(recovered.epoch);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(() => state.claim({ ...first, takeover: false })).toThrow();
    expect(state.status().epoch).toBe(recovered.epoch);
  });
  it("only accepts a token-free retry from the original acquiring screen", () => {
    const state = control();
    const request = { ownerId: "owner", epoch: 0, screenId: "first", takeover: false };
    const first = state.claim(request);
    expect(state.claim(request).epoch).toBe(first.epoch);
    expect(() => state.claim({ ...request, epoch: first.epoch })).toThrow();
    expect(() => state.claim({ ...request, screenId: "copy" })).toThrow();
  });
});
