# AI Agent Context & Guidelines for ShogiHome LAN Engine

このファイルは、AIエージェントが本プロジェクトで自律的に開発・修正を行うための「絶対的な情報源」です。

## 1. Role & Persona (役割とペルソナ)
あなたは **TypeScript, Vue.js 3, Node.js のエキスパート** です。
将棋GUIアプリケーションの複雑な非同期通信（WebSocket/TCP）と、厳密なUSIプロトコル処理を安全かつ効率的に実装することが求められます。
既存のコードベースのスタイルとアーキテクチャを尊重し、保守性の高いコードを記述してください。

## 2. Core Workflow (開発ワークフロー)
タスクを実行する際は、必ず以下のサイクルを遵守してください。

1.  **Analyze (分析)**: 関連するファイルを読み、既存の実装パターンとアーキテクチャを理解する。
2.  **Plan (計画)**: 変更内容の概要と、影響範囲を特定する
3.  **Implement (実装)**: コーディング規約に従い、小さく変更を行う。
4.  **Verify (検証)**: `npm run lint` および `npm run test` を実行し、エラーがないことを確認する。変更がUIに関わる場合は、関連コンポーネントの動作確認手順を提示する。

### D. Python Project Maintenance
- **Common Logic**: `engine-wrapper/` 内の Python スクリプト (`launcher.py`, `config_editor.py`, `engine_wrapper.py`) の共通ロジック（パス解決、`.env` 読み込み、プロセス終了処理）は、必ず `common.py` に集約すること。これにより、配布用バイナリのビルド時やフォルダ構成変更時の整合性を維持する。
- **Testing**: 新機能の追加やリファクタリング時は、`pytest` を使用してテストコードを作成すること。
- **Linting/Formatting**: `ruff` を使用して静的解析とコードフォーマットを行うこと。`uv run ruff check .` および `uv run ruff format .` で実行可能。
- **Naming Conventions**: Python ファイル名はモジュールとしてインポート可能なように、ハイフンではなくアンダースコアを使用すること（例: `engine_wrapper.py`）。

## 3. Critical Rules (遵守すべきルール)

### A. Coding Standards
- **Strong Typing**: `any` 型は原則禁止。インターフェースや型エイリアスを定義して使用する。
- **Vue.js Style**: **新規のVueコンポーネントは必ず Composition API (`<script setup>`) を使用すること。** 既存のOptions APIコードを修正する場合も、可能であればComposition APIへのリファクタリングを検討する。
- **Comments**: **コード内のコメントは英語で簡潔に (Concise English) 記述する。
- **Naming**: 変数は `camelCase`、クラス/型は `PascalCase`、定数は `UPPER_SNAKE_CASE` を基本とする。
- **Idiomatic**: 既存のファイル（特に周辺コード）の書き方を真似る。
- **Separation of Concerns**: 関心の分離を徹底する。
    - Frontend vs Logic: UIコンポーネントには表示ロジックのみを持たせ、複雑なステート管理は store/ に分離する。
    - Server vs Wrapper: server.ts がUSIプロトコルのステートマシン（起動、停止、コマンドキューイング）として機能し、engine-wrapper はステートレスなTCP/Processブリッジ（土管）に徹すること。Wrapper側にUSIコマンド解釈ロジックを追加してはならない。**server.ts は内部状態を `EngineState` 列挙型に集約し、独立した boolean フラグによる状態管理を避けること。**
- **Internationalization (i18n)**: ユーザーに表示するメッセージはハードコードせず、必ず `src/common/i18n/` のリソースを使用して国際化対応を行うこと。新規メッセージ追加時は `text_template.ts` への型定義追加と各言語ファイルへの翻訳記述を必須とする。

### B. Security & Safety
- **Validation**: ユーザー入力および外部（エンジン）からの入力は必ずバリデーションを行う。特にWebSocket/TCP経由で受信したデータは「信頼できない」ものとして扱い、型チェックとサニタイズを徹底する。
- **Network Security**: server.ts 等のサーバーサイドコードを変更する際は、コマンドインジェクションや意図しない外部接続が発生しないか検証する。
- **Secrets**: `.env` ファイルは読み取るのみとし、絶対にコミットやログ出力を行わない。設定の追加時は `.env.example` を更新する。

### C. Git & Version Control
- **Atomic Commits**: 論理的な単位で細かくコミットする。
- **Commit Message**: **必ずプレフィックス (`feat:`, `fix:`, `docs:`, `style:`, `refactor:`, `test:`, `chore:`) を付与すること。**
    - 例: `feat: add LAN engine reconnection logic`, `fix: board rendering on mobile`
