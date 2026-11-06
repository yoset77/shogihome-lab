import { readKifuSearchQuery } from "@/common/file/kifu_search";
import { t } from "@/common/i18n";
import { HttpError } from "@/server/errors";
import { getNormalizedSfenAndHash } from "@/server/usi/sfen";

export function normalizeKifuSearchQuery(value: unknown) {
  try {
    const query = readKifuSearchQuery(value);
    const position = query.sfen ? getNormalizedSfenAndHash(query.sfen) : undefined;
    if (query.sfen && !position) throw new Error("Invalid search position");
    return {
      ...query,
      sfen: position?.sfen,
      sfenHash: position?.hash,
    };
  } catch {
    throw new HttpError(400, t.serverInvalidKifuSearch);
  }
}
