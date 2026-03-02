<template>
  <DropdownList
    v-model:value="selectedPlayerURI"
    class="player-select"
    :tags="engines.tagList"
    :items="listItems"
    :default-tags="defaultTags"
  />
  <div v-if="displayPonderState" class="row player-info">
    <span class="player-info-key">{{ t.ponder }}:</span>
    <span class="player-info-value">{{ ponderState || "---" }}</span>
  </div>
  <div v-if="displayThreadState" class="row player-info">
    <span class="player-info-key">{{ t.numberOfThreads }}:</span>
    <span class="player-info-value">{{ threadState || "---" }}</span>
  </div>
  <div v-if="displayMultiPvState" class="row player-info">
    <span class="player-info-key">{{ t.suggestionsCount }}:</span>
    <span class="player-info-value">{{ multiPVState || "---" }}</span>
  </div>
  <div class="horizontal-buttons">
    <button
      v-if="enableEditButton && isPlayerSettingsEnabled"
      class="player-settings"
      @click="openPlayerSettings"
    >
      <Icon :icon="IconType.SETTINGS" />
      <span>{{ t.settings }}</span>
    </button>
    <slot name="extra-buttons"></slot>
  </div>
  <USIEngineOptionsDialog
    v-if="engineOptionsDialog"
    :latest="engineOptionsDialog"
    :ok-button-text="t.save"
    @ok="savePlayerSettings"
    @cancel="closePlayerSettings"
  />
</template>

<script setup lang="ts">
import { t } from "@/common/i18n";
import { computed, PropType, ref, onMounted } from "vue";
import * as uri from "@/common/uri.js";
import Icon from "@/renderer/view/primitive/Icon.vue";
import USIEngineOptionsDialog from "@/renderer/view/dialog/USIEngineOptionsDialog.vue";
import { IconType } from "@/renderer/assets/icons";
import {
  getUSIEngineOptionCurrentValue,
  USIEngine,
  ImmutableUSIEngines,
  USIPonder,
  USIEngines,
  getUSIEngineThreads,
  getUSIEngineMultiPV,
  getPredefinedUSIEngineTag,
} from "@/common/settings/usi";
import api from "@/renderer/ipc/api";
import { useErrorStore } from "@/renderer/store/error";
import { useBusyState } from "@/renderer/store/busy";
import DropdownList from "@/renderer/view/primitive/DropdownList.vue";
import { useLanStore } from "@/renderer/store/lan";

const selectedPlayerURI = defineModel<string>("playerUri", { required: true });
const defaultTags = computed(() => (props.defaultTag ? [props.defaultTag] : []));

