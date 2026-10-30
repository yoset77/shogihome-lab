import { enableAutoUnmount, shallowMount } from "@vue/test-utils";
import { nextTick, reactive } from "vue";
import MobileControls from "@/renderer/view/main/MobileControls.vue";
import FileMenu from "@/renderer/view/menu/FileMenu.vue";

const store = reactive({
  canNavigateRecord: true,
  canDeleteRecordMove: true,
  changePly: vi.fn(),
  goBack: vi.fn(),
  goForward: vi.fn(),
  removeCurrentMove: vi.fn(),
});

vi.mock("@/renderer/store", () => ({ useStore: () => store }));

enableAutoUnmount(afterEach);
beforeEach(() => {
  vi.clearAllMocks();
  store.canNavigateRecord = true;
  store.canDeleteRecordMove = true;
});

it("disables record operations while keeping Menu available, and restores them afterwards", async () => {
  const wrapper = shallowMount(MobileControls);
  const buttons = wrapper.findAll("button");
  expect(buttons.every((button) => !button.element.disabled)).toBe(true);

  store.canNavigateRecord = false;
  store.canDeleteRecordMove = false;
  await nextTick();
  expect(buttons.slice(0, 5).every((button) => button.element.disabled)).toBe(true);
  for (const button of buttons.slice(0, 5)) await button.trigger("click");
  expect(store.changePly).not.toHaveBeenCalled();
  expect(store.goBack).not.toHaveBeenCalled();
  expect(store.goForward).not.toHaveBeenCalled();
  expect(store.removeCurrentMove).not.toHaveBeenCalled();
  await buttons[5].trigger("click");
  expect(wrapper.findComponent(FileMenu).exists()).toBe(true);

  store.canNavigateRecord = true;
  store.canDeleteRecordMove = true;
  await nextTick();
  expect(buttons.every((button) => !button.element.disabled)).toBe(true);
  for (const button of buttons.slice(0, 5)) await button.trigger("click");
  expect(store.changePly.mock.calls).toEqual([[0], [Number.MAX_SAFE_INTEGER]]);
  expect(store.goBack).toHaveBeenCalledOnce();
  expect(store.goForward).toHaveBeenCalledOnce();
  expect(store.removeCurrentMove).toHaveBeenCalledOnce();
});

it("can allow navigation without enabling deletion", () => {
  store.canDeleteRecordMove = false;
  const buttons = shallowMount(MobileControls).findAll("button");
  expect(buttons.slice(0, 4).every((button) => !button.element.disabled)).toBe(true);
  expect(buttons[4].element.disabled).toBe(true);
});
