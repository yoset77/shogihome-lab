import { flushPromises, mount } from "@vue/test-utils";
import { ref } from "vue";
import PlayerSelector from "@/renderer/view/dialog/PlayerSelector.vue";
import type { LanEngineInfo } from "@/common/engine/relay_protocol";
import { t } from "@/common/i18n";

const store = {
  status: ref("connected"),
  engineList: ref<LanEngineInfo[]>([]),
  fetchEngineList: vi.fn().mockResolvedValue(undefined),
};
vi.mock("@/renderer/store/lan", () => ({ useLanStore: () => store }));

describe("LAN player selector", () => {
  const wrappers: ReturnType<typeof mount>[] = [];
  beforeEach(() => {
    vi.clearAllMocks();
    store.status.value = "connected";
    store.engineList.value = [
      { id: "game", name: "Game", type: ["game"] },
      { id: "research", name: "Research", type: ["research"] },
      { id: "mate", name: "Mate", type: ["mate"] },
      { id: "all", name: "All" },
    ];
  });
  afterEach(() => wrappers.splice(0).forEach((wrapper) => wrapper.unmount()));

  function selector(
    engineType: "game" | "research" | "mate",
    containsHuman = false,
    showNone = false,
  ) {
    const wrapper = mount(PlayerSelector, {
      props: { playerUri: "", engineType, containsHuman, showNone },
      slots: { "extra-buttons": "<button>Remove secondary</button>" },
    });
    wrappers.push(wrapper);
    return wrapper;
  }

  it.each(["game", "research", "mate"] as const)("filters engines by the %s capability", (type) => {
    const wrapper = selector(type);
    expect(wrapper.findAll("li").map((entry) => entry.text())).toEqual([
      store.engineList.value.find((engine) => engine.id === type)!.name,
      "All",
    ]);
    expect(wrapper.find(".player-info").exists()).toBe(false);
    expect(wrapper.find(".player-settings").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("---");
    expect(wrapper.get("button").text()).toBe("Remove secondary");
  });

  it("retains human and empty selections and emits LAN references", async () => {
    const wrapper = selector("game", true, true);
    expect(wrapper.findAll("li").map((entry) => entry.text())).toEqual([
      t.none,
      t.human,
      "Game",
      "All",
    ]);
    await wrapper.findAll("li")[2].trigger("click");
    expect(wrapper.emitted("update:playerUri")).toEqual([["lan-engine:game"]]);
  });

  it("fetches discovery data on mount and reacts to refreshed engines", async () => {
    store.status.value = "disconnected";
    const wrapper = selector("research");
    await flushPromises();
    expect(store.fetchEngineList).toHaveBeenCalledOnce();
    store.engineList.value = [{ id: "new", name: "New", type: ["research"] }];
    await flushPromises();
    expect(wrapper.findAll("li").map((entry) => entry.text())).toEqual(["New"]);
  });
});
