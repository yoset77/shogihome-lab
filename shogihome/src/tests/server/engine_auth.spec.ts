import { PassThrough } from "node:stream";
import type net from "node:net";
import { describe, expect, it } from "vitest";
import { authenticateSocket } from "@/server/engine/auth";

describe("engine wrapper authentication", () => {
  it("should reject when the wrapper does not complete authentication", async () => {
    const socket = new PassThrough() as unknown as net.Socket;

    await expect(authenticateSocket(socket, "secret", 10)).rejects.toThrow(
      "Authentication timed out",
    );
  });
});
