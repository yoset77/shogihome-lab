import type { RecordCustomData } from "./types";
import { SCORE_MATE_INFINITE } from "@/common/game/usi";

function parsePlayerMateScoreComment(line: string): number | undefined {
  const matched = /^\*詰み=(先手勝ち|後手勝ち)(?::([0-9]+)手)?/.exec(line);
  if (matched) {
    return Number(matched[2] || SCORE_MATE_INFINITE) * (matched[1] === "先手勝ち" ? 1 : -1);
  }
}

function parseResearchMateScoreComment(line: string): number | undefined {
  const matched = /^#詰み=(先手勝ち|後手勝ち)(?::([0-9]+)手)?/.exec(line);
  if (matched) {
    return Number(matched[2] || SCORE_MATE_INFINITE) * (matched[1] === "先手勝ち" ? 1 : -1);
  }
}

function parsePlayerScoreComment(line: string): number | undefined {
  const matched = /^\*評価値=([+-]?[0-9]+(?:\.[0-9]+)?)/.exec(line);
  return matched ? Number(matched[1]) : undefined;
}

function parseResearchScoreComment(line: string): number | undefined {
  const matched = /^#評価値=([+-]?[0-9]+(?:\.[0-9]+)?)/.exec(line);
  return matched ? Number(matched[1]) : undefined;
}

function parseFloodgateScoreComment(line: string): number | undefined {
  const matched = /^\* *([+-]?[0-9]+(?:\.[0-9]+)?)/.exec(line);
  return matched ? Number(matched[1]) : undefined;
}

function parseShogiGUIPlayerScoreComment(line: string): number | undefined {
  const matched = /^\*対局 .* 評価値 ([+-]?[0-9]+)/.exec(line);
  return matched ? Number(matched[1]) : undefined;
}

function parseShogiGUIAnalysisScoreComment(line: string): number | undefined {
  const matched = /^\*解析 .* 評価値 ([+-]?[0-9]+)/.exec(line);
  return matched ? Number(matched[1]) : undefined;
}

function parseKishinAnalyticsScoreComment(line: string): number | undefined {
  const matched = /^\* .* 評価値 ([+-]?[0-9]+)/.exec(line);
  return matched ? Number(matched[1]) : undefined;
}

function parseKShogiPlayerScoreComment(line: string): number | undefined {
  const matched = /^#(?:形勢|指し手)\[([+-]?[0-9]+)\]/.exec(line);
  return matched ? Number(matched[1]) : undefined;
}

function parsePlayerDepthComment(line: string): number | undefined {
  const matched = /^\*深さ=([0-9]+)/.exec(line);
  return matched ? Number(matched[1]) : undefined;
}

function parseResearchDepthComment(line: string): number | undefined {
  const matched = /^#深さ=([0-9]+)/.exec(line);
  return matched ? Number(matched[1]) : undefined;
}

function parseShogiGUIPlayerDepthComment(line: string): number | undefined {
  if (!/^\*対局 /.test(line)) {
    return undefined;
  }
  const matched = / 深さ ([0-9]+)/.exec(line);
  return matched ? Number(matched[1]) : undefined;
}

function parseShogiGUIAnalysisDepthComment(line: string): number | undefined {
  if (!/^\*解析 /.test(line)) {
    return undefined;
  }
  const matched = / 深さ ([0-9]+)/.exec(line);
  return matched ? Number(matched[1]) : undefined;
}

export function parseComment(comment: string, base: RecordCustomData = {}): RecordCustomData {
  const data = { ...base };
  const lines = comment.split("\n");
  for (const line of lines) {
    const playerMateScore = parsePlayerMateScoreComment(line);
    if (playerMateScore !== undefined) {
      data.playerSearchInfo = {
        ...data.playerSearchInfo,
        mate: playerMateScore,
      };
    }
    const researchMateScore = parseResearchMateScoreComment(line);
    if (researchMateScore !== undefined) {
      data.researchInfo = {
        ...data.researchInfo,
        mate: researchMateScore,
      };
    }
    const playerScore =
      parsePlayerScoreComment(line) ??
      parseFloodgateScoreComment(line) ??
      parseShogiGUIPlayerScoreComment(line);
    if (playerScore !== undefined) {
      data.playerSearchInfo = {
        ...data.playerSearchInfo,
        score: playerScore,
      };
    }
    const researchScore =
      parseResearchScoreComment(line) ??
      parseShogiGUIAnalysisScoreComment(line) ??
      parseKishinAnalyticsScoreComment(line) ??
      parseKShogiPlayerScoreComment(line);
    if (researchScore !== undefined) {
      data.researchInfo = {
        ...data.researchInfo,
        score: researchScore,
      };
    }
    const playerDepth = parsePlayerDepthComment(line) ?? parseShogiGUIPlayerDepthComment(line);
    if (playerDepth !== undefined) {
      data.playerSearchInfo = {
        ...data.playerSearchInfo,
        depth: playerDepth,
      };
    }
    const researchDepth =
      parseResearchDepthComment(line) ?? parseShogiGUIAnalysisDepthComment(line);
    if (researchDepth !== undefined) {
      data.researchInfo = {
        ...data.researchInfo,
        depth: researchDepth,
      };
    }
  }
  return data;
}
