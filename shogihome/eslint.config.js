// eslint.config.js
// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import prettierConfig from "eslint-config-prettier";
import pluginVue from "eslint-plugin-vue";
import { defineConfigWithVueTs, vueTsConfigs } from "@vue/eslint-config-typescript";
import vuePrettierConfig from "@vue/eslint-config-prettier";
import { flatConfigs as importXFlatConfigs } from "eslint-plugin-import-x";

export default defineConfigWithVueTs([
  {
    ignores: ["docs/webapp/**", "docs/webapp-dev/**", "dist/**", "dev-dist/**", "coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs["flat/recommended"],
  vueTsConfigs.recommended,
  importXFlatConfigs.recommended,
  {
    files: ["**/*.{ts,mts,cts,tsx,vue}"],
    ...importXFlatConfigs.typescript,
    settings: {
      "import-x/resolver": {
        typescript: true,
      },
      "import-x/ignore": ["node_modules"],
      "import-x/core-modules": ["typescript-eslint"],
    },
  },
  {
    files: ["eslint.config.*"],
    rules: {
      "import-x/no-unresolved": "off",
    },
  },
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-console": "off",
      "no-debugger": "error",
      "no-restricted-imports": ["error", { patterns: ["../"] }],
      "no-irregular-whitespace": "off",
      "vue/multi-word-component-names": "off",
      "import-x/no-cycle": "warn",
      "import-x/no-restricted-paths": [
        "error",
        {
          zones: [
            {
              from: "./src/renderer",
              target: "./src/common",
            },
            {
              from: "./src/node",
              target: "./src/renderer",
            },
            {
              from: "./src/node",
              target: "./src/common",
            },
            {
              from: "./src/renderer",
              target: "./src/node",
            },
            {
              from: "./src/server",
              target: "./src/node",
            },
            {
              from: "./src/renderer",
              target: "./src/server",
            },
            {
              from: "./src/server",
              target: "./src/renderer",
            },
            {
              from: "./src/server",
              target: "./src/common",
            },
          ],
        },
      ],
    },
  },
  prettierConfig,
  vuePrettierConfig,
]);
