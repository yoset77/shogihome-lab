import { emptyUSIEngineExtraBookConfig, type USIEngine } from "@/common/settings/usi";

export const testUSIEngine: USIEngine = {
  uri: "lan-engine:test-engine",
  name: "my usi engine",
  extraBook: emptyUSIEngineExtraBookConfig(),
};
