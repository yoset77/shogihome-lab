import { beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { visionWorkerClient } from "@/server/vision/worker";

const SERVER_PORT = vi.hoisted(() => {
  return 8200 + Math.floor(Math.random() * 100);
});

vi.hoisted(() => {
  process.env.PORT = SERVER_PORT.toString();
  process.env.KIFU_DIR = "./data";
  process.env.VISION_ENABLED = "true";
  process.env.VISION_TIMEOUT_MS = "1000";
  process.env.VISION_MAX_IMAGE_MB = "1";
});

import { app } from "@/server/main";

beforeAll(() => {
  visionWorkerClient.resolveConfig = () => ({
    command: process.execPath,
    args: ["src/tests/server/helpers/mock_vision_cli.mjs"],
  });
});

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

describe("Vision scan API", () => {
  it("returns a scanned SFEN from the vision wrapper", async () => {
    const response = await request(app)
      .post("/api/vision/scan?sideToMove=black&viewpoint=black&maxCandidates=3")
      .set("Host", `localhost:${SERVER_PORT}`)
      .set("Content-Type", "image/png")
      .send(PNG_BYTES);

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.sfen).toBe(
      "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1",
    );
    expect(response.body.warnings).toEqual([]);
    expect(response.body.board).toBeUndefined();
    expect(response.headers["content-security-policy"]).toContain("img-src 'self' data: blob:");
  });

  it("rejects unsupported image content types", async () => {
    const response = await request(app)
      .post("/api/vision/scan")
      .set("Host", `localhost:${SERVER_PORT}`)
      .set("Content-Type", "text/plain")
      .send("not an image");

    expect(response.status).toBe(415);
    expect(response.text).toContain("unsupported image type");
  });

  it("rejects empty image bodies", async () => {
    const response = await request(app)
      .post("/api/vision/scan")
      .set("Host", `localhost:${SERVER_PORT}`)
      .set("Content-Type", "image/png")
      .send(Buffer.alloc(0));

    expect(response.status).toBe(400);
    expect(response.text).toContain("image body is required");
  });

  it("rejects wrapper responses with invalid SFEN", async () => {
    const response = await request(app)
      .post("/api/vision/scan?maxCandidates=4")
      .set("Host", `localhost:${SERVER_PORT}`)
      .set("Content-Type", "image/png")
      .send(PNG_BYTES);

    expect(response.status).toBe(502);
    expect(response.text).toContain("invalid sfen");
  });

  it("returns wrapper timeout as a bad gateway error", async () => {
    const response = await request(app)
      .post("/api/vision/scan?maxCandidates=6")
      .set("Host", `localhost:${SERVER_PORT}`)
      .set("Content-Type", "image/png")
      .send(PNG_BYTES);

    expect(response.status).toBe(502);
    expect(response.text).toContain("timed out");
  });
});
