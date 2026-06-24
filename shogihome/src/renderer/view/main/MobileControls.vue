<template>
  <div>
    <div class="full row controls">
      <template v-if="store.appState === AppState.POSITION_EDITING">
        <button @click="store.changeTurn()">
          <Icon :icon="IconType.SWAP" />
        </button>
        <button @click="appSettings.flipBoard()">
          <Icon :icon="IconType.FLIP" />
        </button>
        <button @click="isInitialPositionMenuVisible = true">
          <Icon :icon="IconType.REFRESH" />
        </button>
        <button @click="store.showPieceSetChangeDialog()">
          <Icon :icon="IconType.EQUALIZER" />
        </button>
        <button @click="store.endPositionEditing()">
          <Icon :icon="IconType.CHECK" />
        </button>
      </template>
      <template v-else>
        <button @click="store.changePly(0)">
          <Icon :icon="IconType.FIRST" />
        </button>
        <button @click="store.goBack()">
          <Icon :icon="IconType.BACK" />
        </button>
        <button @click="store.goForward()">
          <Icon :icon="IconType.NEXT" />
        </button>
        <button @click="store.changePly(Number.MAX_SAFE_INTEGER)">
          <Icon :icon="IconType.LAST" />
        </button>
        <button @click="store.removeCurrentMove()"><Icon :icon="IconType.DELETE" /></button>
        <button @click="isMobileMenuVisible = true">Menu</button>
      </template>
    </div>
    <FileMenu v-if="isMobileMenuVisible" @close="isMobileMenuVisible = false" />
    <InitialPositionMenu
      v-if="isInitialPositionMenuVisible"
      @close="isInitialPositionMenuVisible = false"
    />
  </div>
</template>

<script setup lang="ts">
import { IconType } from "@/renderer/assets/icons";
import { useStore } from "@/renderer/store";
import { useAppSettings } from "@/renderer/store/settings";
import { AppState } from "@/common/control/state.js";
import Icon from "@/renderer/view/primitive/Icon.vue";
import FileMenu from "@/renderer/view/menu/FileMenu.vue";
import InitialPositionMenu from "@/renderer/view/menu/InitialPositionMenu.vue";
import { ref } from "vue";

const store = useStore();
const appSettings = useAppSettings();
const isMobileMenuVisible = ref(false);
const isInitialPositionMenuVisible = ref(false);
</script>

<style scoped>
.controls button {
  font-size: 100%;
  width: 100%;
  height: 100%;
}
.controls button .icon {
  height: 68%;
}
</style>
