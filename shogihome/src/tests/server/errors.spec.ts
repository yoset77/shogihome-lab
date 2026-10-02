import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleError } from "@/server/errors";
import { t } from "@/common/i18n";

describe("server error handling", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([400, 413] as const)(
    "preserves HTTPException status %s with safe text",
    async (status) => {
      const app = new Hono().onError(handleError).get("/", () => {
        throw new HTTPException(status, { message: "<script>invalid request</script>" });
      });
      const response = await app.request("/");

      expect(response.status).toBe(status);
      expect(response.headers.get("content-type")).toContain("text/plain");
      expect(await response.text()).toBe("&lt;script&gt;invalid request&lt;/script&gt;");
      expect(console.error).not.toHaveBeenCalled();
    },
  );

  it("keeps an internal SyntaxError as a logged 500 error", async () => {
    const app = new Hono().onError(handleError).get("/", () => {
      throw new SyntaxError("internal failure");
    });
    const response = await app.request("/");

    expect(response.status).toBe(500);
    expect(await response.text()).toBe(t.serverInternalError);
    expect(console.error).toHaveBeenCalledWith("Unhandled error:", expect.any(SyntaxError));
  });
});
