import { describe, expect, it, vi } from "vitest";
import request from "supertest";

const SERVER_PORT = vi.hoisted(() => {
  return 8300 + Math.floor(Math.random() * 100);
});

vi.hoisted(() => {
  process.env.PORT = SERVER_PORT.toString();
  process.env.KIFU_DIR = "./data";
  process.env.VISION_ENABLED = "false";
  process.env.VISION_MAX_IMAGE_MB = "1";
});

import { app } from "@/server/main";

describe("Vision scan API disabled", () => {
  it("rejects before reading the raw image body", async () => {
    const response = await request(app)
      .post("/api/vision/scan")
      .set("Host", `localhost:${SERVER_PORT}`)
      .set("Content-Type", "image/png")
      .send(Buffer.alloc(2 * 1024 * 1024));

    expect(response.status).toBe(404);
    expect(response.text).toContain("vision backend is disabled");
  });
});
