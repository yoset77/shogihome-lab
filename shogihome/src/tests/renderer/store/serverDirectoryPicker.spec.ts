import { useServerDirectoryPicker } from "@/renderer/store/serverDirectoryPicker";
import { useBusyState } from "@/renderer/store/busy";
import type { ServerDirectoryList } from "@/common/file/upload";

const mocks = vi.hoisted(() => ({ list: vi.fn(), error: vi.fn() }));
vi.mock("@/renderer/ipc/api", () => ({ default: { listServerDirectories: mocks.list } }));
vi.mock("@/renderer/store/error", () => ({ useErrorStore: () => ({ add: mocks.error }) }));

describe("server directory picker", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => expect(useBusyState().isBusy).toBe(false));

  it("publishes only the latest requested directory", async () => {
    const old = Promise.withResolvers<ServerDirectoryList>();
    mocks.list
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ path: "new", directories: [] });
    const picker = useServerDirectoryPicker();
    const loading = picker.load("old");
    expect(await picker.load("new")).toBe(true);
    old.resolve({ path: "old", directories: [{ name: "child", path: "old/child" }] });
    expect(await loading).toBe(false);
    expect(picker.path.value).toBe("new");
    expect(picker.entries.value).toEqual([]);
    expect(picker.canSelect.value).toBe(true);
    expect(picker.loading.value).toBe(false);
  });

  it.each([false, true])("ignores cancelled request results including errors=%s", async (fail) => {
    const pending = Promise.withResolvers<ServerDirectoryList>();
    mocks.list.mockReturnValueOnce(pending.promise);
    const picker = useServerDirectoryPicker();
    const loading = picker.load("");
    picker.close();
    if (fail) pending.reject(new Error("Cancelled request"));
    else pending.resolve({ path: "", directories: [] });
    await loading;
    expect(picker.canSelect.value).toBe(false);
    expect(picker.loading.value).toBe(false);
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("reports listing errors without replacing the previous directory", async () => {
    mocks.list.mockResolvedValueOnce({ path: "games", directories: [] });
    const picker = useServerDirectoryPicker();
    await picker.load("games");
    const error = new Error("Directory removed");
    mocks.list.mockRejectedValueOnce(error);
    await picker.load("missing");
    expect(picker.path.value).toBe("games");
    expect(picker.canSelect.value).toBe(false);
    expect(mocks.error).toHaveBeenCalledWith(error);
  });

  it("disables confirmation while loading without blocking the parent after cancellation", async () => {
    const pending = Promise.withResolvers<ServerDirectoryList>();
    mocks.list.mockReturnValueOnce(pending.promise);
    const picker = useServerDirectoryPicker("games");
    const loading = picker.load("games");
    expect(picker.path.value).toBe("games");
    expect(picker.loading.value).toBe(true);
    expect(picker.canSelect.value).toBe(false);
    expect(useBusyState().isBusy).toBe(false);
    picker.close();
    expect(picker.loading.value).toBe(false);
    pending.resolve({ path: "games", directories: [] });
    await loading;
    expect(picker.canSelect.value).toBe(false);
  });

  it("does not let an old response enable confirmation while a newer request is pending", async () => {
    const first = Promise.withResolvers<ServerDirectoryList>();
    const second = Promise.withResolvers<ServerDirectoryList>();
    mocks.list.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const picker = useServerDirectoryPicker();
    const old = picker.load("old");
    const current = picker.load("current");
    first.resolve({ path: "old", directories: [] });
    await old;
    expect(picker.loading.value).toBe(true);
    expect(picker.canSelect.value).toBe(false);
    second.resolve({ path: "current", directories: [] });
    await current;
    expect(picker.canSelect.value).toBe(true);
    expect(picker.path.value).toBe("current");
  });
});