- **Versioning Strategy**:
    - **Single Versioning**: リポジトリ全体で単一のバージョン番号(`vX.Y.Z`)を使用する。`shogihome/package.json` と `engine-wrapper/pyproject.toml` は常に同期させる。`engine-wrapper/package.json` のバージョンは非公式とし、同期の必要はない。
    - **App Display Version**: アプリ内（`About`画面等）での表示バージョンは、`shogihome/vite.config.mts` において `package.json` の `version` プロパティを自動的に読み込むことで管理する。フォーク元のバージョン体系とは独立した、本プロジェクト独自のバージョン（例: `1.4.0`）が表示される。

## 4. アーキテクチャ概要

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
3.  **Engine Wrapper (`engine-wrapper/`)**: Node.js/Python。
    - `engines.json` に基づき、指定されたIDのエンジンプロセスを起動・中継。

## 5. 技術スタックと環境

- **Runtime**: Node.js v20+
- **Frontend**: Vue.js 3 (Composition API & Options API mix), TypeScript, Vite
- **Backend**: Express, WebSocket (`ws`), `net` (TCP)
- **State Management**: Vuex pattern (Custom implementation in `store/index.ts`)
- **Protocol**: USI (Universal Shogi Interface)
- **Linter/Formatter**: ESLint, Prettier

## 6. ビルド・テスト・開発コマンド

### Web Server & Frontend (`shogihome/`)
- **依存関係インストール**: `npm ci`
- **アプリビルド**: `npm run build` (ライセンスデータの生成と webapp へのコピーを含む)
- **サーバー起動**: `npm run server:start` (`server.ts` を実行)
- **配布用ビルド (Windows)**: `npm run server:exe` (Node.js SEA機能を使用して単一の実行ファイルを `dist/bin` に出力)
- **静的解析**: `npm run lint` (ESLint & Prettier)
- **テスト実行**: `npm run test` (Vitest)

### Engine Server (`engine-wrapper/`)
- **Node.js版**:
    - **依存関係インストール**: `npm install`
    - **起動**: `npm run start`
- **Python版 (Releases推奨)**:
    - **依存関係インストール**: `uv sync`
    - **起動**: `uv run engine_wrapper.py`
    - **テスト**: `uv run pytest`
    - **静的解析**: `uv run ruff check .`
    - **フォーマット**: `uv run ruff format .`
    - **ライセンス生成**: `npm run py:license` (または `uv run python scripts/generate_licenses.py`)
    - **配布用ビルド (Windows)**: `uv run nuitka --standalone --onefile --windows-console-mode=disable --msvc=14.3 engine_wrapper.py`

### CI/CD (GitHub Actions)
- **自動リリース**: `v*` タグをプッシュすると `.github/workflows/release.yml` が起動し、ビルド済みのZIPパッケージがドラフトとして作成されます。

## 7. 主要ディレクトリ構成

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
| `engine_wrapper.py` | **推奨ラッパー (バイナリ配布用)**。Python製。Nuitkaで実行ファイル化されます。 |
| `engine-wrapper.mjs` | **開発用ラッパー**。Node.js製。セットアップが容易。 |
| `config_editor.py` | **設定エディタ (Backend)**。`config_editor.html` と連携し、ブラウザ上で `engines.json` を編集するためのサーバー。 |
| `config_editor.html` | **設定エディタ (Frontend)**。単独でファイル編集ツールとしても、`config_editor.py` のUIとしても動作するハイブリッド設計。 |
| `scripts/generate_licenses.py` | Python依存ライブラリのライセンスを生成。 |
| `engines.json` | エンジン設定ファイル (Git管理対象外)。ID、表示名、実行パスのリストを定義。原本として `engines.json.default` (空) または `engines.json.example` (設定例) を参照。 |
| `engines.json.default` | リリース用テンプレート (空のリスト `[]`)。 |
| `engines.json.example` | 開発者向け設定例。 |
| `.env` | 環境設定 (Git管理対象外)。ポート番号等を設定。原本として `.env.example` を参照。 |

### C. Release Assets

| パス | 説明 |
| :--- | :--- |
| `assets/release/` | 配布用パッケージに同梱される `README.txt` の原本。 |

## 8. 機能実装の詳細仕様

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

### モバイル最適化
- **CSS**: ブラウザのツールバーによる表示崩れを防ぐため、`100vh` ではなく `100dvh` を使用しています。
