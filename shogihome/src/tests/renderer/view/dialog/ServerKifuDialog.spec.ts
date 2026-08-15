import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  getServerKifuBoardControlScale,
  getServerKifuBoardMaxSize,
} from "@/renderer/view/dialog/ServerKifuDialog.vue";

describe("ServerKifuDialog", () => {
  it("sizes the desktop search board within the available viewport", () => {
    expect(getServerKifuBoardMaxSize(1280, 720, false)).toMatchObject({ width: 500, height: 500 });
    expect(getServerKifuBoardMaxSize(1920, 1080, false)).toMatchObject({
      width: 594,
      height: 594,
    });
    expect(getServerKifuBoardMaxSize(2560, 1440, false)).toMatchObject({
      width: 720,
      height: 720,
    });
  });

  it("keeps the mobile board width-based", () => {
    expect(getServerKifuBoardMaxSize(500, 800, true)).toMatchObject({ width: 450, height: 450 });
  });

  it("scales search board controls with the desktop board", () => {
    expect(getServerKifuBoardControlScale(500, false)).toBe(1);
    expect(getServerKifuBoardControlScale(720, false)).toBe(1.35);
    expect(getServerKifuBoardControlScale(1000, false)).toBe(1.35);
  });

  it("keeps search board controls at the mobile size", () => {
    expect(getServerKifuBoardControlScale(539, true)).toBe(1);
  });

  it("renders the search board edit overlay within the dialog layer", () => {
    const source = readFileSync("src/renderer/view/dialog/ServerKifuDialog.vue", "utf-8");

    expect(source).toContain(':ghost-teleport-target="ghostTeleportTarget"');
    expect(source).toContain('dialogFrame.value?.dialog ?? "body"');
  });

  it("opens SFEN conversion settings in a dedicated dialog", () => {
    const source = readFileSync("src/renderer/view/dialog/ServerKifuDialog.vue", "utf-8");

    expect(source).toContain("<SfenExportDialog");
    expect(source).not.toContain('class="sfen-export-panel');
  });

  it("adds a sente/gote swap button that is enabled only for strict turn searches", () => {
    const source = readFileSync("src/renderer/view/dialog/ServerKifuDialog.vue", "utf-8");

    expect(source).toContain('@click="swapPlayers"');
    expect(source).toContain(':disabled="!isStrictTurn"');
    expect(source).toContain("[player1.value, player2.value] = [player2.value, player1.value]");
  });

  it("provides a closed strategy filter without exposing inference scores", () => {
    const source = readFileSync("src/renderer/view/dialog/ServerKifuDialog.vue", "utf-8");

    expect(source).toContain('v-model="searchStrategy"');
    expect(source).toContain(':allow-free-text="false"');
    expect(source).toContain("getStrategyName(entry.strategy)");
    expect(source).toContain("t.automaticallyInferredStrategy");
    expect(source).not.toContain("strategy_score");
  });
});
