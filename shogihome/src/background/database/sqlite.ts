import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { USIInfoCommand } from "@/common/game/usi.js";

let db: DatabaseSync | null = null;

export function initDatabase(dataDir: string) {
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const dbPath = path.join(dataDir, "analysis.db");
    // Node.js v24 から利用可能な timeout オプションを指定し、
    // 書き込み競合時の「database is locked」エラーを緩和します。
    // 同期APIを使用していますが、書き込み頻度が低いためメインスレッドへの影響は限定的です。
    db = new DatabaseSync(dbPath, { timeout: 5000 });

    // 外部キー制約を有効化
    db.exec("PRAGMA foreign_keys = ON;");

    // 高速化とイベントループのブロック軽減のためWALモードを有効化
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");

    db.exec(`
      CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sfen_hash INTEGER NOT NULL,
        sfen TEXT UNIQUE NOT NULL
      )
    `);

    db.exec("CREATE INDEX IF NOT EXISTS idx_positions_hash ON positions(sfen_hash);");

    db.exec(`
      CREATE TABLE IF NOT EXISTS engines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        engine_key TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS analysis_results (
        position_id INTEGER NOT NULL,
        engine_id INTEGER NOT NULL,
        multipv INTEGER NOT NULL,
        depth INTEGER NOT NULL,
        seldepth INTEGER,
        nodes INTEGER,
        score_cp INTEGER,
        score_mate INTEGER,
        pv TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (position_id, engine_id, multipv),
        FOREIGN KEY(position_id) REFERENCES positions(id),
        FOREIGN KEY(engine_id) REFERENCES engines(id)
      )
    `);
  } catch (e) {
    console.error("Failed to initialize analysis database:", e);
    db = null;
  }
}

export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

export function saveAnalysisResults(
  sfenHash: bigint,
  sfen: string,
  engineKey: string,
  engineName: string,
  infos: Map<number, USIInfoCommand>,
) {
  if (!db || infos.size === 0) return;
  const conn = db;

  const now = Date.now();

  try {
    // トランザクション内で3テーブルの更新を一括処理
    conn.exec("BEGIN IMMEDIATE");

    // 1. 局面の確保 (存在しない場合は挿入)
    const insertPosition = conn.prepare(
      "INSERT OR IGNORE INTO positions (sfen_hash, sfen) VALUES (?, ?)",
    );
    insertPosition.run(sfenHash, sfen);

    // position_id の取得 (ハッシュと文字列の両方で完全一致を確認)
    const getPosition = conn.prepare("SELECT id FROM positions WHERE sfen_hash = ? AND sfen = ?");
    const positionRow = getPosition.get(sfenHash, sfen) as { id: number };
    if (!positionRow) throw new Error("Failed to get position_id");
    const positionId = positionRow.id;

    // 2. エンジンの確保 (存在しない場合は挿入、存在する場合は表示名が古ければ更新)
    const insertEngine = conn.prepare(
      "INSERT OR IGNORE INTO engines (engine_key, name) VALUES (?, ?)",
    );
    insertEngine.run(engineKey, engineName);

    // 表示名の更新 (変更があった場合)
    const updateEngine = conn.prepare(
      "UPDATE engines SET name = ? WHERE engine_key = ? AND name != ?",
    );
    updateEngine.run(engineName, engineKey, engineName);

    // engine_id の取得
    const getEngine = conn.prepare("SELECT id FROM engines WHERE engine_key = ?");
    const engineRow = getEngine.get(engineKey) as { id: number };
    if (!engineRow) throw new Error("Failed to get engine_id");
    const engineId = engineRow.id;

    // 3. 検討結果の保存 (深さが深い場合のみ更新)
    const upsertResult = conn.prepare(`
      INSERT INTO analysis_results (
        position_id, engine_id, multipv, depth, seldepth, nodes, score_cp, score_mate, pv, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(position_id, engine_id, multipv) DO UPDATE SET
        depth = excluded.depth,
        seldepth = excluded.seldepth,
        nodes = excluded.nodes,
        score_cp = excluded.score_cp,
        score_mate = excluded.score_mate,
        pv = excluded.pv,
        updated_at = excluded.updated_at
      WHERE excluded.depth > analysis_results.depth
    `);

    for (const [multipv, info] of infos.entries()) {
      if (info.depth === undefined) continue;

      upsertResult.run(
        positionId,
        engineId,
        multipv,
        info.depth,
        info.seldepth ?? null,
        info.nodes ?? null,
        info.scoreCP ?? null,
        info.scoreMate ?? null,
        info.pv ? info.pv.join(" ") : null,
        now,
      );
    }

    conn.exec("COMMIT");
  } catch (e) {
    try {
      db?.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    console.error("Failed to save analysis results to DB:", e);
  }
}

export interface DBAnalysisResult {
  engine_name: string;
  multipv: number;
  depth: number;
  seldepth: number | null;
  nodes: number | null;
  score_cp: number | null;
  score_mate: number | null;
  pv: string | null;
  updated_at: number;
}

export function getAnalysisResults(sfenHash: bigint, sfen: string): DBAnalysisResult[] {
  if (!db) return [];
  const conn = db;

  try {
    const stmt = conn.prepare(`
      SELECT
        e.name as engine_name,
        r.multipv,
        r.depth,
        r.seldepth,
        r.nodes,
        r.score_cp,
        r.score_mate,
        r.pv,
        r.updated_at
      FROM analysis_results r
      JOIN engines e ON r.engine_id = e.id
      JOIN positions p ON r.position_id = p.id
      WHERE p.sfen_hash = ? AND p.sfen = ?
      ORDER BY
        r.multipv ASC,
        r.depth DESC,
        (r.score_mate IS NOT NULL) DESC,
        r.score_cp DESC,
        r.updated_at DESC
    `);

    // BigInt と 文字列の両方を渡す。
    return stmt.all(sfenHash, sfen) as unknown as DBAnalysisResult[];
  } catch (e) {
    console.error("Failed to get analysis results from DB:", e);
    return [];
  }
}
