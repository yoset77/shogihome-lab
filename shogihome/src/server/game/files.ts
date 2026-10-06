import fs from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import { exportRecordAsBuffer } from "@/common/file/record";
import { generateRecordFileName } from "@/common/file/name";
import { restoreRecord, type RecordSnapshot } from "@/common/record/snapshot";
import type { GameSaveOptions } from "@/common/game/protocol";
import { KIFU_DIR } from "@/server/config";
import {
  clearKifuListCache,
  resolveKifuPath,
  resolveKifuDirectory,
  resolveWritableKifuPath,
  getServerFileKind,
} from "@/server/helpers/kifu";
import { writeStreamAtomic } from "@/server/file/atomic_stream";
import { HttpError } from "@/server/errors";
import { t } from "@/common/i18n";

export async function loadGamePositions(uri: string): Promise<string[]> {
  const file =
    KIFU_DIR &&
    uri.startsWith("server://") &&
    getServerFileKind(uri.substring(9)) === "sfen" &&
    resolveKifuPath(KIFU_DIR, uri.substring(9));
  if (!file) throw new Error("Invalid position list path");
  const stat = await fs.stat(file);
  if (stat.size > 4 * 1024 * 1024) throw new Error("Position list is too large");
  const lines = (await fs.readFile(file, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (lines.length > 10_000 || lines.some((line) => line.length > 32_768))
    throw new Error("Position list is too large");
  return lines;
}

export function validateGameSaveDirectory(options: GameSaveOptions): string {
  const directory = options.directory.startsWith("server://")
    ? options.directory.substring(9)
    : options.directory;
  if (!KIFU_DIR || !resolveKifuDirectory(KIFU_DIR, directory))
    throw new HttpError(400, t.gameInvalid);
  return directory;
}

/** Never overwrite another game, even when an external writer races the save. */
export async function saveGameRecord(
  source: RecordSnapshot,
  options: GameSaveOptions,
  suffix: string,
): Promise<string> {
  const directory = validateGameSaveDirectory(options);
  const record = restoreRecord(source).record;
  const name = generateRecordFileName(record, {
    template: options.template,
    extension: options.format,
  });
  const data = exportRecordAsBuffer(record, options.format, {
    returnCode: options.returnCode,
    csa: { v3: options.useCSAV3 },
    useUTF8ForKifAndKi2: options.useUTF8ForKifAndKi2,
  }).data;
  for (let index = 0; index < 100; index++) {
    const filename =
      index === 0
        ? name
        : `${name.slice(0, -options.format.length)}_${suffix}_${index}${options.format}`;
    const relative = directory ? `${directory}/${filename}` : filename;
    const target = KIFU_DIR && resolveWritableKifuPath(KIFU_DIR, "kifu", relative);
    if (!target) throw new Error("Invalid game save path");
    try {
      await writeStreamAtomic(
        target,
        async (stream) => {
          stream.end(data);
          await finished(stream);
        },
        {
          overwrite: false,
          beforePublish: async () => {
            if (resolveWritableKifuPath(KIFU_DIR!, "kifu", relative) !== target)
              throw new Error("Game save path changed");
          },
          onPublished: clearKifuListCache,
        },
      );
      return path.posix.normalize(relative);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("Game filename collision limit reached");
}
