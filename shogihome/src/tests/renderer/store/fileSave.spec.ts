import {
  createFileSaveStore,
  useFileSaveDraft,
  type FileSaveOptions,
} from "@/renderer/store/fileSave";

const options: FileSaveOptions = {
  title: "Save",
  defaultPath: "server://games/current.KIF",
  server: true,
  extensions: [".kif", ".jkf"],
};

describe("file save draft", () => {
  it("separates the directory, name and format and builds a server URI", () => {
    const draft = useFileSaveDraft(options);
    expect(draft.directory.value).toBe("server://games");
    expect(draft.baseName.value).toBe("current");
    expect(draft.extension.value).toBe(".kif");
    expect(draft.error.value).toBe("");
    draft.directory.value = "server://games/finals///";
    draft.baseName.value = "result";
    draft.extension.value = ".jkf";
    expect(draft.path.value).toBe("server://games/finals/result.jkf");
  });

  it.each(["current.kif", "server://current.kif"])("defaults to the root for %s", (defaultPath) => {
    const draft = useFileSaveDraft({ ...options, defaultPath });
    expect(draft.directory.value).toBe("server://");
    expect(draft.path.value).toBe("server://current.kif");
    expect(draft.error.value).toBe("");
  });

  it("returns only a file name for a local download", () => {
    const draft = useFileSaveDraft({
      ...options,
      server: false,
      defaultPath: "C:\\games\\local.jkf",
    });
    expect(draft.baseName.value).toBe("local");
    expect(draft.extension.value).toBe(".jkf");
    expect(draft.path.value).toBe("local.jkf");
  });

  it.each(["", "../file", "a/b", "a\\b", "con", ".hidden", "x".repeat(251)])(
    "rejects an invalid save name: %s",
    (name) => {
      const draft = useFileSaveDraft(options);
      draft.baseName.value = name;
      expect(draft.error.value).not.toBe("");
    },
  );

  it.each(["", "server://../games", "server:///games", "server://games//final", "server://.lock"])(
    "rejects an invalid destination: %s",
    (directory) => {
      const draft = useFileSaveDraft(options);
      draft.directory.value = directory;
      expect(draft.error.value).not.toBe("");
    },
  );

  it("rejects an unsupported extension", () => {
    const draft = useFileSaveDraft({ ...options, extensions: [".db"], defaultPath: "book.db" });
    draft.extension.value = ".bin";
    expect(draft.error.value).not.toBe("");
  });
});

describe("file save store", () => {
  it("settles selection or cancellation once and clears the request", async () => {
    const store = createFileSaveStore();
    const first = store.show(options);
    expect(store.options).toEqual(options);
    store.finish("server://games/other.kif");
    store.finish();
    await expect(first).resolves.toBe("server://games/other.kif");
    expect(store.options).toBeUndefined();
    const id = store.id;
    const second = store.show(options);
    expect(store.id).toBeGreaterThan(id);
    store.finish();
    await expect(second).resolves.toBe("");
  });

  it("does not replace a pending input request", async () => {
    const store = createFileSaveStore();
    const first = store.show(options);
    await expect(store.show({ ...options, defaultPath: "second.kif" })).resolves.toBe("");
    expect(store.options?.defaultPath).toBe(options.defaultPath);
    store.finish();
    await expect(first).resolves.toBe("");
  });
});
