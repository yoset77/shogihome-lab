import { DatabaseSync, type StatementSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import {
  UNCLASSIFIED_STRATEGY,
  type SearchableStrategy,
  type StrategySearchFilter,
  type StrategySource,
} from "@/common/kifu/strategy_taxonomy";

let db: DatabaseSync | null = null;
let insertKifuFileStmt: StatementSync | null = null;
let updateKifuFileStmt: StatementSync | null = null;
let updateKifuStrategyStmt: StatementSync | null = null;
let deleteKifuFileStmt: StatementSync | null = null;
let getKifuFileIdStmt: StatementSync | null = null;
let getKifuFileByPathStmt: StatementSync | null = null;
let getAllKifuFilePathsStmt: StatementSync | null = null;
let insertPositionStmt: StatementSync | null = null;
let getPositionIdStmt: StatementSync | null = null;
let insertKifuPositionStmt: StatementSync | null = null;
let deleteKifuPositionsStmt: StatementSync | null = null;
let getKifuPositionIdsStmt: StatementSync | null = null;
let deleteOrphanedPositionStmt: StatementSync | null = null;
let getKifuCountStmt: StatementSync | null = null;

export function initDatabase(dataDir: string) {
  try {
    if (db) {
      closeDatabase();
    }
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const dbPath = path.join(dataDir, "kifu_index.db");
    db = new DatabaseSync(dbPath, { timeout: 5000 });

    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");

    db.exec("BEGIN IMMEDIATE");
    db.exec(`
      CREATE TABLE IF NOT EXISTS kifu_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT UNIQUE NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        black_name TEXT,
        white_name TEXT,
        start_date TEXT,
        event TEXT,
        strategy TEXT,
        strategy_raw TEXT,
        strategy_source TEXT,
        strategy_score REAL,
        strategy_classifier_version TEXT,
        strategy_index_version INTEGER NOT NULL DEFAULT 0,
        indexed_at INTEGER NOT NULL
      )
    `);
    migrateKifuIndexSchema();

    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_kifu_files_metadata ON kifu_files(black_name, white_name, start_date, event);",
    );

    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_kifu_files_sort ON kifu_files(start_date DESC, indexed_at DESC);",
    );
    db.exec("CREATE INDEX IF NOT EXISTS idx_kifu_files_strategy ON kifu_files(strategy);");

    db.exec(`
      CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sfen_hash INTEGER NOT NULL,
        sfen TEXT UNIQUE NOT NULL
      )
    `);

    db.exec("CREATE INDEX IF NOT EXISTS idx_positions_hash ON positions(sfen_hash);");

    db.exec(`
      CREATE TABLE IF NOT EXISTS kifu_positions (
        kifu_id INTEGER NOT NULL,
        position_id INTEGER NOT NULL,
        ply INTEGER NOT NULL,
        PRIMARY KEY (kifu_id, position_id),
        FOREIGN KEY (kifu_id) REFERENCES kifu_files(id) ON DELETE CASCADE,
        FOREIGN KEY (position_id) REFERENCES positions(id) ON DELETE CASCADE
      )
    `);

    db.exec("CREATE INDEX IF NOT EXISTS idx_kifu_positions_lookup ON kifu_positions(position_id);");
    db.exec("COMMIT");

    insertKifuFileStmt = db.prepare(`
      INSERT INTO kifu_files (
        file_path, mtime, size, black_name, white_name, start_date, event,
        strategy, strategy_raw, strategy_source, strategy_score, strategy_classifier_version,
        strategy_index_version, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    updateKifuFileStmt = db.prepare(`
      UPDATE kifu_files SET
        mtime = ?, size = ?, black_name = ?, white_name = ?, start_date = ?, event = ?,
        strategy = ?, strategy_raw = ?, strategy_source = ?, strategy_score = ?,
        strategy_classifier_version = ?, strategy_index_version = ?, indexed_at = ?
      WHERE id = ?
    `);
    updateKifuStrategyStmt = db.prepare(`
      UPDATE kifu_files SET
        strategy = ?, strategy_raw = ?, strategy_source = ?, strategy_score = ?,
        strategy_classifier_version = ?, strategy_index_version = ?, indexed_at = ?
      WHERE file_path = ?
    `);
    deleteKifuFileStmt = db.prepare("DELETE FROM kifu_files WHERE file_path = ?");
    getKifuFileIdStmt = db.prepare("SELECT id FROM kifu_files WHERE file_path = ?");
    getKifuFileByPathStmt = db.prepare("SELECT * FROM kifu_files WHERE file_path = ?");
    getAllKifuFilePathsStmt = db.prepare("SELECT file_path FROM kifu_files");
    insertPositionStmt = db.prepare(
      "INSERT OR IGNORE INTO positions (sfen_hash, sfen) VALUES (?, ?)",
    );
    getPositionIdStmt = db.prepare("SELECT id FROM positions WHERE sfen_hash = ? AND sfen = ?");
    insertKifuPositionStmt = db.prepare(`
      INSERT OR IGNORE INTO kifu_positions (kifu_id, position_id, ply)
      VALUES (?, ?, ?)
    `);
    deleteKifuPositionsStmt = db.prepare("DELETE FROM kifu_positions WHERE kifu_id = ?");
    getKifuPositionIdsStmt = db.prepare("SELECT position_id FROM kifu_positions WHERE kifu_id = ?");
    deleteOrphanedPositionStmt = db.prepare(`
      DELETE FROM positions
      WHERE id = ?
        AND NOT EXISTS (
          SELECT 1 FROM kifu_positions WHERE kifu_positions.position_id = positions.id
        )
    `);
    getKifuCountStmt = db.prepare("SELECT COUNT(*) as count FROM kifu_files");
  } catch (e) {
    try {
      db?.close();
    } catch {
      // Preserve the initialization error.
    }
    console.error("Failed to initialize kifu index database:", e);
    insertKifuFileStmt = null;
    updateKifuFileStmt = null;
    updateKifuStrategyStmt = null;
    deleteKifuFileStmt = null;
    getKifuFileIdStmt = null;
    getKifuFileByPathStmt = null;
    getAllKifuFilePathsStmt = null;
    insertPositionStmt = null;
    getPositionIdStmt = null;
    insertKifuPositionStmt = null;
    deleteKifuPositionsStmt = null;
    getKifuPositionIdsStmt = null;
    deleteOrphanedPositionStmt = null;
    getKifuCountStmt = null;
    db = null;
  }
}

export function closeDatabase() {
  insertKifuFileStmt = null;
  updateKifuFileStmt = null;
  updateKifuStrategyStmt = null;
  deleteKifuFileStmt = null;
  getKifuFileIdStmt = null;
  getKifuFileByPathStmt = null;
  getAllKifuFilePathsStmt = null;
  insertPositionStmt = null;
  getPositionIdStmt = null;
  insertKifuPositionStmt = null;
  deleteKifuPositionsStmt = null;
  getKifuPositionIdsStmt = null;
  deleteOrphanedPositionStmt = null;
  getKifuCountStmt = null;
  if (db) {
    db.close();
    db = null;
  }
}

export interface KifuFileMetadata {
  file_path: string;
  mtime: number;
  size: number;
  black_name?: string;
  white_name?: string;
  start_date?: string;
  event?: string;
  strategy?: SearchableStrategy;
  strategy_raw?: string;
  strategy_source?: StrategySource;
  strategy_score?: number;
  strategy_classifier_version?: string;
  strategy_index_version?: number;
  indexed_at: number;
}

interface KifuSearchResult extends Omit<
  KifuFileMetadata,
  "strategy_score" | "strategy_classifier_version" | "strategy_index_version"
> {
  id: number;
  matched_ply?: number;
  matched_sfen?: string;
}

export interface KifuPositionData {
  sfen_hash: bigint;
  sfen: string;
  ply: number;
}

export interface KifuSearchParams {
  sfenHash?: bigint;
  sfen?: string;
  keyword?: string;
  player1?: string;
  player2?: string;
  isStrictTurn?: boolean;
  startDate?: string;
  strategy?: StrategySearchFilter;
  limit?: number;
  offset?: number;
}

type KifuSearchValue = string | number | bigint;

interface KifuSearchSql {
  from: string;
  where: string;
  args: KifuSearchValue[];
  isPositionSearch: boolean;
}

const KIFU_SEARCH_ORDER = " ORDER BY f.start_date DESC NULLS LAST, f.indexed_at DESC, f.id DESC";

function getKifuPositionIds(kifuId: number): number[] {
  const rows = getKifuPositionIdsStmt?.all(kifuId) ?? [];
  return rows
    .map((row) => Number(row.position_id))
    .filter((positionId) => Number.isSafeInteger(positionId));
}

const KIFU_INDEX_SCHEMA_VERSION = 1;

function migrateKifuIndexSchema() {
  if (!db) return;
  const currentVersion = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (currentVersion > KIFU_INDEX_SCHEMA_VERSION) {
    throw new Error(`Unsupported kifu index schema version: ${currentVersion}`);
  }
  if (currentVersion === KIFU_INDEX_SCHEMA_VERSION) return;
  const columns = db.prepare("PRAGMA table_info(kifu_files)").all() as { name: string }[];
  const columnNames = new Set(columns.map((column) => column.name));
  const additions = [
    ["strategy", "TEXT"],
    ["strategy_raw", "TEXT"],
    ["strategy_source", "TEXT"],
    ["strategy_score", "REAL"],
    ["strategy_classifier_version", "TEXT"],
    ["strategy_index_version", "INTEGER NOT NULL DEFAULT 0"],
  ] as const;
  for (const [name, type] of additions) {
    if (!columnNames.has(name)) {
      db.exec(`ALTER TABLE kifu_files ADD COLUMN ${name} ${type}`);
    }
  }
  // Earlier experimental columns may contain unvalidated labels or rejected candidates.
  // Force every existing row through the current pipeline before exposing strategy filters.
  db.exec(`
    UPDATE kifu_files
    SET strategy = NULL,
        strategy_raw = NULL,
        strategy_source = NULL,
        strategy_score = NULL,
        strategy_classifier_version = NULL,
        strategy_index_version = 0
  `);
  db.exec(`PRAGMA user_version = ${KIFU_INDEX_SCHEMA_VERSION}`);
}

export function upsertKifuFile(
  metadata: Omit<KifuFileMetadata, "indexed_at">,
  positions: KifuPositionData[],
) {
  if (!db) return;
  const now = Date.now();

  try {
    db.exec("BEGIN IMMEDIATE");

    // Check if file already exists
    const existing = getKifuFileIdStmt?.get(metadata.file_path) as { id: number } | undefined;

    let kifuId: number;
    let previousPositionIds: number[] = [];
    if (existing) {
      kifuId = existing.id;
      previousPositionIds = getKifuPositionIds(kifuId);
      deleteKifuPositionsStmt?.run(kifuId);

      updateKifuFileStmt?.run(
        metadata.mtime,
        metadata.size,
        metadata.black_name ?? null,
        metadata.white_name ?? null,
        metadata.start_date ?? null,
        metadata.event ?? null,
        metadata.strategy ?? null,
        metadata.strategy_raw ?? null,
        metadata.strategy_source ?? null,
        metadata.strategy_score ?? null,
        metadata.strategy_classifier_version ?? null,
        metadata.strategy_index_version ?? 0,
        now,
        kifuId,
      );
    } else {
      const result = insertKifuFileStmt?.run(
        metadata.file_path,
        metadata.mtime,
        metadata.size,
        metadata.black_name ?? null,
        metadata.white_name ?? null,
        metadata.start_date ?? null,
        metadata.event ?? null,
        metadata.strategy ?? null,
        metadata.strategy_raw ?? null,
        metadata.strategy_source ?? null,
        metadata.strategy_score ?? null,
        metadata.strategy_classifier_version ?? null,
        metadata.strategy_index_version ?? 0,
        now,
      );
      kifuId = Number(result?.lastInsertRowid);
    }

    for (const pos of positions) {
      insertPositionStmt?.run(pos.sfen_hash, pos.sfen);
      const posRow = getPositionIdStmt?.get(pos.sfen_hash, pos.sfen) as { id: number } | undefined;
      if (posRow) {
        insertKifuPositionStmt?.run(kifuId, posRow.id, pos.ply);
      }
    }

    for (const positionId of previousPositionIds) {
      deleteOrphanedPositionStmt?.run(positionId);
    }

    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback errors to preserve original error
    }
    console.error("Failed to upsert kifu file to DB:", e);
    throw e;
  }
}

export function updateKifuFileStrategy(metadata: Omit<KifuFileMetadata, "indexed_at">) {
  if (!db || metadata.strategy_index_version === undefined) return;
  try {
    updateKifuStrategyStmt?.run(
      metadata.strategy ?? null,
      metadata.strategy_raw ?? null,
      metadata.strategy_source ?? null,
      metadata.strategy_score ?? null,
      metadata.strategy_classifier_version ?? null,
      metadata.strategy_index_version,
      Date.now(),
      metadata.file_path,
    );
  } catch (e) {
    console.error("Failed to update kifu strategy:", e);
    throw e;
  }
}

export function deleteKifuFile(filePath: string) {
  if (!db) return;
  try {
    db.exec("BEGIN IMMEDIATE");

    const existing = getKifuFileIdStmt?.get(filePath) as { id: number } | undefined;
    const previousPositionIds = existing ? getKifuPositionIds(existing.id) : [];

    deleteKifuFileStmt?.run(filePath);

    for (const positionId of previousPositionIds) {
      deleteOrphanedPositionStmt?.run(positionId);
    }

    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback errors to preserve original error
    }
    console.error("Failed to delete kifu file from DB:", e);
    throw e;
  }
}

export function getKifuFileByPath(
  filePath: string,
): (KifuFileMetadata & { id: number }) | undefined {
  if (!db) return;
  return getKifuFileByPathStmt?.get(filePath) as (KifuFileMetadata & { id: number }) | undefined;
}

export function getAllKifuFilePaths(): string[] {
  if (!db) return [];
  const rows = getAllKifuFilePathsStmt?.all() as { file_path: string }[];
  return rows.map((r) => r.file_path);
}

function buildKifuSearchSql(params: KifuSearchParams): KifuSearchSql {
  const isPositionSearch = params.sfenHash !== undefined && params.sfen !== undefined;
  let from = " FROM kifu_files f";
  const conditions: string[] = [];
  const args: KifuSearchValue[] = [];

  if (isPositionSearch) {
    from += ` JOIN kifu_positions kp ON f.id = kp.kifu_id
              JOIN positions p ON kp.position_id = p.id`;
    conditions.push("p.sfen_hash = ? AND p.sfen = ?");
    args.push(params.sfenHash as bigint, params.sfen as string);
  }

  if (params.keyword) {
    const keywords = params.keyword.split(/\s+/).filter((k) => k.length > 0);
    for (const keyword of keywords) {
      const kw = `%${keyword}%`;
      conditions.push(
        "(f.black_name LIKE ? OR f.white_name LIKE ? OR f.event LIKE ? OR f.file_path LIKE ?)",
      );
      args.push(kw, kw, kw, kw);
    }
  }

  if (params.player1 && params.player2) {
    const p1 = `%${params.player1}%`;
    const p2 = `%${params.player2}%`;
    if (params.isStrictTurn) {
      conditions.push("(f.black_name LIKE ? AND f.white_name LIKE ?)");
      args.push(p1, p2);
    } else {
      conditions.push(
        "((f.black_name LIKE ? AND f.white_name LIKE ?) OR (f.black_name LIKE ? AND f.white_name LIKE ?))",
      );
      args.push(p1, p2, p2, p1);
    }
  } else if (params.player1) {
    const p1 = `%${params.player1}%`;
    if (params.isStrictTurn) {
      conditions.push("f.black_name LIKE ?");
      args.push(p1);
    } else {
      conditions.push("(f.black_name LIKE ? OR f.white_name LIKE ?)");
      args.push(p1, p1);
    }
  } else if (params.player2) {
    const p2 = `%${params.player2}%`;
    if (params.isStrictTurn) {
      conditions.push("f.white_name LIKE ?");
      args.push(p2);
    } else {
      conditions.push("(f.black_name LIKE ? OR f.white_name LIKE ?)");
      args.push(p2, p2);
    }
  }

  if (params.startDate) {
    conditions.push("f.start_date LIKE ?");
    args.push(`${params.startDate}%`);
  }

  if (params.strategy === UNCLASSIFIED_STRATEGY) {
    conditions.push("f.strategy IS NULL AND f.strategy_raw IS NULL");
  } else if (params.strategy) {
    conditions.push("f.strategy = ?");
    args.push(params.strategy);
  }

  return {
    from,
    where: conditions.length > 0 ? " WHERE " + conditions.join(" AND ") : "",
    args,
    isPositionSearch,
  };
}

export function searchKifu(params: KifuSearchParams) {
  if (!db) return [];
  const limit = params.limit ?? 100;
  const offset = params.offset ?? 0;
  const searchSql = buildKifuSearchSql(params);

  let query = `SELECT f.id, f.file_path, f.mtime, f.size, f.black_name, f.white_name, f.start_date,
    f.event, f.strategy, f.strategy_raw, f.strategy_source, f.indexed_at${
      searchSql.isPositionSearch ? ", MIN(kp.ply) as matched_ply, p.sfen as matched_sfen" : ""
    }${searchSql.from}${searchSql.where}`;

  if (searchSql.isPositionSearch) {
    query += " GROUP BY f.id";
  }

  query += KIFU_SEARCH_ORDER + " LIMIT ? OFFSET ?";

  try {
    const stmt = db.prepare(query);
    return stmt.all(...searchSql.args, limit, offset) as unknown as KifuSearchResult[];
  } catch (e) {
    console.error("Failed to search kifu:", e);
    return [];
  }
}

export function getKifuSearchCount(params: KifuSearchParams): number {
  if (!db) return 0;
  const searchSql = buildKifuSearchSql(params);
  const query = `SELECT COUNT(DISTINCT f.id) as count${searchSql.from}${searchSql.where}`;

  try {
    const result = db.prepare(query).get(...searchSql.args) as { count: number } | undefined;
    return result?.count ?? 0;
  } catch (e) {
    console.error("Failed to count kifu search results:", e);
    return 0;
  }
}

export function getKifuSearchFilePaths(params: KifuSearchParams): string[] {
  if (!db) return [];
  const searchSql = buildKifuSearchSql(params);
  let query = `SELECT f.file_path${searchSql.from}${searchSql.where}`;
  if (searchSql.isPositionSearch) {
    query += " GROUP BY f.id";
  }
  query += KIFU_SEARCH_ORDER;

  try {
    const rows = db.prepare(query).all(...searchSql.args) as { file_path: string }[];
    return rows.map((row) => row.file_path);
  } catch (e) {
    console.error("Failed to get kifu search file paths:", e);
    return [];
  }
}

export function getKifuCount(): number {
  if (!db) return 0;
  const result = getKifuCountStmt?.get() as { count: number } | undefined;
  return result?.count ?? 0;
}

export function cleanupOrphanedPositions() {
  if (!db) return;
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec(
      "DELETE FROM positions WHERE NOT EXISTS (SELECT 1 FROM kifu_positions WHERE kifu_positions.position_id = positions.id)",
    );
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback errors to preserve original error
    }
    console.error("Failed to cleanup orphaned positions:", e);
  }
}
