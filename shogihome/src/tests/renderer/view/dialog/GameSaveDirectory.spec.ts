import { flushPromises, mount } from "@vue/test-utils";
import GameSaveDirectory from "@/renderer/view/dialog/GameSaveDirectory.vue";
import ServerDirectoryPickerDialog from "@/renderer/view/dialog/ServerDirectoryPickerDialog.vue";
import { t } from "@/common/i18n";

describe("game save directory", () => {
  const mountPicker = (value = "", disabled = false) =>
    mount(GameSaveDirectory, {
      props: { value, disabled },
      attachTo: document.body,
      global: { stubs: { ServerDirectoryPickerDialog: true } },
    });

  it.each([
    ["games/matches", "server://games/matches"],
    ["server://games", "server://games"],
    ["server://", "server://"],
    ["", ""],
  ])("accepts relative paths and URI pastes: %s", async (input, expected) => {
    const wrapper = mountPicker("server://old");
    expect(wrapper.get<HTMLInputElement>("input").element.value).toBe("old");
    await wrapper.get("input").setValue(input);
    expect(wrapper.emitted("update:value")!.at(-1)).toEqual([expected]);
    await wrapper.setProps({ value: expected });
    expect(wrapper.get<HTMLInputElement>("input").element.value).toBe(
      expected.replace(/^server:\/\//, ""),
    );
    wrapper.unmount();
  });

  it("distinguishes an unset destination from the root without requiring a slash", async () => {
    const wrapper = mountPicker();
    expect(wrapper.get("input").attributes("placeholder")).toBe(t.directoryNotSelected);
    expect(wrapper.get("input").attributes("aria-description")).toBe(t.directoryNotSelected);
    await wrapper.setProps({ value: "server://" });
    expect(wrapper.get<HTMLInputElement>("input").element.value).toBe("");
    expect(wrapper.get("input").attributes("placeholder")).toBe("");
    expect(wrapper.get("input").attributes("aria-description")).toBe("server://");
    expect(wrapper.get(".server-prefix").text()).toBe("server://");
    wrapper.unmount();
  });

  it.each(["server://", "server://games"])(
    "strips the prefix from an unchanged URI paste: %s",
    async (value) => {
      const wrapper = mountPicker(value);
      await wrapper.get("input").setValue(value);
      expect(wrapper.emitted("update:value")!.at(-1)).toEqual([value]);
      expect(wrapper.get<HTMLInputElement>("input").element.value).toBe(value.substring(9));
      wrapper.unmount();
    },
  );

  it("opens the picker at the normalized current path without changing the selection", async () => {
    const wrapper = mountPicker("server://games///");
    await wrapper.get("button").trigger("click");
    const picker = wrapper.getComponent(ServerDirectoryPickerDialog);
    expect(picker.props("initialPath")).toBe("games");
    expect(wrapper.emitted("update:value")).toBeUndefined();
    wrapper.unmount();
  });

  it.each(["", "games/matches"])("commits a confirmed directory %s", async (directory) => {
    const wrapper = mountPicker();
    await wrapper.get("button").trigger("click");
    wrapper.getComponent(ServerDirectoryPickerDialog).vm.$emit("select", directory);
    await flushPromises();
    expect(wrapper.emitted("update:value")!.at(-1)).toEqual(["server://" + directory]);
    expect(wrapper.findComponent(ServerDirectoryPickerDialog).exists()).toBe(false);
    wrapper.unmount();
  });

  it("cancels browsing without changing the saved destination", async () => {
    const wrapper = mountPicker("server://games");
    await wrapper.get("button").trigger("click");
    wrapper.getComponent(ServerDirectoryPickerDialog).vm.$emit("cancel");
    await flushPromises();
    expect(wrapper.emitted("update:value")).toBeUndefined();
    expect(wrapper.get<HTMLInputElement>("input").element.value).toBe("games");
    expect(wrapper.findComponent(ServerDirectoryPickerDialog).exists()).toBe(false);
    wrapper.unmount();
  });

  it("disables editing and selection without clearing the chosen value", async () => {
    const wrapper = mountPicker("server://games", true);
    expect(wrapper.get<HTMLFieldSetElement>("fieldset").element.disabled).toBe(true);
    await wrapper.get("button").trigger("click");
    expect(wrapper.findComponent(ServerDirectoryPickerDialog).exists()).toBe(false);
    expect(wrapper.emitted("update:value")).toBeUndefined();
    expect(wrapper.get<HTMLInputElement>("input").element.value).toBe("games");
    wrapper.unmount();
  });

  it("closes the picker when auto-save becomes disabled", async () => {
    const wrapper = mountPicker("server://games");
    await wrapper.get("button").trigger("click");
    expect(wrapper.findComponent(ServerDirectoryPickerDialog).exists()).toBe(true);
    await wrapper.setProps({ disabled: true });
    expect(wrapper.findComponent(ServerDirectoryPickerDialog).exists()).toBe(false);
    expect(wrapper.emitted("update:value")).toBeUndefined();
    wrapper.unmount();
  });
});
