import { flushPromises, mount } from "@vue/test-utils";
import LoadRemoteFileDialog from "@/renderer/view/dialog/LoadRemoteFileDialog.vue";
import { floodgateTopURL } from "@/common/links/floodgate";
import { useBusyState } from "@/renderer/store/busy";

const mocks = vi.hoisted(() => ({
  closeModalDialog: vi.fn(),
  loadRemoteRecordFile: vi.fn(),
  openWebBrowser: vi.fn(),
  listEditions: vi.fn(),
  listGames: vi.fn(),
  addError: vi.fn(),
}));

vi.mock("@/renderer/store", () => ({ useStore: () => mocks }));
vi.mock("@/renderer/store/error", () => ({ useErrorStore: () => ({ add: mocks.addError }) }));
vi.mock("@/renderer/ipc/api", () => ({ default: { openWebBrowser: mocks.openWebBrowser } }));
vi.mock("@/renderer/external/wcsc", () => ({
  listEditions: mocks.listEditions,
  listGames: mocks.listGames,
}));

describe("LoadRemoteFileDialog", () => {
  const wrappers: ReturnType<typeof mount>[] = [];
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.listEditions.mockResolvedValue([
      { name: "WCSC36", year: 2026, url: "https://example.com/games.txt" },
    ]);
    mocks.listGames.mockResolvedValue([
      { title: "Engine A vs Engine B", url: "https://example.com/game.csa" },
    ]);
  });
  afterEach(() => {
    wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
    localStorage.clear();
    expect(useBusyState().isBusy).toBe(false);
  });

  async function dialog() {
    const wrapper = mount(LoadRemoteFileDialog, {
      global: { stubs: { DialogFrame: { template: "<div><slot /></div>" } } },
    });
    wrappers.push(wrapper);
    await flushPromises();
    return wrapper;
  }

  it("opens a URL without requesting game lists", async () => {
    const wrapper = await dialog();
    await wrapper.get("input.url").setValue("https://example.com/record.kif");
    await wrapper.get('button[data-hotkey="Enter"]').trigger("click");
    expect(mocks.loadRemoteRecordFile).toHaveBeenCalledExactlyOnceWith(
      "https://example.com/record.kif",
    );
    expect(mocks.closeModalDialog).toHaveBeenCalledOnce();
    expect(mocks.listEditions).not.toHaveBeenCalled();
    expect(mocks.listGames).not.toHaveBeenCalled();
  });

  it("retains the Floodgate retirement notice and website link", async () => {
    const wrapper = await dialog();
    await wrapper.get('input[type="radio"][value="floodgate"]').setValue();
    expect(wrapper.get(".warning").isVisible()).toBe(true);
    expect(wrapper.get(".warning").text()).toContain(
      "the game list for external viewers has been discontinued",
    );
    await wrapper.get(".reference .link").trigger("click");
    expect(mocks.openWebBrowser).toHaveBeenCalledExactlyOnceWith(floodgateTopURL);
    expect(mocks.listEditions).not.toHaveBeenCalled();
    expect(mocks.listGames).not.toHaveBeenCalled();
  });

  it("falls back to the URL tab for a saved Floodgate selection", async () => {
    localStorage.setItem("LoadRemoteFileDialog.lastTab", "floodgate");
    const wrapper = await dialog();
    expect(wrapper.get<HTMLInputElement>('input[type="radio"][value="url"]').element.checked).toBe(
      true,
    );
    expect(wrapper.get(".warning").isVisible()).toBe(false);
    expect(mocks.listEditions).not.toHaveBeenCalled();
  });

  it("still loads and opens WCSC games", async () => {
    const wrapper = await dialog();
    await wrapper.get('input[type="radio"][value="wcsc"]').setValue();
    await flushPromises();
    expect(mocks.listEditions).toHaveBeenCalled();
    expect(mocks.listGames).toHaveBeenCalledWith("https://example.com/games.txt");
    expect(wrapper.get(".game-header").text()).toBe("Engine A vs Engine B");
    await wrapper.get(".game-list-entry button").trigger("click");
    expect(mocks.loadRemoteRecordFile).toHaveBeenCalledExactlyOnceWith(
      "https://example.com/game.csa",
    );
    expect(mocks.addError).not.toHaveBeenCalled();
  });
});
