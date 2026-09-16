# Launcher / Config editor

この文書は、Tauri製ランチャーのビルド・実行・検証手順を示します。配布ZIPを使う場合はルート [README.md](../../README.md) と配布ZIP同梱 `README.txt` を参照してください。

ランチャーと設定エディタは同一実行ファイル (`ShogiHomeLab[.exe]`) の2つの起動モードです。通常起動はWebサーバーとエンジンラッパーを常駐起動し、`--config-editor` は設定編集 (`engines.json`) のみ起動してサーバーバンドル (`shogihome/`) を必要としません。

公式配布は現在Windows用portable ZIPのみです。Linux/macOSではソースからビルドしてportable配置で開発・検証できますが、一般利用はWindows版を推奨します。

## ビルド

Rust stable、Node.js（CI は 26）、各 OS の [Tauri 前提環境](https://v2.tauri.app/start/prerequisites/) が必要です。

- Windows: MSVC C++ build tools と WebView2 Runtime。
- Linux: GUI セッション、GTK 3、WebKitGTK 4.1。Ubuntu 24.04 の例:

  ```sh
  sudo apt-get update
  sudo apt-get install -y build-essential pkg-config libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev
  ```

- macOS: Xcode Command Line Tools（`xcode-select --install`）。WebView は OS の WKWebView を使います。

`engine-wrapper/launcher-app/` で実行します。

```sh
npm ci
npx tauri build --no-bundle -- --locked
```

成果物は `src-tauri/target/release/ShogiHomeLab`（Windows は `.exe` 付き）です。デバッグ版は `--debug` を追加します。shell は WebView 用システムライブラリを必要とするため、headless backend の Cargo workspace からは除外し、独立した lockfile と CI job で管理します。

## 設定エディタだけを使う

Linux／macOS の例（上記ディレクトリから）:

```sh
./src-tauri/target/release/ShogiHomeLab --config-editor --config-dir /absolute/path/to/engine-config
```

Windows では `ShogiHomeLab.exe --config-editor --config-dir "D:\engine-config"` を使います。

- `--config-dir` は `engines.json` と wrapper の `.env` の所在です。editor が編集するのは `engines.json` です。
- 相対エンジンパスは設定ディレクトリから解決し、probe の CWD は解決したエンジンのディレクトリです。
- 省略時は `<exe-dir>/engine-wrapper`。相対 `--config-dir` を明示した場合だけ起動時 CWD を基準にします。
- window を閉じると probe をキャンセルし、子孫プロセスの回収完了を待ってアプリを終了します。
- Linux／macOS では拡張子のないエンジンも選択できます。実行権限はエンジン側で設定してください。権限不足は probe エラーになります。
- 同じ設定ディレクトリの同時編集は OS 管理ロックで拒否します。

wrapper の単独実行は `engine-wrapper/` で `cargo run --locked -p shogihome-engine-wrapper -- --config-dir /absolute/path/to/engine-config` とします。`--config-dir` 省略時は `engines.json` のある実行ファイル横の `engine-wrapper/`、なければ実行ファイルの directory を使うため、portable 配置では `wrapper[.exe]` のダブルクリックで同梱設定が読まれます。GUI は TCP relay を起動しません。

## Launcher として使う

現段階の layout は書き込み可能な portable ディレクトリです。各 OS でビルドした次のファイルを配置します（`[.exe]` は Windows のみ）。

```text
portable/
├── ShogiHomeLab[.exe]       # Tauri --no-bundle の成果物
├── wrapper[.exe]           # cargo build --release -p shogihome-engine-wrapper の
│                          # target/release/shogihome-wrapper[.exe] を改名
├── shogihome/
│   ├── shogihome-server[.exe]
│   ├── dist/server/        # server.js・worker・model 等
│   ├── docs/webapp/
│   └── .env
└── engine-wrapper/
    ├── engines.json
    └── .env
```

`shogihome/` で `npm ci`、`npm run build`、`npm run server:runtime` を実行します。`dist/bin/` の内容を上図の `shogihome/` に、`docs/webapp/` を同じ相対位置に配置します。設定のひな型は server／wrapper 各 `.env.example` と `engine-wrapper/engines.json.default` です。Unix ではコピー時に実行権限を保持します。runtime はビルドした OS／architecture の Node 実行ファイルです。

配置後、`ShogiHomeLab[.exe]` を起動すると migration の確認後に services が起動します。起動時 CWD に依存せず、編集・監視・readiness は同じ portable root を使います。

| モード | 閉じる操作 |
|---|---|
| Windows／macOS の既定 | トレイへ隠す。トレイ作成失敗時は停止して終了 |
| Linux の既定 | service と probe を停止して終了 |
| `--tray` | トレイへ隠す。Linux では表示可能な tray host が必要 |
| `--no-tray` | 全 OS で停止して終了 |
| `--config-editor` | probe を停止して終了 |

`--tray` と `--no-tray` は launcher 専用で、同時指定できません。トレイの「終了」、dashboard の「停止して終了」、macOS のアプリ終了も共通 cleanup を通ります。macOS は Dock からの再表示にも対応します。

`--help` は GUI を初期化せず表示できます。native メッセージは `LC_ALL`、`LC_MESSAGES`、`LANG` の順で日本語 locale を選び、それ以外は英語です。WebView 内の言語選択とは独立しています。

`.app` の内部や AppImage の mount 先を portable root として使う構成は対象外です。インストール型配布では assets と書き込み先の分離を先に設計します。

## 検証

`engine-wrapper/` で:

```sh
python -m pip install "pytest==9.1.1" playwright python-dotenv
cargo test --locked --workspace
# server `.env` の Node 互換解決を含む backend integration test は Node を使います（CI の test-rust と同様）。
cargo clippy --workspace --all-targets -- -D warnings
python -m pytest tests/test_server_runtime.py
```

`launcher-app/` で `npm test`、`npm run build`、`cargo fmt --manifest-path src-tauri/Cargo.toml --check`、`cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings` を実行します。

Linux の native GUI 回帰テスト（`engine-wrapper/` から）:

```sh
sudo apt-get install -y webkit2gtk-driver xvfb xauth dbus-x11 openbox xdotool wmctrl scrot
cargo install tauri-driver --version 2.0.5 --locked
SHOGIHOME_GUI_EXE=launcher-app/src-tauri/target/release/ShogiHomeLab \
  dbus-run-session -- xvfb-run -a python -m pytest tests/test_launcher_linux_gui.py tests/test_launcher_cli.py -q
```

GUI suite は別ディレクトリへ実行ファイルをコピーし、異なる CWD から起動します。editor の保存・実ファイル選択・probe・ロック・終了時回収、launcher の起動・再起動・editor 再表示・トレイなし終了・明示的なトレイ常駐と終了を検証します。Windows は `tests/test_launcher_gui.py` の WebView2 回帰テストを使います。

CI は Windows／Linux／macOS で native backend、Tauri build、CLI、runtime assembly を検証します。GUI 自動操作は Windows／Linux が対象です。macOS の実 GUI は実機で次を確認します:

1. server のない配置で editor の読込・保存・拡張子なし実行ファイルの選択と probe。
2. probe 中の title-bar close と Cmd+Q、子孫回収、二重編集ロック。
3. launcher の起動・停止・再起動・移行、editor の開閉と再表示。
4. `--no-tray` の close、通常トレイの hide／show／quit、Dock の reopen。

設計上の境界は [Launcher Architecture](../../docs/architecture/launcher.md) を参照してください。
