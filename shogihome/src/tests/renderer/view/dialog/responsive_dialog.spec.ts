import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface ResponsiveDialogStyle {
  path: string;
  minWidth: number;
  maxWidth: number;
  maxHeight: number;
}

const styles: ResponsiveDialogStyle[] = [
  {
    path: "src/renderer/view/dialog/USIEngineMergeDialog.vue",
    minWidth: 600,
    maxWidth: 960,
    maxHeight: 800,
  },
  {
    path: "src/renderer/view/dialog/LoadRemoteFileDialog.vue",
    minWidth: 800,
    maxWidth: 1100,
    maxHeight: 800,
  },
  {
    path: "src/renderer/view/dialog/ServerKifuDialog.vue",
    minWidth: 640,
    maxWidth: 840,
    maxHeight: 750,
  },
  {
    path: "src/renderer/view/dialog/BookSelectDialog.vue",
    minWidth: 600,
    maxWidth: 900,
    maxHeight: 720,
  },
  {
    path: "src/renderer/view/dialog/RecordFileHistoryDialog.vue",
    minWidth: 800,
    maxWidth: 1100,
    maxHeight: 800,
  },
  {
    path: "src/renderer/view/dialog/AnalysisDBManagerDialog.vue",
    minWidth: 800,
    maxWidth: 1100,
    maxHeight: 800,
  },
  {
    path: "src/renderer/view/dialog/AddBookMovesDialog.vue",
    minWidth: 580,
    maxWidth: 800,
    maxHeight: 600,
  },
  {
    path: "src/renderer/view/dialog/AppSettingsDialog.vue",
    minWidth: 590,
    maxWidth: 800,
    maxHeight: 760,
  },
  {
    path: "src/renderer/view/dialog/VisionScanDialog.vue",
    minWidth: 600,
    maxWidth: 900,
    maxHeight: 840,
  },
];

describe("responsive desktop dialog styles", () => {
  it.each(styles)("keeps $path within the HD to WQHD sizing range", (style) => {
    const source = readFileSync(style.path, "utf-8");

    expect(source).toContain(`clamp(${style.minWidth}px`);
    expect(source).toContain(`${style.maxWidth}px`);
    expect(source).toContain(`${style.maxHeight}px`);
    expect(source).not.toMatch(/calc\(100vh - \d+px\)/);
  });

  it.each([
    "src/renderer/view/dialog/AppSettingsDialog.vue",
    "src/renderer/view/dialog/RecordFileHistoryDialog.vue",
    "src/renderer/view/dialog/USIEngineMergeDialog.vue",
  ])("includes border-box sizing for %s", (path) => {
    const source = readFileSync(path, "utf-8");

    expect(source).toContain("box-sizing: border-box");
  });

  it("preserves the App Settings mobile selector flow", () => {
    const source = readFileSync("src/renderer/view/dialog/AppSettingsDialog.vue", "utf-8");

    expect(source).toContain(`.settings .selector {
    width: auto;
    max-width: 400px;
  }`);
  });

  it("keeps the position editor toolbar aligned to common desktop pixel ratios", () => {
    const source = readFileSync("src/renderer/view/dialog/PositionEditingDialog.vue", "utf-8");

    expect(source).not.toContain("font-size: 13px");
  });

  it("sizes desktop position editors from 90% viewport height", () => {
    for (const path of [
      "src/renderer/view/dialog/PositionEditingDialog.vue",
      "src/renderer/view/dialog/VisionPositionEditDialog.vue",
    ]) {
      const source = readFileSync(path, "utf-8");

      expect(source).toContain("height: clamp(520px, 90dvh, 1400px)");
      expect(source).toContain("aspect-ratio: 4 / 3");
      expect(source).toContain("width: auto");
    }
  });

  it("keeps the Vision Scan content inside a limited dialog", () => {
    const source = readFileSync("src/renderer/view/dialog/VisionScanDialog.vue", "utf-8");

    expect(source).toContain("max-height: 100%");
    expect(source).toContain("box-sizing: border-box");
    expect(source).toContain("height: 100%");
  });

  it("preserves the previous Vision Scan mobile layout", () => {
    const source = readFileSync("src/renderer/view/dialog/VisionScanDialog.vue", "utf-8");

    expect(source).toContain("width: min(680px, calc(95vw - 30px))");
    expect(source).toContain("aspect-ratio: 4 / 3");
    expect(source).toContain("min-height: 220px");
    expect(source).toContain("box-sizing: content-box");
  });

  it("disables desktop sizing constraints for the Vision position editor on mobile", () => {
    const source = readFileSync("src/renderer/view/dialog/VisionPositionEditDialog.vue", "utf-8");

    expect(source).toContain("min-width: 0");
    expect(source).toContain("aspect-ratio: auto");
  });
});
