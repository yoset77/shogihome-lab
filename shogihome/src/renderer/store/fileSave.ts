import { computed, nextTick, reactive, ref } from "vue";
import { basename } from "@/common/file/name";
import { isValidServerEntryName } from "@/common/file/upload";
import { normalizePath, trimTrailingPathSeparators } from "@/common/helpers/path";
import { t } from "@/common/i18n";

export type FileSaveOptions = {
  title: string;
  defaultPath: string;
  server: boolean;
  extensions: readonly string[];
};

export function useFileSaveDraft(options: FileSaveOptions) {
  const initialPath = normalizePath(options.defaultPath.replace(/^server:\/\//, ""));
  const initialName = basename(initialPath);
  const initialExtension =
    options.extensions.find((ext) => initialName.toLowerCase().endsWith(ext)) ??
    options.extensions[0];
  const baseName = ref(
    initialName.toLowerCase().endsWith(initialExtension)
      ? initialName.slice(0, -initialExtension.length)
      : initialName,
  );
  const extension = ref(initialExtension);
  const directory = ref(
    "server://" + (options.server ? initialPath.split("/").slice(0, -1).join("/") : ""),
  );
  const relativeDirectory = computed(() =>
    trimTrailingPathSeparators(normalizePath(directory.value.replace(/^server:\/\//, ""))),
  );
  const fileName = computed(() => baseName.value + extension.value);
  const error = computed(() => {
    if (!baseName.value || !isValidServerEntryName(fileName.value)) {
      return t.invalidServerEntryName(fileName.value);
    }
    if (
      !options.extensions.includes(extension.value) ||
      (options.server &&
        (!directory.value ||
          (relativeDirectory.value &&
            relativeDirectory.value.split("/").some((part) => !isValidServerEntryName(part)))))
    ) {
      return t.serverInvalidDestination;
    }
    return "";
  });
  const path = computed(() =>
    options.server
      ? `server://${relativeDirectory.value ? relativeDirectory.value + "/" : ""}${fileName.value}`
      : fileName.value,
  );
  return { baseName, extension, directory, path, error };
}

class FileSaveStore {
  id = 0;
  options?: FileSaveOptions;
  private resolve?: (path: string) => void;

  async show(options: FileSaveOptions): Promise<string> {
    if (this.options) return "";
    this.id++;
    this.options = { ...options, extensions: [...options.extensions] };
    const path = await new Promise<string>((resolve) => {
      this.resolve = resolve;
    });
    // Remove the input modal before its caller opens a busy or confirmation modal.
    await nextTick();
    return path;
  }

  finish(path = ""): void {
    const resolve = this.resolve;
    this.options = undefined;
    this.resolve = undefined;
    resolve?.(path);
  }
}

export const createFileSaveStore = () => reactive(new FileSaveStore());
const store = createFileSaveStore();
export const useFileSaveStore = () => store;
