const TerserPlugin = require("terser-webpack-plugin");
const webpack = require("webpack");
const customPlugins = require("./plugins/webpack");
const path = require("path");

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
    "@": path.resolve(__dirname, "src"),
  },
  extensions: [".ts", ".js"],
  extensionAlias: {
    ".js": [".ts", ".js", ".cjs"],
  },
};

module.exports = [
  {
    name: "server",
    mode: "production",
    entry: "./server.ts",
    target: "node",
    output: {
      filename: "server.js",
      path: __dirname + "/dist/server",
      libraryTarget: "commonjs",
    },
    module: moduleForCJS,
    resolve: resolveForCJS,
    optimization,
    ignoreWarnings: [
      { module: /node_modules[\\/\\\\]express[\\/\\\\]lib[\\/\\\\]view\.js/ },
      { module: /node_modules[\\/\\\\]log4js[\\/\\\\]lib[\\/\\\\]appenders[\\/\\\\]index\.js/ },
      { module: /node_modules[\\/\\\\]ws[\\/\\\\]lib[\\/\\\\](buffer-util|validation)\.js/ },
    ],
  },
  {
    name: "command:usi-csa-bridge",
    mode: "production",
    entry: "./src/command/usi-csa-bridge/index.ts",
    target: "node",
    output: {
      filename: "index.js",
      path: __dirname + "/dist/command/usi-csa-bridge",
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
      customPlugins.AddExecPermission,
    ],
  },
];
