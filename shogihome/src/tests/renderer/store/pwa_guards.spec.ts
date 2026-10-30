import { reactive } from "vue";
import { exportJKFString, Record } from "tsshogi";
import {
  createPwaUpdateStore,
  createWebUpdateDependencies,
  usePwaUpdateStore,
} from "@/renderer/store/pwa";
import { loadRecordForWebApp } from "@/renderer/store/webapp";

const main = reactive({ canReloadForUpdate: true, record: new Record() });
const books = reactive({ hasUnsavedBooks: false });
const busy = reactive({ isBusy: false });
const confirmation = reactive({ message: "" });
const errors = reactive({ hasError: false });
const messages = reactive({ hasMessage: false });
const fileSave = reactive({ options: undefined as object | undefined });
vi.mock("@/renderer/store", () => ({ useStore: () => main }));
vi.mock("@/renderer/store/book", () => ({ useBookStore: () => books }));
vi.mock("@/renderer/store/busy", () => ({ useBusyState: () => busy }));
vi.mock("@/renderer/store/confirm", () => ({ useConfirmationStore: () => confirmation }));
vi.mock("@/renderer/store/error", () => ({ useErrorStore: () => errors }));
vi.mock("@/renderer/store/message", () => ({ useMessageStore: () => messages }));
vi.mock("@/renderer/store/fileSave", () => ({ useFileSaveStore: () => fileSave }));

beforeEach(() => {
  main.record = new Record();
});

afterEach(() => {
  usePwaUpdateStore().dispose();
  vi.restoreAllMocks();
  localStorage.clear();
  window.history.replaceState({}, "", "/");
});

it("checks all work and dialog owners before applying", () => {
  const store = usePwaUpdateStore();
  expect(store.canApply).toBe(true);
  for (const [object, field, blocked] of [
    [main, "canReloadForUpdate", false],
    [books, "hasUnsavedBooks", true],
    [busy, "isBusy", true],
    [confirmation, "message", "confirm"],
    [errors, "hasError", true],
    [messages, "hasMessage", true],
    [fileSave, "options", {}],
  ] as const) {
    const previous = Reflect.get(object, field);
    Reflect.set(object, field, blocked);
    expect(store.canApply).toBe(false);
    Reflect.set(object, field, previous);
  }
  const dialog = document.createElement("dialog");
  dialog.open = true;
  document.body.append(dialog);
  expect(store.canApply).toBe(false);
  dialog.remove();
  expect(store.canApply).toBe(true);
});

it("keeps share-link parameters until the page is actually reloaded", async () => {
  window.history.replaceState({}, "", "/?usen=~0.7ku&ply=0&mobile");
  main.record.first.comment = "before activation";
  const activate = vi.fn(async () => {});
  const reload = vi.fn();
  const store = createPwaUpdateStore(createWebUpdateDependencies(reload));
  store.setUpdater(activate);
  store.onNeedRefresh();
  await store.apply();
  expect(activate).toHaveBeenCalledOnce();
  expect(window.location.search).toContain("usen=");
  expect(localStorage.getItem("webapp:jkf")).toBe(exportJKFString(main.record));
  expect(reload).not.toHaveBeenCalled();
  main.record.first.comment = "latest edit";
  store.onNeedReload();
  expect(window.location.search).toBe("?mobile=");
  expect(reload).toHaveBeenCalledOnce();
  expect(loadRecordForWebApp()?.first.comment).toBe("latest edit");
});

it.each([1, 2])("preserves the shared URL if persistence fails on flush %i", async (flush) => {
  const search = "?usen=~0.7ku&branch=0&ply=1&bname=Black&wname=White&mobile";
  window.history.replaceState({}, "", "/" + search);
  main.record = loadRecordForWebApp() as Record;
  main.record.first.comment = "latest edit";
  const activate = vi.fn(async () => {});
  const reload = vi.fn();
  const store = createPwaUpdateStore(createWebUpdateDependencies(reload));
  store.setUpdater(activate);
  store.onNeedRefresh();
  if (flush === 2) {
    await store.apply();
    expect(activate).toHaveBeenCalledOnce();
  }
  const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("quota exceeded", "QuotaExceededError");
  });
  if (flush === 1) await store.apply();
  else store.onNeedReload();

  expect(store.failed).toBe(true);
  expect(store.applying).toBe(false);
  expect(activate).toHaveBeenCalledTimes(flush - 1);
  expect(reload).not.toHaveBeenCalled();
  expect(window.location.search).toBe(search);
  expect(loadRecordForWebApp()?.getUSI({ allMoves: true })).toBe(
    main.record.getUSI({ allMoves: true }),
  );
  expect(main.record.first.comment).toBe("latest edit");

  setItem.mockRestore();
  await store.apply();
  if (flush === 1) store.onNeedReload();
  expect(store.failed).toBe(false);
  expect(activate).toHaveBeenCalledOnce();
  expect(reload).toHaveBeenCalledOnce();
  expect(window.location.search).toBe("?mobile=");
  expect(loadRecordForWebApp()?.first.comment).toBe("latest edit");
});

it("does not activate if Browser storage cannot preserve the record", async () => {
  const activate = vi.fn(async () => {});
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("quota exceeded", "QuotaExceededError");
  });
  const store = usePwaUpdateStore();
  store.setUpdater(activate);
  store.onNeedRefresh();
  await store.apply();
  expect(store.failed).toBe(true);
  expect(activate).not.toHaveBeenCalled();
});
