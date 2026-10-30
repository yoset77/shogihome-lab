import { enableAutoUnmount, shallowMount } from "@vue/test-utils";
import { reactive } from "vue";
import { t } from "@/common/i18n";
import PwaUpdateNotice from "@/renderer/view/overlay/PwaUpdateNotice.vue";

const store = reactive({
  available: false,
  expanded: true,
  canApply: true,
  applying: false,
  failed: false,
  apply: vi.fn(),
  dismiss: vi.fn(),
  show: vi.fn(),
});
vi.mock("@/renderer/store/pwa", () => ({ usePwaUpdateStore: () => store }));
enableAutoUnmount(afterEach);
beforeEach(() => {
  Object.assign(store, {
    available: true,
    expanded: true,
    canApply: true,
    applying: false,
    failed: false,
  });
  vi.clearAllMocks();
});

it("appears only while an update is available and not dismissed", () => {
  store.available = false;
  expect(shallowMount(PwaUpdateNotice).find("aside").exists()).toBe(false);
});

it("hides after postponing without applying the update", async () => {
  const wrapper = shallowMount(PwaUpdateNotice);
  await wrapper.findAll("button")[1].trigger("click");
  expect(store.dismiss).toHaveBeenCalledOnce();
  store.expanded = false;
  await wrapper.vm.$nextTick();
  expect(wrapper.find("aside").exists()).toBe(false);
  expect(store.apply).not.toHaveBeenCalled();
});

it("reappears when the menu asks for the notice", async () => {
  store.expanded = false;
  const wrapper = shallowMount(PwaUpdateNotice);
  expect(wrapper.find("aside").exists()).toBe(false);
  store.expanded = true;
  await wrapper.vm.$nextTick();
  expect(wrapper.find("aside").exists()).toBe(true);
});

it("explains blocked updates and failed attempts", async () => {
  store.canApply = false;
  const wrapper = shallowMount(PwaUpdateNotice);
  expect(wrapper.text()).toContain(t.webUpdateBlocked);
  expect(wrapper.findAll("button")[0].element.disabled).toBe(true);
  store.failed = true;
  await wrapper.vm.$nextTick();
  expect(wrapper.text()).toContain(t.webUpdateFailed);
});
