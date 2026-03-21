import { Record } from "tsshogi";
import { hash as aperyHash } from "@/background/book/apery_zobrist.js";

/**
 * USIの position コマンド (例: "position startpos moves 7g7f ...") をパースし、
 * 最終的な局面の「手数を除外した正規化SFEN」と、その64bit Zobrist Hash（符号付き整数）を返します。
 *
 * @param usiPositionCommand USIの position コマンド文字列
 */
export function getNormalizedSfenAndHash(usiPositionCommand: string): {
  sfen: string;
  hash: bigint; // Signed 64-bit integer
} | null {
  try {
    // position startpos などの "position " プレフィックスを考慮してパースする
    // tsshogi の Record.newByUSI() は "position sfen ..." や "position startpos ..." を受け付ける
    let command = usiPositionCommand;
    if (!command.startsWith("position ")) {
      command = "position " + command;
    }

    const record = Record.newByUSI(command);
    if (record instanceof Error) {
      console.warn("Failed to parse USI position command:", record.message);
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
