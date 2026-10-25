import { computed, ref } from "vue";
import type { ServerDirectoryEntry } from "@/common/file/upload";
import api from "@/renderer/ipc/api";
import { useErrorStore } from "@/renderer/store/error";

export function useServerDirectoryPicker(initialPath = "") {
  const ready = ref(false);
  const loading = ref(false);
  const path = ref(initialPath);
  const entries = ref<ServerDirectoryEntry[]>([]);
  const canSelect = computed(() => ready.value && !loading.value);
  let generation = 0;

  const close = () => {
    generation++;
    ready.value = false;
    loading.value = false;
  };

  const load = async (directory: string) => {
    const current = ++generation;
    ready.value = false;
    loading.value = true;
    try {
      const result = await api.listServerDirectories(directory);
      if (current !== generation) return false;
      path.value = result.path;
      entries.value = result.directories;
      ready.value = true;
      return true;
    } catch (error) {
      if (current === generation) useErrorStore().add(error);
      return false;
    } finally {
      if (current === generation) loading.value = false;
    }
  };

  return { path, entries, loading, canSelect, load, close };
}
