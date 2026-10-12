// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importKIF, Record, SpecialMoveType } from "tsshogi";
import { GameSession } from "@/server/game/session";
import { getHistory } from "@/server/file/history";
import { HistoryClass } from "@/common/file/history";
import { fakeGamePlayer, gameRequest } from "./helpers/game";

const config = vi.hoisted(() => ({ directory: "" }));
vi.mock("@/node/proc/path", () => ({ getUserDataPath: () => config.directory }));

describe("completed game history", () => {
  beforeEach(async () => {
    config.directory = await fs.mkdtemp(path.join(os.tmpdir(), "game-history-"));
  });
  afterEach(async () => {
    if (config.directory) await fs.rm(config.directory, { recursive: true, force: true });
    config.directory = "";
  });

  it("keeps only the latest twenty backups from detached repetitions, without losing branches or comments", async () => {
    const source = Record.newByUSI("position startpos moves 7g7f 3c3d") as Record;
    source.goto(0);
    source.first.comment = "Original comment";
    const request = gameRequest(source);
    request.settings.startPosition = "current";
    request.settings.repeat = 21;
    request.settings.black = request.settings.white = { uri: "lan-engine:test", name: "AI" };
    const fake = fakeGamePlayer();
    vi.mocked(fake.player.startSearch).mockImplementation(async (_p, _u, _t, handler) =>
      handler.onResign(),
    );
    const session = new GameSession("history", request, { playerBuilder: fake.builder });
    session.start();
    try {
      await session.completion;
      expect(session.snapshot().results.total).toBe(21);
      expect(session.snapshot().error).toBeUndefined();
      const entries = (await getHistory()).entries;
      expect(entries).toHaveLength(20);
      for (const [index, entry] of entries.entries()) {
        if (entry.class !== HistoryClass.BACKUP_V2) throw new Error("Missing backup");
        expect(entry.title).toContain(`${index + 2}/21`);
        const record = importKIF(entry.kif) as Record;
        expect(record.first.comment.trim()).toBe("Original comment");
        const moves: string[] = [];
        record.forEach((node) => {
          moves.push(
            typeof node.move === "object" && "usi" in node.move ? node.move.usi : node.move.type,
          );
        });
        expect(moves).toEqual(expect.arrayContaining(["7g7f", "3c3d", SpecialMoveType.RESIGN]));
      }
      expect((await fs.readdir(config.directory)).sort()).toEqual(["record_file_history.json"]);
    } finally {
      await session.close();
    }
  });

  it("notifies failures when the history file cannot be published, without adding another archive", async () => {
    await fs.mkdir(path.join(config.directory, "record_file_history.json"));
    const request = gameRequest();
    request.settings.black = request.settings.white = { uri: "lan-engine:test", name: "AI" };
    const fake = fakeGamePlayer();
    vi.mocked(fake.player.startSearch).mockImplementation(async (_p, _u, _t, handler) =>
      handler.onResign(),
    );
    const session = new GameSession("failure", request, { playerBuilder: fake.builder });
    session.start();
    try {
      await session.completion;
      expect(session.snapshot()).toMatchObject({ state: "completed", error: "save" });
      expect((await fs.readdir(config.directory)).sort()).toEqual(["record_file_history.json"]);
    } finally {
      await session.close();
    }
  });
});
