import { AnalysisSettings } from "@/common/settings/analysis";
import { CommentBehavior } from "@/common/settings/comment";
import { USIEngine } from "@/common/settings/usi";

const engine: USIEngine = {
  uri: "lan-engine:test-engine",
  name: "my usi engine",
};

export const analysisSettings: AnalysisSettings = {
  overrideMultiPV: false,
  multiPV: 1,
  usi: engine,
  startCriteria: {
    enableNumber: false,
    number: 0,
  },
  endCriteria: {
    enableNumber: false,
    number: 100,
  },
  perMoveCriteria: {
    maxSeconds: 1,
  },
  descending: false,
  commentBehavior: CommentBehavior.APPEND,
};
