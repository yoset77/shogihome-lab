import { ResearchSettings } from "@/common/settings/research";
import { testUSIEngine } from "./usi.js";

export const researchSettings: ResearchSettings = {
  usi: testUSIEngine,
  enableMaxSeconds: false,
  maxSeconds: 5,
  overrideMultiPV: false,
  multiPV: 1,
};
