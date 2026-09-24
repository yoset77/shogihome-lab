import {
  decodeClientRelayMessage,
  decodeServerRelayMessage,
  encodeClientRelayMessage,
  encodeSessionRelayMessage,
} from "@/common/engine/relay_protocol";

describe("identified searches", () => {
  it("round trips an atomic search and cancellation barrier", () => {
    for (const message of [
      {
        type: "search" as const,
        instanceId: "instance-1",
        searchId: 1,
        position: "position startpos",
        go: "go btime 1000 wtime 1000",
      },
      { type: "cancelSearch" as const, instanceId: "instance-1", through: 1 },
    ]) {
      expect(decodeClientRelayMessage(encodeClientRelayMessage(message))).toEqual({
        ok: true,
        value: message,
      });
    }
  });

  it("rejects malformed identifiers and command injection", () => {
    const search = {
      type: "search",
      instanceId: "instance-1",
      searchId: 1,
      position: "position startpos",
      go: "go infinite",
    };
    for (const patch of [
      { searchId: 0 },
      { searchId: 1.5 },
      { instanceId: "" },
      { position: "go infinite" },
      { go: "stop" },
      { go: "go infinite\nquit" },
    ]) {
      expect(decodeClientRelayMessage(JSON.stringify({ ...search, ...patch })).ok).toBe(false);
    }
  });

  it("preserves search identity on delayed output", () => {
    const output = {
      type: "engineOutput" as const,
      instanceId: "instance-1",
      searchId: 7,
      positionCommand: "position startpos",
      output: "bestmove 7g7f",
    };
    expect(decodeServerRelayMessage(encodeSessionRelayMessage(output, 50))).toEqual({
      ok: true,
      value: { ...output, delay: 50 },
    });
  });
});
