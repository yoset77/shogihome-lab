import { DatabaseSync, type StatementSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

let db: DatabaseSync | null = null;
let insertKifuFileStmt: StatementSync | null = null;
let updateKifuFileStmt: StatementSync | null = null;
let deleteKifuFileStmt: StatementSync | null = null;
let getKifuFileIdStmt: StatementSync | null = null;
let getKifuFileByPathStmt: StatementSync | null = null;
let getAllKifuFilePathsStmt: StatementSync | null = null;
let insertPositionStmt: StatementSync | null = null;
let getPositionIdStmt: StatementSync | null = null;
let insertKifuPositionStmt: StatementSync | null = null;
let deleteKifuPositionsStmt: StatementSync | null = null;
let getKifuCountStmt: StatementSync | null = null;

export function initDatabase(dataDir: string) {
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const dbPath = path.join(dataDir, "kifu_index.db");
    db = new DatabaseSync(dbPath, { timeout: 5000 });

    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");

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
        indexed_at INTEGER NOT NULL
      )
    `);

    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_kifu_files_metadata ON kifu_files(black_name, white_name, start_date, event);",
    );

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

    insertKifuFileStmt = db.prepare(`
      INSERT INTO kifu_files (file_path, mtime, size, black_name, white_name, start_date, event, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    updateKifuFileStmt = db.prepare(`
      UPDATE kifu_files SET mtime = ?, size = ?, black_name = ?, white_name = ?, start_date = ?, event = ?, indexed_at = ?
      WHERE id = ?
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
    getKifuCountStmt = db.prepare("SELECT COUNT(*) as count FROM kifu_files");
  } catch (e) {
    console.error("Failed to initialize kifu index database:", e);
    db = null;
  }
}

export function closeDatabase() {
  insertKifuFileStmt = null;
  updateKifuFileStmt = null;
  deleteKifuFileStmt = null;
  getKifuFileIdStmt = null;
  getKifuFileByPathStmt = null;
  getAllKifuFilePathsStmt = null;
  insertPositionStmt = null;
  getPositionIdStmt = null;
  insertKifuPositionStmt = null;
  deleteKifuPositionsStmt = null;
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
  indexed_at: number;
}

export interface KifuPositionData {
  sfen_hash: bigint;
  sfen: string;
  ply: number;
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
    if (existing) {
      kifuId = existing.id;
      deleteKifuPositionsStmt?.run(kifuId);

      updateKifuFileStmt?.run(
        metadata.mtime,
        metadata.size,
        metadata.black_name ?? null,
        metadata.white_name ?? null,
        metadata.start_date ?? null,
        metadata.event ?? null,
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

export function deleteKifuFile(filePath: string) {
  if (!db) return;
  try {
    deleteKifuFileStmt?.run(filePath);
  } catch (e) {
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

export function searchKifu(params: {
  sfenHash?: bigint;
  sfen?: string;
  keyword?: string;
  startDate?: string;
  limit?: number;
  offset?: number;
}) {
  if (!db) return [];
  const limit = params.limit ?? 100;
  const offset = params.offset ?? 0;
  const isPositionSearch = params.sfenHash !== undefined && params.sfen !== undefined;

  let query = `
    SELECT f.*${isPositionSearch ? ", MIN(kp.ply) as matched_ply, p.sfen as matched_sfen" : ""}
    FROM kifu_files f
  `;
  const conditions: string[] = [];
  const args: (string | number | bigint)[] = [];

  if (isPositionSearch) {
    query += ` JOIN kifu_positions kp ON f.id = kp.kifu_id
               JOIN positions p ON kp.position_id = p.id `;
    conditions.push("p.sfen_hash = ? AND p.sfen = ?");
    args.push(params.sfenHash!, params.sfen!);
  }

  if (params.keyword) {
    const kw = `%${params.keyword}%`;
    conditions.push(
      "(f.black_name LIKE ? OR f.white_name LIKE ? OR f.event LIKE ? OR f.file_path LIKE ?)",
    );
    args.push(kw, kw, kw, kw);
  }

  if (params.startDate) {
    conditions.push("f.start_date LIKE ?");
    args.push(`${params.startDate}%`);
  }

  if (conditions.length > 0) {
    query += " WHERE " + conditions.join(" AND ");
  }

  if (isPositionSearch) {
    query += " GROUP BY f.id";
  }

  query += " ORDER BY f.start_date DESC NULLS LAST, f.indexed_at DESC LIMIT ? OFFSET ?";
  args.push(limit, offset);

  try {
    const stmt = db.prepare(query);
    return stmt.all(...args);
  } catch (e) {
    console.error("Failed to search kifu:", e);
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
