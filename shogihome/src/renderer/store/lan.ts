import { ref, readonly } from "vue";
import { lanDiscoveryEngine, LanEngineStatus, LanEngineInfo } from "@/renderer/network/lan_engine";

const status = ref<LanEngineStatus>("disconnected");
const engineList = ref<LanEngineInfo[]>([]);
const error = ref<string | null>(null);

lanDiscoveryEngine.subscribeStatus((newStatus) => {
  status.value = newStatus;
});

export function useLanStore() {
  const fetchEngineList = async () => {
    try {
      engineList.value = await lanDiscoveryEngine.getEngineList(false);
      error.value = null;
    } catch (e) {
      console.error("Failed to fetch engine list:", e);
      // Keep previous list if available, or empty
    } finally {
      if (lanDiscoveryEngine.isIdle) {
        lanDiscoveryEngine.disconnect();
      }
    }
  };

  return {
    status: readonly(status),
    engineList: readonly(engineList),
    error: readonly(error),
    fetchEngineList,
  };
}
