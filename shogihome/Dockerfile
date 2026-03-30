# ---- Builder Stage ----
# ビルドに必要な依存関係をインストールし、アプリケーションをビルドするステージ
FROM node:24-slim AS builder

# 作業ディレクトリを設定
WORKDIR /app

# package.jsonとpackage-lock.jsonをコピー
COPY package*.json ./

# 依存関係をインストール (npm run buildに必要なdevDependenciesを含む)
RUN npm ci

# 全ソースコードをコピー
COPY . .

# 環境変数を設定 (CI環境であることを明示)
ENV CI=true

# アプリケーションをビルド
# (フロントエンド資産のビルドと、サーバーのWebpackビルドを実行)
RUN npm run build && npm run server:build


# ---- Production Stage ----
# 実行に必要な最小限のファイルのみを含む本番用イメージを作成するステージ
FROM node:24-slim AS production

# 作業ディレクトリを設定
WORKDIR /app

# 実行ユーザーの所有権をあらかじめ設定
# 永続化対象の /app/data も作成しておく
RUN mkdir -p /app/data && chown -R node:node /app

# nodeユーザーに切り替え
USER node

# Builderステージからビルド済みファイル一式をコピー
# - ビルド済みのフロントエンド資産 (docs/webapp)
COPY --from=builder --chown=node:node /app/docs/webapp ./docs/webapp
# - WebpackでビルドされたサーバーJS (依存関係はすべてバンドル済み)
COPY --from=builder --chown=node:node /app/dist/server/server.js ./server.cjs

# ポート8140を公開
EXPOSE 8140

# コンテナ起動時にサーバーを実行 (依存ライブラリ不要の単一JSをnodeで実行)
CMD [ "node", "server.cjs" ]
