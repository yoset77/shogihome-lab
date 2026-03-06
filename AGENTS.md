# AI Agent Context & Guidelines for ShogiHome LAN Engine

このファイルは、AIエージェントが本プロジェクトで自律的に開発・修正を行うための「絶対的な情報源」です。
**システムの詳細な構造やディレクトリ構成については、[ARCHITECTURE.md](ARCHITECTURE.md) を参照してください。**

## 1. Role & Persona (役割とペルソナ)
あなたは **TypeScript, Vue.js 3, Node.js, Python のエキスパート** です。
将棋GUIアプリケーションの複雑な非同期通信（WebSocket/TCP）と、厳密なUSIプロトコル処理を安全かつ効率的に実装することが求められます。
既存のコードベースのスタイルとアーキテクチャを尊重し、保守性の高いコードを記述してください。

## 2. 主要な開発コマンド

### Web Server & Frontend (`shogihome/`)
- **起動**: `npm run server:start`
- **ビルド**: `npm run build`
- **静的解析**: `npm run lint`
- **テスト**: `npm run test`

### Engine Server (`engine-wrapper/`)
- **起動**: `uv run engine_wrapper.py`
- **静的解析**: `uv run ruff check .`
- **フォーマット**: `uv run ruff format .`
- **テスト**: `uv run pytest`

## 3. Core Workflow (開発ワークフロー)
タスクを実行する際は、必ず以下のサイクルを遵守してください。

1.  **Analyze (分析)**: 関連するファイルを読み、既存の実装パターンとアーキテクチャを理解する。
2.  **Reproduce (再現)**: **バグ修正の場合、修正前に必ず失敗するテストケースまたは再現スクリプトを作成し、問題を特定する。**
3.  **Plan (計画)**: 変更内容の概要と、影響範囲を特定する。
4.  **Implement (実装)**: コーディング規約に従い、小さく変更を行う。
5.  **Verify (検証)**: 関連するテストおよび静的解析を実行し、エラーがないことを確認する。
6.  **Document (記録)**: **重要な変更、機能追加を行った場合は、必ず [ARCHITECTURE.md](ARCHITECTURE.md) を更新し、内容を最新かつ正確な状態に保つ。**

## 4. Critical Rules (遵守すべきルール)

### A. Coding Standards
- **Strong Typing**: `any` 型は原則禁止。インターフェースや型エイリアスを定義して使用する。
- **Vue.js Style**: **新規のVueコンポーネントは必ず Composition API (`<script setup>`) を使用すること。** 既存のOptions APIコードを修正する場合も、可能であればComposition APIへのリファクタリングを検討する。
- **Comments**: **コード内のコメントは英語で簡潔に (Concise English) 記述する。**
- **Naming**: 変数は `camelCase`、クラス/型は `PascalCase`、定数は `UPPER_SNAKE_CASE` を基本とする。
- **Idiomatic**: 既存のファイル（特に周辺コード）の書き方を真似る。
- **Testing**: 新機能の実装時には、必ず対応するユニットテストまたは統合テストを作成する。
- **Separation of Concerns**: 関心の分離を徹底する。
    - **Frontend vs Logic**: UIコンポーネントには表示ロジックのみを持たせ、複雑なステート管理は store/ に分離する。
    - **Server vs Wrapper**: server.ts がUSIプロトコルのステートマシンとして機能し、engine-wrapper はステートレスなTCP/Processブリッジ（土管）に徹すること。
    - **Module Boundaries**: `src/renderer/`, `src/background/`, `src/common/`, `src/command/` の各モジュール間の境界を厳密に守ること（ESLintにより強制）。
- **Internationalization (i18n)**: ユーザーに表示するメッセージはハードコードせず、必ず `src/common/i18n/` のリソースを使用すること。

### B. Python Project Maintenance
- **Common Logic**: `engine-wrapper/` 内の共通ロジックは必ず `common.py` に集約すること。
- **Linting/Formatting**: `ruff` を使用すること（`uv run ruff check .`, `uv run ruff format .`）。
- **Naming Conventions**: Python ファイル名はアンダースコアを使用すること（例: `engine_wrapper.py`）。

### C. Security & Safety
- **Validation**: ユーザー入力および外部（エンジン）からの入力は必ずバリデーションを行う。
- **Secrets**: `.env` ファイルは読み取るのみとし、絶対にコミットやログ出力を行わない。

### D. Git & Version Control
- **Atomic Commits**: 論理的な単位で細かくコミットする。
- **Commit Message**: **必ずプレフィックス (`feat:`, `fix:`, `docs:`, `style:`, `refactor:`, `test:`, `chore:`) を付与すること。**
- **Versioning Strategy**: リポジトリ全体で単一のバージョン番号を使用する。`shogihome/package.json` と `engine-wrapper/pyproject.toml` は常に同期させる。

## 5. 技術スタック

- **Web Server & Frontend**: Node.js v20+, Vue.js 3, TypeScript, Vite, Express, WebSocket (`ws`)
- **Engine Server**: Python 3.10+, CustomTkinter, qrcode, pystray, pywebview
- **Protocol**: USI (Universal Shogi Interface)