const props = defineProps({
  containsHuman: {
    type: Boolean,
    default: false,
  },
  containsBasicEngines: {
    type: Boolean,
    default: false,
  },
  containsLan: {
    type: Boolean,
    default: false,
  },
  engines: {
    type: Object as PropType<ImmutableUSIEngines>,
    required: true,
  },
  defaultTag: {
    type: String as PropType<string>,
    default: null,
  },
  displayPonderState: {
    type: Boolean,
    default: false,
  },
  displayThreadState: {
    type: Boolean,
    default: false,
  },
  displayMultiPvState: {
    type: Boolean,
    default: false,
  },
  enableEditButton: {
    type: Boolean,
    default: true,
  },
  showNone: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits<{
  selectPlayer: [uri: string];
  updateEngines: [usiEngines: USIEngines];
}>();

const busyState = useBusyState();
const engineOptionsDialog = ref(null as USIEngine | null);
const lanStore = useLanStore();

onMounted(async () => {
  // Fetch LAN engines if containsHuman or containsLan is true
  if (props.containsHuman || props.containsLan) {
    if (lanStore.status.value === "disconnected") {
      try {
        await lanStore.fetchEngineList();
      } catch (e) {
        console.warn("Failed to connect to LAN engine server:", e);
      }
    }
  }
});

const listItems = computed(() => {
  const items = [];
  const tag = props.defaultTag || getPredefinedUSIEngineTag("game");

  if (props.showNone) {
    items.push({ label: t.none, value: "", tags: [tag] });
  }

  if (props.containsHuman) {
    items.push({ label: t.human, value: uri.ES_HUMAN, tags: [tag] });
  }

  if (props.containsHuman || props.containsLan) {
    // Check status or list availability
    if (lanStore.status.value === "connecting") {
      items.push({
        label: t.connecting,
        value: "",
        tags: [tag],
        disabled: true,
      });
    } else if (lanStore.engineList.value.length > 0) {
      for (const info of lanStore.engineList.value) {
        // Filter by type if context is known
        if (props.defaultTag === getPredefinedUSIEngineTag("game")) {
          if (info.type && info.type !== "game" && info.type !== "both") continue;
        } else if (props.defaultTag === getPredefinedUSIEngineTag("research")) {
          if (info.type && info.type !== "research" && info.type !== "both") continue;
        }

        items.push({
          label: info.name,
          value: `lan-engine:${info.id}`,
          tags: [tag],
        });
      }
    } else if (lanStore.status.value === "connected" && lanStore.engineList.value.length === 0) {
      // Connected but no engines found? or just show nothing specific
    }
  }

  for (const engine of props.engines.engineList) {
    items.push({ label: engine.name, value: engine.uri, tags: engine.tags });
  }
  if (props.containsBasicEngines) {
    for (const playerURI of uri.ES_BASIC_ENGINE_LIST) {
      items.push({
        label: uri.basicEngineName(playerURI),
        value: playerURI,
        tags: [tag],
      });
    }
  }
  return items;
});

const ponderState = computed(() => {
  if (!uri.isUSIEngine(selectedPlayerURI.value)) {
    return null;
  }
  const engine = props.engines.getEngine(selectedPlayerURI.value);
  return engine && getUSIEngineOptionCurrentValue(engine.options[USIPonder]) === "true"
    ? "ON"
    : "OFF";
});

const threadState = computed(() => {
  if (!uri.isUSIEngine(selectedPlayerURI.value)) {
    return null;
  }
  const engine = props.engines.getEngine(selectedPlayerURI.value);
  if (!engine) {
    return null;
  }
  const threads = getUSIEngineThreads(engine);
  return threads;
});

const multiPVState = computed(() => {
  if (!uri.isUSIEngine(selectedPlayerURI.value)) {
    return null;
  }
  const engine = props.engines.getEngine(selectedPlayerURI.value);
  if (!engine) {
    return null;
  }
  const multiPV = getUSIEngineMultiPV(engine);
  return multiPV;
});

const isPlayerSettingsEnabled = computed(() => {
  return uri.isUSIEngine(selectedPlayerURI.value);
});

const openPlayerSettings = () => {
  if (uri.isUSIEngine(selectedPlayerURI.value)) {
    const engine = props.engines.getEngine(selectedPlayerURI.value);
    if (!engine) {
      useErrorStore().add("利用可能なエンジンが選択されていません。");
      return;
    }
    engineOptionsDialog.value = engine;
  }
};

const savePlayerSettings = async (settings: USIEngine) => {
  engineOptionsDialog.value = null;
  const clone = props.engines.getClone();
  clone.updateEngine(settings);
  busyState.retain();
  try {
    await api.saveUSIEngines(clone);
    emit("updateEngines", clone);
  } catch (e) {
    useErrorStore().add(e);
  } finally {
    busyState.release();
  }
};

const closePlayerSettings = () => {
  engineOptionsDialog.value = null;
};
</script>

<style scoped>
.player-select {
  width: 100%;
  margin-bottom: 5px;
}
.player-info {
  line-height: 1.3em;
  font-size: 0.8em;
}
.player-info-key {
  width: 110px;
  height: 100%;
  text-align: left;
  vertical-align: baseline;
}
.player-info-value {
  height: 100%;
  text-align: left;
  vertical-align: baseline;
}
.horizontal-buttons {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 5px;
  margin-top: 5px;
}
</style>
