import { createConfirmationStore } from "@/renderer/store/confirm";

describe("store/confirm", () => {
  it("showConfirmation", () => {
    const store = createConfirmationStore();
    const confirmation1 = {
      message: "Are you ready?",
      onOk: vi.fn(),
    };
    store.show(confirmation1);
    expect(store.message).toBe("Are you ready?");
    store.ok();
    expect(store.message).toBeUndefined();
    expect(confirmation1.onOk).toBeCalledTimes(1);
    const confirmation2 = {
      message: "Do you really want to delete?",
      onOk: vi.fn(),
    };
    store.show(confirmation2);
    expect(store.message).toBe("Do you really want to delete?");
    store.cancel();
    expect(store.message).toBeUndefined();
    expect(confirmation2.onOk).toBeCalledTimes(0);
  });

  it.each([true, false])("resolves an asynchronous confirmation with %s", async (ok) => {
    const store = createConfirmationStore();
    const result = store.ask("Overwrite?");
    expect(store.message).toBe("Overwrite?");
    if (ok) store.ok();
    else store.cancel();
    await expect(result).resolves.toBe(ok);
    expect(store.message).toBeUndefined();
  });

  it("settles a replaced asynchronous confirmation as cancelled", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const store = createConfirmationStore();
      const first = store.ask("First");
      const second = store.ask("Second");
      await expect(first).resolves.toBe(false);
      store.ok();
      await expect(second).resolves.toBe(true);
    } finally {
      warning.mockRestore();
    }
  });
});
