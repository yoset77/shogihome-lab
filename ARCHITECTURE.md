# Architecture & Implementation Details for ShogiHome LAN Engine

このファイルは、本プロジェクトのシステム構造、ディレクトリ構成、および各機能の詳細な実装仕様を記述したドキュメントです。

## 1. アーキテクチャ概要

システムは以下の3つのコンポーネントで構成されています。

```mermaid
graph LR
    A["Browser (Frontend)"] -- "WebSocket (ws)" --> B["Middle Server (Node.js)"]
    B -- "TCP Socket (run <id>)" --> C["Engine Wrapper"]
    C -- "Stdin/Stdout" --> D["USI Engine (YaneuraOu, etc.)"]
```

1.  **Frontend (`shogihome/src`)**: Vue.js 3 + TypeScript。ユーザーインターフェース。複数エンジンからID指定で起動可能。
2.  **Middle Server (`shogihome/server.ts`)**: Node.js。
    - WebSocketとTCPのブリッジ。`start_engine <id>` コマンドを Wrapper の `run <id>` へ変換。
3.  **Engine Wrapper (`engine-wrapper/`)**: Python。
    - `engines.json` に基づき、指定されたIDのエンジンプロセスを起動・中継。

## 2. 主要ディレクトリ構成

### A. Web Server & Frontend (`shogihome/`)

| パス | 説明 |
| :--- | :--- |
| `server.ts` | **中核サーバー**。Expressでのアプリ配信と、WebSocketによるエンジン中継ロジックが含まれます。 |
| `src/renderer/store/index.ts` | **状態管理**。アプリ全体のステートを保持し、対局・検討・編集などの各マネージャー（`GameManager`, `ResearchManager` 等）を統合します。 |
| `src/renderer/players/lan_player.ts` | **LANプレイヤー**。USIプロトコルの同期制御（Stop待ち、コマンド送信）を実装し、通信経由でエンジンを操作する実体です。 |
| `src/renderer/network/lan_engine.ts` | **LAN通信クライアント**。WebSocket接続とコマンド送信、エンジンリスト取得を管理。 |
| `src/renderer/view/` | **Vueコンポーネント**: |
| - `main/` | `BoardPane` (盤面), `RecordPane` (棋譜), `ControlPane` (操作パネル) など、メイン画面の構成要素。 |
| - `dialog/` | `GameDialog` (対局設定), `ResearchDialog` (検討設定), `AppSettingsDialog` (設定) など、モーダルダイアログ群。 |
| - `menu/` | `MobileGameMenu` (モバイル用メニュー) など、メニュー関連コンポーネント。 |
| `public/puzzles/` | 次の一手問題データ（JSON）。 |
| `scripts/build-puzzles.ts` | ビルド時にパズルデータを集計し、マニフェストファイルを生成するスクリプト。 |
| `docs/webapp/` | ビルド成果物 (Git管理対象外)。ライセンスファイルもここに含まれます。 |
| `.env` | 環境設定 (Git管理対象外)。ポート番号等を設定。原本として `.env.example` を参照。 |

### B. Engine Server (`engine-wrapper/`)

| パス | 説明 |
| :--- | :--- |
| `engine_wrapper.py` | **エンジンラッパー**。エンジンをTCPサーバーとして公開するツール。エンジンオプションの注入も担当。 |
| `config_editor.py` | **設定エディタ (Backend/GUI)**。`pywebview` を使用して `config_editor.html` をデスクトップアプリとして表示し、 `engines.json` を編集するツール。 |
| `config_editor.html` | **設定エディタ (Frontend)**。単独でファイル編集ツールとしても、`config_editor.py` のUIとしても動作するハイブリッド設計。 |
| `scripts/generate_licenses.py` | Python依存ライブラリのライセンスを生成。 |
| `engines.json` | エンジン設定ファイル (Git管理対象外)。ID、表示名、実行パスのリストを定義。原本として `engines.json.default` (空) または `engines.json.example` (設定例) を参照。 |
| `engines.json.default` | リリース用テンプレート (空のリスト `[]`)。 |
| `engines.json.example` | 開発者向け設定例。 |
| `.env` | 環境設定 (Git管理対象外)。ポート番号等を設定。原本として `.env.example` を参照。 |

### C. Release Assets (`assets/release/`)

| パス | 説明 |
| :--- | :--- |
| `README.txt` | 配布用パッケージに同梱される `README.txt` の原本。 |
| `shim.cs` | 配布用パッケージのルートに配置する軽量ランチャー。 |

## 3. 機能実装の詳細仕様

