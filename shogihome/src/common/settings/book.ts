import { detectRecordFileFormatByPath } from "@/common/file/record";
import { t } from "@/common/i18n/index";

export enum SourceType {
  DIRECTORY = "directory",
  FILE = "file",
}

export enum PlayerCriteria {
  ALL = "all",
  BLACK = "black",
  WHITE = "white",
  FILTER_BY_NAME = "filterByName",
}

export type BookImportSettings = {
  sourceType: SourceType;
  sourceDirectory: string;
  sourceRecordFile: string;
  minPly: number;
  maxPly: number;
  playerCriteria: PlayerCriteria;
  playerName?: string;
  importScore: boolean;
};

export function defaultBookImportSettings(): BookImportSettings {
  return {
    sourceType: SourceType.FILE,
    sourceDirectory: "",
    sourceRecordFile: "",
    minPly: 0,
    maxPly: 100,
    playerCriteria: PlayerCriteria.ALL,
    importScore: true,
  };
}

export function normalizeBookImportSettings(settings: BookImportSettings): BookImportSettings {
  const merged = {
    ...defaultBookImportSettings(),
    ...settings,
  };
  if (merged.sourceType !== SourceType.FILE && merged.sourceType !== SourceType.DIRECTORY) {
    merged.sourceType = SourceType.FILE;
  }
  return merged;
}

export function validateBookImportSettings(settings: BookImportSettings): Error | undefined {
  if (settings.sourceType === SourceType.FILE) {
    if (!settings.sourceRecordFile) {
      return new Error(t.sourceRecordFileNotSet);
    }
    const format = detectRecordFileFormatByPath(settings.sourceRecordFile);
    if (!format) {
      return new Error(t.unexpectedRecordFileExtension(settings.sourceRecordFile));
    }
  } else if (settings.sourceType === SourceType.DIRECTORY) {
    if (!settings.sourceDirectory) {
      return new Error(t.sourceDirectoryNotSet);
    }
  } else {
    return new Error("invalid source type");
  }

  if (settings.minPly < 0) {
    return new Error("min ply must be greater than or equal to 0");
  }

  if (settings.maxPly < 0) {
    return new Error("max ply must be greater than or equal to 0");
  }

  if (settings.minPly > settings.maxPly) {
    return new Error(t.minPlyMustBeLessThanMaxPly);
  }

  if (settings.playerCriteria === PlayerCriteria.FILTER_BY_NAME) {
    if (!settings.playerName) {
      return new Error(t.playerNameNotSet);
    }
  }
}
