import { mount, flushPromises } from "@vue/test-utils";
import AnalysisDBManagerDialog from "@/renderer/view/dialog/AnalysisDBManagerDialog.vue";
import { useBusyState } from "@/renderer/store/busy";
import { useFileSaveStore } from "@/renderer/store/fileSave";
import { useConfirmationStore } from "@/renderer/store/confirm";

const error = vi.hoisted(() => vi.fn());
const message = vi.hoisted(() => vi.fn());
vi.mock("@/renderer/store", () => ({ useStore: () => ({}) }));
vi.mock("@/renderer/store/lan", () => ({ useLanStore: () => ({}) }));
vi.mock("@/renderer/store/error", () => ({ useErrorStore: () => ({ add: error }) }));
vi.mock("@/renderer/store/message", () => ({ useMessageStore: () => ({ enqueue: message }) }));

describe("AnalysisDBManagerDialog export", () => {
  afterEach(() => {
    useFileSaveStore().finish();
    useConfirmationStore().cancel();
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
    const wrapper = mount(AnalysisDBManagerDialog, {
      global: { stubs: { DialogFrame: { template: "<div><slot /></div>" }, Icon: true } },
    });
    try {
      await flushPromises();
      await wrapper.get(".actions button").trigger("click");
      expect(useFileSaveStore().options).toMatchObject({
        defaultPath: "engine.db",
        server: true,
        extensions: [".db"],
      });
      expect(request).toHaveBeenCalledOnce();
      useFileSaveStore().finish("server://exports/existing.db");
      await flushPromises();
      expect(useConfirmationStore().message).toContain("exports/existing.db");
      useConfirmationStore().cancel();
      await flushPromises();
      expect(request).toHaveBeenCalledTimes(2);
      expect(JSON.parse(request.mock.calls[1][1].body)).toMatchObject({
        filename: "exports/existing.db",
        overwrite: false,
      });
      expect(error).not.toHaveBeenCalled();
      expect(message).not.toHaveBeenCalled();
      expect(useBusyState().isBusy).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });
});
