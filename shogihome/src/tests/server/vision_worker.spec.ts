import { describe, expect, it } from "vitest";
import { VisionWorkerClient } from "@/server/vision/worker";

describe("VisionWorkerClient", () => {
  it("rejects pending requests when the worker returns an unknown id", async () => {
    const client = new VisionWorkerClient();
    client.resolveConfig = () => ({
      command: process.execPath,
      args: ["src/tests/server/helpers/mock_vision_unknown_id_cli.mjs"],
    });

    await expect(
      client.scan({
        type: "scan",
        imagePath: "unused.png",
        sideToMove: "black",
        maxCandidates: 1,
      }),
    ).rejects.toThrow("unknown response id");
  });
});
