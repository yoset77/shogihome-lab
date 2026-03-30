import { Record, Position } from "tsshogi";
import { hash as aperyHash } from "@/background/book/apery_zobrist.js";

/**
 * USIの position コマンド (例: "position startpos moves 7g7f ...") をパースし、
 * 最終的な局面の「手数を除外した正規化SFEN」と、その64bit Zobrist Hash（符号付き整数）を返します。
 *
 * @param usiPositionCommand USIの position コマンド文字列、または生のSFEN文字列
 */
export function getNormalizedSfenAndHash(usiPositionCommand: string): {
  sfen: string;
  hash: bigint; // Signed 64-bit integer
} | null {
  try {
    let record: Record | Error;

    if (usiPositionCommand.startsWith("position ")) {
      record = Record.newByUSI(usiPositionCommand);
    } else if (usiPositionCommand.startsWith("sfen ")) {
      record = Record.newByUSI("position " + usiPositionCommand);
    } else if (usiPositionCommand.startsWith("startpos")) {
      record = Record.newByUSI("position " + usiPositionCommand);
    } else {
      // 生のSFEN文字列とみなす
      const position = Position.newBySFEN(usiPositionCommand);
      if (!position) {
        console.warn("Invalid SFEN string:", usiPositionCommand);
        return null;
      }
      record = new Record(position);
    }

    if (record instanceof Error) {
      console.warn("Failed to parse position:", record.message, `(input: ${usiPositionCommand})`);
      return null;
    }

    // 終端局面のSFENを取得 (例: "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1")
    const leafSfen = record.position.sfen;

    // ハッシュ計算。aperyHashは通常の手数付きSFEN文字列を受け付ける
    const unsignedHash = aperyHash(leafSfen);

    // node:sqlite の INTEGER に安全に格納するため、64bit 符号付き整数に変換する
    const signedHash = BigInt.asIntN(64, unsignedHash);

    // 末尾の手数 (" \d+$") を除外したものを正規化SFENとして保存する
    // 例: "... b - 1" -> "... b -"
    const normalizedSfen = leafSfen.replace(/\s+\d+$/, "");

    return {
      sfen: normalizedSfen,
      hash: signedHash,
    };
  } catch (e) {
    console.warn("Exception during getNormalizedSfenAndHash:", e);
    return null;
  }
}
