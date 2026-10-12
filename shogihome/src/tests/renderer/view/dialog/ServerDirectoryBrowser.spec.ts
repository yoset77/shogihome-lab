import { mount } from "@vue/test-utils";
import ServerDirectoryBrowser from "@/renderer/view/dialog/ServerDirectoryBrowser.vue";
import { t } from "@/common/i18n";

const entries = [
  { name: "2024", path: "games/2024", isDirectory: true },
  { name: "test.kifu", path: "games/test.kifu", isDirectory: false },
];

function mountBrowser(path: string, list = entries, options: Record<string, unknown> = {}) {
  return mount(ServerDirectoryBrowser, {
    props: {
      selectedPath: "games",
      path,
      entries: list,
      open: true,
      ...options,
    },
    slots: {
      "entry-actions": `<template #entry-actions="{ entry }"><button class="entry-action">{{ entry.name }}</button></template>`,
    },
  });
}

describe("ServerDirectoryBrowser", () => {
  it("distinguishes unselected, root and directory selection in the path input", () => {
    expect(
      mountBrowser("", [], { selectedPath: undefined }).get<HTMLInputElement>(".path-input input")
        .element.value,
    ).toBe("");
    expect(
      mountBrowser("", [], { selectedPath: "" }).get<HTMLInputElement>(".path-input input").element
        .value,
    ).toBe("server://");
    expect(mountBrowser("").get<HTMLInputElement>(".path-input input").element.value).toBe(
      "server://games",
    );
  });

  it("hides the list while closed and emits open from the select button", async () => {
    const wrapper = mountBrowser("", entries, { open: false });
    expect(wrapper.find(".server-selection-list").exists()).toBe(false);
    expect(wrapper.find(".path-input").exists()).toBe(true);
    await wrapper.get(".path-input button").trigger("click");
    expect(wrapper.emitted("open")).toHaveLength(1);
  });

  it("hides the path input when disabled", () => {
    const wrapper = mountBrowser("", entries, { showPathInput: false });
    expect(wrapper.find(".path-input").exists()).toBe(false);
    expect(wrapper.find(".server-selection-list").exists()).toBe(true);
  });

  it("offers the root as a selectable entry at the root listing", async () => {
    const wrapper = mountBrowser("", entries);
    const root = wrapper
      .findAll(".server-selection-item")
      .find((item) => item.text().includes(t.rootDirectory));
    expect(root).toBeDefined();
    await root!.get(".entry-header").trigger("click");
    expect(wrapper.emitted("select")![0]).toEqual([
      { name: t.rootDirectory, path: "", isDirectory: true },
    ]);
    expect(root!.get("button.entry-action").text()).toBe(t.rootDirectory);
  });

  it("does not offer a root entry away from the root", () => {
    const wrapper = mountBrowser("games", entries);
    const root = wrapper
      .findAll(".server-selection-item")
      .find((item) => item.text().includes(t.rootDirectory));
    expect(root).toBeUndefined();
  });

  it("renders breadcrumbs for the current directory path", () => {
    const wrapper = mountBrowser("games/2024", []);
    const breadcrumbs = wrapper.findAll(".breadcrumb-item");
    expect(breadcrumbs).toHaveLength(3);
    expect(breadcrumbs[0].text()).toBe("Root");
    expect(breadcrumbs[1].text()).toBe("games");
    expect(breadcrumbs[2].text()).toBe("2024");
  });

  it("emits update:path when a breadcrumb is clicked", async () => {
    const wrapper = mountBrowser("games/2024", []);
    await wrapper.findAll(".breadcrumb-item")[1].trigger("click");
    expect(wrapper.emitted("update:path")![0]).toEqual(["games"]);
    await wrapper.findAll(".breadcrumb-item")[0].trigger("click");
    expect(wrapper.emitted("update:path")![1]).toEqual([""]);
  });

  it("shows a parent entry and emits update:path for it", async () => {
    const wrapper = mountBrowser("games/2024", []);
    const parent = wrapper.findAll(".server-selection-item").find((item) => item.text() === "..");
    expect(parent).toBeDefined();
    await parent!.trigger("click");
    expect(wrapper.emitted("update:path")![0]).toEqual(["games"]);
  });

  it("does not show a parent entry at the root", () => {
    const wrapper = mountBrowser("", entries);
    const parent = wrapper.findAll(".server-selection-item").find((item) => item.text() === "..");
    expect(parent).toBeUndefined();
  });

  it("emits select when an entry is clicked", async () => {
    const wrapper = mountBrowser("games");
    const target = wrapper
      .findAll(".server-selection-item")
      .find((item) => item.text().includes("test.kifu"));
    await target!.get(".entry-header").trigger("click");
    expect(wrapper.emitted("select")![0]).toEqual([entries[1]]);
  });

  it("renders entry action buttons via the slot", () => {
    const wrapper = mountBrowser("games");
    const buttons = wrapper.findAll("button.entry-action");
    expect(buttons).toHaveLength(2);
    expect(buttons[1].text()).toBe("test.kifu");
  });
});
