import {
  decodeClientRelayMessage,
  decodeServerRelayMessage,
  encodeClientRelayMessage,
  encodeEngineListRelayMessage,
  encodeSessionRelayMessage,
  type ClientRelayMessage,
  type SessionRelayPayload,
} from "@/common/engine/relay_protocol";

describe("engine relay protocol", () => {
  describe("server messages", () => {
    it.each([
      [
        { state: "ready", engineId: "engine-1", delay: 3 },
        { type: "state", state: "ready", engineId: "engine-1", delay: 3 },
      ],
      [
        { state: "uninitialized", engineId: null },
        { type: "state", state: "uninitialized", engineId: null },
      ],
      [
        { sfen: "position startpos", info: "bestmove 7g7f", delay: 4 },
        {
          type: "engineOutput",
          positionCommand: "position startpos",
          output: "bestmove 7g7f",
          delay: 4,
        },
      ],
      [
        { sfen: null, info: "usiok", delay: 0 },
        { type: "engineOutput", positionCommand: null, output: "usiok", delay: 0 },
      ],
      [
        { info: "pong", delay: 1 },
        { type: "notice", notice: "pong", delay: 1 },
      ],
      [
        { info: "info: engine is ready", delay: 2 },
        { type: "notice", notice: "engineReady", delay: 2 },
      ],
      [
        { info: "info: engine stopped", delay: 2 },
        { type: "notice", notice: "engineStopped", delay: 2 },
      ],
      [
        { error: "error: failed", delay: 5 },
        { type: "error", message: "error: failed", delay: 5 },
      ],
      [
        {
          engineList: [{ id: "engine-1", name: "Engine 1", type: ["game", "research", "mate"] }],
        },
        {
          type: "engineList",
          engines: [{ id: "engine-1", name: "Engine 1", type: ["game", "research", "mate"] }],
        },
      ],
    ])("decodes a valid frame", (wireMessage, expected) => {
      expect(decodeServerRelayMessage(JSON.stringify(wireMessage))).toEqual({
        ok: true,
        value: expected,
      });
    });

    it("accepts unknown extra properties", () => {
      expect(
        decodeServerRelayMessage(
          JSON.stringify({ state: "thinking", engineId: "engine-1", delay: 0, future: true }),
        ),
      ).toEqual({
        ok: true,
        value: { type: "state", state: "thinking", engineId: "engine-1", delay: 0 },
      });
    });

    it.each([
      ["non-string data", { state: "ready", engineId: "engine-1" }],
      ["invalid JSON", "{"],
      ["primitive JSON", "null"],
      ["array JSON", "[]"],
      ["unknown shape", JSON.stringify({ future: true })],
      ["ambiguous shape", JSON.stringify({ state: "ready", engineId: "engine-1", error: "x" })],
      ["unknown state", JSON.stringify({ state: "future", engineId: "engine-1" })],
      ["missing engineId", JSON.stringify({ state: "ready" })],
      ["invalid engineId", JSON.stringify({ state: "ready", engineId: 1 })],
      ["empty engineId", JSON.stringify({ state: "ready", engineId: "" })],
      ["malformed engineId", JSON.stringify({ state: "ready", engineId: "engine id" })],
      ["invalid output sfen", JSON.stringify({ sfen: 1, info: "bestmove 7g7f" })],
      ["unknown notice", JSON.stringify({ info: "future notice" })],
      ["prototype constructor notice", JSON.stringify({ info: "constructor" })],
      ["prototype toString notice", JSON.stringify({ info: "toString" })],
      ["prototype __proto__ notice", JSON.stringify({ info: "__proto__" })],
      ["negative delay", JSON.stringify({ error: "error: failed", delay: -1 })],
      ["non-finite delay", JSON.stringify({ error: "error: failed", delay: "NaN" })],
      [
        "invalid engine type",
        JSON.stringify({ engineList: [{ id: "engine-1", name: "Engine", type: ["invalid"] }] }),
      ],
      [
        "invalid list engine id",
        JSON.stringify({ engineList: [{ id: "engine id", name: "Engine" }] }),
      ],
    ])("rejects %s", (_name, input) => {
      expect(decodeServerRelayMessage(input)).toMatchObject({ ok: false });
    });

    it.each<[{ payload: SessionRelayPayload; delay: number }, string]>([
      [
        { payload: { type: "state", state: "ready", engineId: "engine-1" }, delay: 3 },
        '{"state":"ready","engineId":"engine-1","delay":3}',
      ],
      [
        {
          payload: {
            type: "engineOutput",
            positionCommand: "position startpos",
            output: "bestmove 7g7f",
          },
          delay: 4,
        },
        '{"sfen":"position startpos","info":"bestmove 7g7f","delay":4}',
      ],
      [{ payload: { type: "notice", notice: "pong" }, delay: 1 }, '{"info":"pong","delay":1}'],
      [
        { payload: { type: "error", message: "error: failed" }, delay: 2 },
        '{"error":"error: failed","delay":2}',
      ],
    ])("preserves the session wire format", ({ payload, delay }, expected) => {
      expect(encodeSessionRelayMessage(payload, delay)).toBe(expected);
    });

    it("preserves the engine-list wire format without delay or discriminator", () => {
      expect(
        encodeEngineListRelayMessage([
          { id: "engine-1", name: "Engine 1", type: ["game", "research"] },
        ]),
      ).toBe('{"engineList":[{"id":"engine-1","name":"Engine 1","type":["game","research"]}]}');
    });
  });

  describe("client messages", () => {
    it.each<[string, ClientRelayMessage]>([
      ["ping", { type: "ping" }],
      ["get_engine_list", { type: "getEngineList" }],
      ["start_engine engine-1", { type: "startEngine", engineId: "engine-1" }],
      ["stop_engine", { type: "stopEngine" }],
      ["usinewgame", { type: "usi", command: "usinewgame" }],
      ["position startpos moves 7g7f", { type: "usi", command: "position startpos moves 7g7f" }],
      [
        "go btime 1000 wtime 1000 byoyomi 500",
        { type: "usi", command: "go btime 1000 wtime 1000 byoyomi 500" },
      ],
      ["go mate infinite", { type: "usi", command: "go mate infinite" }],
      [
        "setoption name MultiPV value 3",
        { type: "usi", command: "setoption name MultiPV value 3" },
      ],
      ["gameover draw", { type: "usi", command: "gameover draw" }],
      ["stop", { type: "usi", command: "stop" }],
    ])("decodes and re-encodes %s", (wireMessage, expected) => {
      const result = decodeClientRelayMessage(`  ${wireMessage}  `);
      expect(result).toEqual({ ok: true, value: expected });
      if (result.ok) {
        expect(encodeClientRelayMessage(result.value)).toBe(wireMessage);
      }
    });

    it("preserves start-engine whitespace compatibility", () => {
      expect(decodeClientRelayMessage("start_engine    engine-1")).toEqual({
        ok: true,
        value: { type: "startEngine", engineId: "engine-1" },
      });
    });

    it.each([{ type: "future" }, Object.create({ type: "stopEngine" }) as object])(
      "rejects runtime-invalid messages when encoding",
      (message) => {
        expect(() => encodeClientRelayMessage(message as ClientRelayMessage)).toThrow(
          "invalid client relay message",
        );
      },
    );

    it.each([
      "",
      "unknown",
      "ping\nstop_engine",
      "start_engine engine id",
      "setoption name USI_Hash value 1024",
      "setoption name MultiPV",
      "go nodes 1000",
      "gameover invalid",
      "position invalid",
    ])("rejects invalid command %j", (command) => {
      expect(decodeClientRelayMessage(command)).toMatchObject({ ok: false });
    });
  });
});