### LANエンジン通信フロー
1.  **リスト取得**: フロントエンドが `get_engine_list` を送信。サーバーは Wrapper から `list` コマンドで取得したJSONを返却。`LanEngine.ts` 側でキャッシュされるが、必要に応じて強制更新可能。
2.  **起動**: フロントエンドが `start_engine <id>` を送信。**エンジンが `STARTING` または `isStopping` 状態にある間の新規起動リクエストは、競合防止のためサーバー側で拒否される。**
3.  **ハンドシェイク**: `server.ts` が Wrapper 接続時に `usi` を自動送信し、`usiok` 受信時に `isready` を自動送信する。クライアントからの `usi`/`isready` は無視される。
4.  **同期**: 局面移動時、`LanPlayer.ts` は `stop` コマンドを送り、エンジンから `bestmove` を受信するまで次の `position` コマンドの送信を待機する。**タイムアウト(5秒)が発生した場合は例外をスローし、不整合な状態での探索開始を防止する。サーバー側では `stop` 送信から `bestmove` 到着までの間のコマンドをキューイングし、到着後に最新の局面のみを送信（デバウンス）する。**
5.  **リアルタイム更新**: サーバーはエンジン出力に SFEN を付与して返却。フロントエンドは `dispatchUSIInfoUpdate` を通じて `usiMonitor` を更新し、読み筋タブへ反映。
6.  **コマンドバリデーションと暗黙の停止**: サーバーは受信したUSIコマンドを厳格にバリデーションし、不正なコマンドを破棄します。また、思考中に `position` 等のコマンドを受信した場合は、自動的に `stop` を発行して `bestmove` を待機する「暗黙の停止」処理を行い、状態の不整合を防ぎます。
7.  **統一された状態管理**: `server.ts` 内の `EngineSession` は、接続から思考・停止・終了に至るすべてのフェーズを `EngineState` で一元管理します。これにより、思考中に停止処理が走っている状態 (`STOPPING_SEARCH`) などを明確に区別し、競合状態を防止しています。
8.  **簡易認証 (Simple Auth)**: `engine-wrapper` と `server.ts` 間にトークンベースの認証(HMAC-SHA256 CRAM)を導入しました。
    - 双方の `.env` に `WRAPPER_ACCESS_TOKEN` を設定することで有効化されます。
    - **CRAM方式**: 平文のトークン送信を避け、リプレイ攻撃を防ぐため、Challenge-Response認証を採用しています。
        1. Wrapper -> Server: `auth_cram_sha256 <nonce>` (16進数32文字のランダムなナンス)
        2. Server -> Wrapper: `auth <digest>` (トークンを鍵、ナンスをメッセージとしたHMAC-SHA256ハッシュ)
        3. Wrapper -> Server: 検証成功なら `auth_ok`、失敗ならエラーメッセージを送信して切断。
    - トークンが未設定の場合は、従来通り認証なしで動作します（後方互換性あり）。

#### 接続の回復力 (Resilience)
- **セッション再接続**: ネットワーク瞬断やリロードに対し、`localStorage` に保存された `sessionId` を用いた再接続機能を備えています。
- **ハートビート**: クライアントは6秒ごとに `ping` を送信し、サーバーからの `pong` 応答を監視します。タイムアウトが発生した場合は接続不良と判断して再接続を試みます。
- **切断保護 (Disconnect Protection)**: 意図しない切断（`stop_engine` コマンドなしの切断）が発生した場合、サーバー側でエンジンプロセスを一定期間（デフォルト60秒、`.env` の `ENGINE_CONNECTION_PROTECTION_TIMEOUT` で設定可能）維持します。
- **自動復旧とバッファリング**: クライアントは WebSocket 切断時に指数バックオフを用いて自動的に再接続を試みます。また、切断中に送信しようとしたコマンドはクライアント側の `commandQueue` に保持され、再接続時に自動的に再送されます。バックグラウンドから復帰した際 (`visibilitychange`) には待機時間を待たずに即座に再接続を試みることで、UXを向上させています。サーバー側は切断中のエンジン出力（`info` や `bestmove`）をバッファリング（`info` は最新10件のみ保持）し、再接続時にリプレイすることで状態を完全復元します。これにより、思考中の回線断でもエラーにならずに継続可能です。
- **意図的な終了**: クライアントから `stop_engine` コマンドが送出された後の切断は「意図的な終了」とみなされ、サーバーは即座にエンジンプロセスを終了しリソースを解放します。

### 統合ランチャー (ShogiHome LAN Launcher)
一般ユーザーの利便性向上のため、CustomTkinter 製の GUI ランチャー (`engine-wrapper/launcher.py`) を導入しました。
- **プロセス一括管理**: Webサーバーとエンジンラッパーをバックグラウンドで一括起動・終了。
- **タスクトレイ常駐**: ウィンドウを閉じてもトレイに常駐し、右クリックメニューから操作（Dashboard表示、設定、再起動、終了）が可能。
- **QRコード表示**: LAN内アクセス用の URL を自動生成し、スマホ等から即座にアクセスできるよう QR コードを表示。
- **ヘルスチェック**: 2秒ごとにプロセスの死活監視を行い、異常終了（クラッシュ等）時にステータスを更新。
- **ログビューア**: バックグラウンド実行中のサーバーおよびラッパーの標準出力をファイルに保存し、GUI 上で確認可能。
- **設定エディタ管理**: 「Engine Settings」ボタンからの `config_editor.py` 起動において、ポート番号の固定、多重起動防止、およびプロセスのライフサイクル（ランチャー終了時の自動停止）を完全に管理。ブラウザ上の終了操作ともUI状態を同期。

