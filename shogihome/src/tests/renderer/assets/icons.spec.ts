import { access } from "node:fs/promises";
import { iconSourceMap } from "@/renderer/assets/icons";

describe("assets/icons", () => {
  describe("checkIconFilePaths", () => {
    Object.values(iconSourceMap).forEach((source) => {
      it(`shouldExists:${source}`, async () => {
        await expect(access(`public/${source}`)).resolves.toBeUndefined();
      });
    });
  });
});
