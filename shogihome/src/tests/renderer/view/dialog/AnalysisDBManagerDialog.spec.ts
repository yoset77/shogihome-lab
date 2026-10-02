import { mount, flushPromises } from "@vue/test-utils";
import AnalysisDBManagerDialog from "@/renderer/view/dialog/AnalysisDBManagerDialog.vue";
import { useBusyState } from "@/renderer/store/busy";

const error = vi.hoisted(() => vi.fn());
const message = vi.hoisted(() => vi.fn());
vi.mock("@/renderer/store", () => ({ useStore: () => ({}) }));
vi.mock("@/renderer/store/lan", () => ({ useLanStore: () => ({}) }));
vi.mock("@/renderer/store/error", () => ({ useErrorStore: () => ({ add: error }) }));
vi.mock("@/renderer/store/message", () => ({ useMessageStore: () => ({ enqueue: message }) }));

describe("AnalysisDBManagerDialog export", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("cancels an overwrite without showing an error or a success message", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 1,
              name: "engine",
              engine_key: "key",
              record_count: 1,
              min_depth: 10,
              max_depth: 20,
              last_updated: 0,
            },
          ]),
        ),
      )
      .mockResolvedValueOnce(new Response("exists", { status: 409 }));
    vi.stubGlobal("fetch", request);
    vi.spyOn(window, "prompt").mockReturnValue("existing.db");
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const wrapper = mount(AnalysisDBManagerDialog, {
      global: { stubs: { DialogFrame: { template: "<div><slot /></div>" }, Icon: true } },
    });
    try {
      await flushPromises();
      await wrapper.get(".actions button").trigger("click");
      await flushPromises();
      expect(request).toHaveBeenCalledTimes(2);
      expect(error).not.toHaveBeenCalled();
      expect(message).not.toHaveBeenCalled();
      expect(useBusyState().isBusy).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });
});