### エンジン設定 (`engines.json`)
- **Type**: `game` / `research` / `both` を指定可能。フロントエンドはこれに基づき、対局・検討ダイアログで表示するエンジンをフィルタリングする。
- **デフォルトエンジン**: アプリ設定で「デフォルトの検討エンジン」を指定でき、設定時は検討ボタン押下時のエンジン選択ダイアログをスキップして即座に開始する。

### 次の一手問題（Puzzles）
- **データ構造**: 静的なJSONファイルとして `/public/puzzles` に配置。`puzzles-manifest.json` がエントリーポイントとなります。
- **読み込み**: `src/renderer/store/index.ts` 内の `fetchPuzzles` で処理。
    - **キャッシュ**: 初回読み込み時にメモリ上 (`cachedPuzzles`) にキャッシュします。2回目以降はキャッシュを使用しつつ、バックグラウンドで更新を確認する Stale-While-Revalidate パターンを採用しています。
- **履歴管理**: `localStorage` (`shogihome-puzzle-history`) を使用して正解済み問題のSFENと解答日時を記録します。有効期限（28日）を過ぎた履歴は自動的に削除されます。
- **出題ロジック**: 履歴に含まれる（最近解いた）問題を除外し、ランダムに出題します。
- **問題タイプ**:
    - **次の一手 (`next_move`)**: 指定された正解手と一致するか判定。
    - **形勢判断 (`evaluation`)**: 5段階の評価値（勝率）を選択肢として提示し、エンジンの評価値と比較します。

### サーバー側棋譜管理 (Server-side Kifu Management)
サーバー上の特定のディレクトリ配下にある棋譜ファイルを、ブラウザから直接読み書きできる機能です。
- **有効化**: Webサーバー側の `.env` に `KIFU_DIR` を設定することで有効化されます。未設定時はUI上の関連ボタンが非表示になります。
- **ファイル探索**: 指定されたディレクトリを再帰的にスキャンし、`.kif`, `.kifu`, `.ki2`, `.ki2u`, `.csa`, `.jkf` 形式のファイルを抽出します。**インメモリキャッシュにより、2回目以降のリスト取得を高速化しています。**
- **自動同期**: **`chokidar` を使用して `KIFU_DIR` を監視しており、OS（Windows/macOS/Linux）や環境に関わらず、アプリ外でファイルが追加・削除・編集された場合も自動的にキャッシュを無効化して最新の状態を反映します。**
- **HTTP API**: 読み書きには、Express 上に構築された専用の HTTP API (`/api/kifu/...`) を使用します。
- **セキュリティ**: `resolveKifuPath` ヘルパーにより、Path Traversal 攻撃（`../../` 等）を厳格に防止しています。**また、許可された拡張子のみを操作対象とし、ディレクトリの深さ制限（最大10階層のサブディレクトリ）や最大ファイル読み込み数（10,000件）を設けることで、不正なファイル操作やリソースの過剰消費を防止しています。**
- **キャッシュ管理**: **新しい棋譜の保存 (`/api/kifu/save`) 時や、外部でのファイル変更検知時に、インメモリキャッシュを自動的にクリアします。**
- **URI スキーム**: サーバー上のファイルは `server://相対パス` という形式の URI で管理され、これに基づき `RecordManager` が保存先を自動判定します。

### 定跡DB管理 (Book DB Management - Web/LAN)
サーバー側の `KIFU_DIR` 内にある YaneuraOu 形式の定跡ファイル (.db, .bin) をブラウザから利用・編集する機能です。
- **読み込み**: サーバーサイドで実行され、巨大なファイルに対してはオンザフライ検索を行うことで、クライアント側のリソース消費を抑えています。
- **編集機能**: 定跡手の追加、削除、評価値の更新、表示順の変更がブラウザから可能です。**「指し手追加」ダイアログにおける設定（インポート条件など）はブラウザの `localStorage` に保持されます。**
- **インポート**: サーバー上の特定の棋譜ファイルから定跡データをインポートする機能をサポートしています。
- **セキュリティ**: 棋譜管理と同様、`resolveKifuPath` によるパスバリデーションにより、安全なファイル操作を保証しています。

### モバイル最適化
- **CSS**: ブラウザのツールバーによる表示崩れを防ぐため、`100vh` ではなく `100dvh` を使用しています。
