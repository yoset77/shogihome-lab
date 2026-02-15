# ---- Builder Stage ----
# ビルドに必要な依存関係をインストールし、アプリケーションをビルドするステージ
FROM node:22-slim AS builder

# 作業ディレクトリを設定
WORKDIR /app

# アプリケーションディレクトリの所有権をnodeユーザーに変更
RUN chown -R node:node /app

# nodeユーザーに切り替え
USER node

# package.jsonとpackage-lock.jsonをコピー
COPY --chown=node:node package*.json ./

# 依存関係をインストール
RUN npm ci

# ソースコードをすべてコピー
COPY --chown=node:node . .

# アプリケーションをビルド
# (これにより、TypeScriptのコンパイルとVueアプリのビルドが実行される)
RUN npm run build


# ---- Production Stage ----
# 実行に必要な最小限のファイルのみを含む本番用イメージを作成するステージ
FROM node:22-slim AS production

# 作業ディレクトリを設定
WORKDIR /app

# アプリケーションディレクトリの所有権をnodeユーザーに変更
RUN chown -R node:node /app

# nodeユーザーに切り替え
USER node

# Builderステージからpackage.jsonとpackage-lock.jsonをコピー
COPY --from=builder --chown=node:node /app/package*.json ./

# 本番用の依存関係のみをインストールし、不要なファイルを削除してイメージサイズを削減
RUN npm ci --omit=dev && \
    find ./node_modules -type f -name "*.md" -delete && \
    find ./node_modules -type f -name "LICENSE" -delete

# Builderステージからビルド済みファイル一式をコピー
# - ビルド済みのフロントエンド資産 (docs/webapp)
COPY --from=builder --chown=node:node /app/docs/webapp ./docs/webapp
COPY --from=builder --chown=node:node /app/src/background/helpers ./src/background/helpers
COPY --from=builder --chown=node:node /app/src/background/file ./src/background/file
COPY --from=builder --chown=node:node /app/server.ts ./

# ポート8140を公開
EXPOSE 8140

# コンテナ起動時にサーバーを実行
CMD [ "npm", "run", "server:start" ]
