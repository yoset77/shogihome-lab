import { MateSearchSettings } from "@/common/settings/mate";
import { USIEngine } from "@/common/settings/usi";

const engine: USIEngine = {
  uri: "lan-engine:test-engine",
  name: "my usi engine",
};

export const mateSearchSettings: MateSearchSettings = {
  usi: engine,
  enableMaxSeconds: false,
  maxSeconds: 10,
};
