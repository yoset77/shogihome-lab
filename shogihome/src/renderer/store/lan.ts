import { ref, readonly } from "vue";
import { lanDiscoveryEngine, LanEngineStatus } from "@/renderer/network/lan_engine";
import type { LanEngineInfo } from "@/common/engine/relay_protocol";

const status = ref<LanEngineStatus>("disconnected");
const engineList = ref<LanEngineInfo[]>([]);
const error = ref<string | null>(null);

lanDiscoveryEngine.subscribeStatus((newStatus) => {
  status.value = newStatus;
});

export function useLanStore() {
  const fetchEngineList = async (force = false) => {
    try {
      engineList.value = await lanDiscoveryEngine.getEngineList(force);
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
