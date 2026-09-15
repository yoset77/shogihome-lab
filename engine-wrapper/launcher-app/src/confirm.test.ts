import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
}));

import { ask } from "@tauri-apps/plugin-dialog";
import { confirmAction } from "./confirm";

const askMock = ask as unknown as ReturnType<typeof vi.fn>;

describe("confirmAction", () => {
  it("passes the dialog result through", async () => {
    askMock.mockResolvedValueOnce(true);
    expect(await confirmAction("delete?")).toBe(true);
    askMock.mockResolvedValueOnce(false);
    expect(await confirmAction("delete?")).toBe(false);
  });

  it("fails closed when the dialog errors (cancel must not mutate)", async () => {
    askMock.mockRejectedValueOnce(new Error("denied"));
    expect(await confirmAction("delete?")).toBe(false);
  });

  it("forwards the title when given", async () => {
    askMock.mockResolvedValueOnce(true);
    await confirmAction("delete?", "Editor");
    expect(askMock).toHaveBeenLastCalledWith("delete?", { title: "Editor" });
  });
});
