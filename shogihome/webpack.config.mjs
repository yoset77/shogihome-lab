import TerserPlugin from "terser-webpack-plugin";
import webpack from "webpack";
import { AddExecPermission } from "./plugins/webpack.mjs";
import path from "node:path";

const optimization = {
  minimize: true,
  minimizer: [
    new TerserPlugin({
      terserOptions: {
        format: {
          comments: false,
        },
      },
      extractComments: false,
    }),
  ],
};

const moduleForCJS = {
  rules: [
    {
      test: /\.ts$/,
      use: "ts-loader",
    },
  ],
};

const resolveForCJS = {
  alias: {
    "@": path.resolve(import.meta.dirname, "src"),
  },
  extensions: [".ts", ".js"],
  extensionAlias: {
    ".js": [".ts", ".js", ".cjs"],
  },
};

export default [
  {
    name: "server",
    mode: "production",
    entry: "./server.ts",
    target: "node",
    output: {
      filename: "server.js",
      path: path.join(import.meta.dirname, "dist", "server"),
      libraryTarget: "commonjs",
    },
    module: moduleForCJS,
    resolve: resolveForCJS,
    optimization,
    ignoreWarnings: [
      { module: /node_modules[\\/\\\\]express[\\/\\\\]view\.js/ },
      { module: /node_modules[\\/\\\\]log4js[\\/\\\\]appenders[\\/\\\\]index\.js/ },
      { module: /node_modules[\\/\\\\]ws[\\/\\\\](buffer-util|validation)\.js/ },
    ],
  },
  {
    name: "command:usi-csa-bridge",
    mode: "production",
    entry: "./src/command/usi-csa-bridge/index.ts",
    target: "node",
    output: {
      filename: "index.js",
      path: path.join(import.meta.dirname, "dist", "command", "usi-csa-bridge"),
      libraryTarget: "commonjs2",
    },
    module: moduleForCJS,
    resolve: resolveForCJS,
    externals: /^[^.@].*$/,
    optimization,
    plugins: [
      new webpack.NormalModuleReplacementPlugin(/^.*-electron\.js$/, (resource) => {
        const newResource = resource.request.replace(/^(.*)-electron\.js$/, "$1-cmd.js");
        resource.request = newResource;
      }),
      new webpack.BannerPlugin({ banner: "#!/usr/bin/env node", raw: true }),
      AddExecPermission,
    ],
  },
];
