// @vitest-environment node
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import path from "node:path";
import { WebSocket } from "ws";
import { EngineSession } from "@/server/engine/session";
import { EngineState, type EngineConfig, type EngineHandle } from "@/server/engine/types";
import { CONNECTION_PROTECTION_TIMEOUT } from "@/server/config";
import { initDatabase, closeDatabase, getAnalysisResults } from "@/server/database/sqlite";
import { getNormalizedSfenAndHash } from "@/server/usi/sfen";
import { getTempPathForTesting } from "@/tests/helpers/temp";

describe("engine shutdown with the analysis database", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    closeDatabase();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each(["explicit", "protection timeout"])(
    "persists the final result before transport closure on %s shutdown",
    (reason) => {
      const dataDir = path.join(getTempPathForTesting(), reason);
      initDatabase(dataDir);
      const position = getNormalizedSfenAndHash("position startpos")!;
      const results = () => getAnalysisResults(position.hash, position.sfen);
      const ws = Object.assign(new EventEmitter(), {
        readyState: WebSocket.OPEN as number,
        send: vi.fn(),
        terminate: vi.fn(),
      });
      const session = new EngineSession("database-shutdown");
      const internal = session as unknown as {
        engineState: EngineState;
        currentEngineId: string;
        currentEngineConfig: EngineConfig;
        engineHandle: EngineHandle;
        setupEngineHandlers(stream: PassThrough): void;
        onEngineClose(): void;
      };
      internal.engineState = EngineState.READY;
      internal.currentEngineId = "test";
      internal.currentEngineConfig = { id: "test", name: "Test" };
      const close = vi.fn(() => {
        expect(results()).toEqual([
          expect.objectContaining({ depth: 101, score_cp: 20, pv: "7g7f 3c3d" }),
        ]);
        internal.onEngineClose();
      });
      internal.engineHandle = {
        write: vi.fn(),
        close,
        destroy: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        removeAllListeners: vi.fn(),
      };
      const output = new PassThrough();
      internal.setupEngineHandlers(output);
      session.attach(ws as unknown as WebSocket);
      ws.emit("message", "position startpos");
      ws.emit("message", "go infinite");
      output.write("info depth 100 score cp 10 pv 7g7f\n");
      if (reason === "explicit") ws.emit("message", "stop_engine");
      ws.readyState = WebSocket.CLOSED;
      ws.emit("close");
      if (reason === "protection timeout") vi.advanceTimersByTime(CONNECTION_PROTECTION_TIMEOUT);
      expect(close).not.toHaveBeenCalled();
      expect(results()).toEqual([]);

      output.write("info depth 101 score cp 20 pv 7g7f 3c3d\nbestmove 7g7f\n");
      expect(close).toHaveBeenCalledOnce();
      expect(session.internalSnapshot.state).toBe(EngineState.STOPPED);
      expect(vi.getTimerCount()).toBe(0);

      closeDatabase();
      initDatabase(dataDir);
      expect(results()).toEqual([
        expect.objectContaining({ depth: 101, score_cp: 20, pv: "7g7f 3c3d" }),
      ]);
    },
  );
});
