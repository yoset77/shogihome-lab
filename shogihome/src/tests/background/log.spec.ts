import { getTailCommand, tailLogFile } from "@/server/log.js";
import { LogType } from "@/common/log.js";

describe("log", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("getTailCommand", () => {
    it("win", () => {
      vi.stubGlobal("process", { platform: "win32" });
      expect(getTailCommand(LogType.APP)).match(
        /^Get-Content -Path ".*app-.*\.log" -Wait -Tail 10$/,
      );
    });

    it("darwin", () => {
      vi.stubGlobal("process", { platform: "darwin" });
      expect(getTailCommand(LogType.APP)).match(/^tail -f ".*app-.*\.log"$/);
    });
  });

  describe("tailLogFile", () => {
    it("is a no-op in server mode", () => {
      vi.stubGlobal("process", { platform: "win32" });
      expect(() => tailLogFile(LogType.APP)).not.toThrow();
      vi.stubGlobal("process", { platform: "darwin" });
      expect(() => tailLogFile(LogType.APP)).not.toThrow();
    });
  });
});
