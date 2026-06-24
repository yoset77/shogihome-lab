#!/usr/bin/env node

/**
 * Builds the distributable server runtime.
 *
 * The release package ships a plain Node.js executable renamed to
 * shogihome-server.exe plus the bundled server and vision worker assets. This
 * avoids carrying both a SEA executable and a second Node runtime for the
 * vision worker.
 */

import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");

const CONFIG = {
  outputDir: path.join(projectRoot, "dist", "bin"),
  outputExe: path.join(projectRoot, "dist", "bin", "shogihome-server.exe"),
  serverOutDir: path.join(projectRoot, "dist", "server"),
};

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function step(stepNum, message) {
  log(`\n[${stepNum}/3] ${message}`, colors.cyan);
}

function success(message) {
  log(`OK ${message}`, colors.green);
}

function error(message) {
  log(`ERROR ${message}`, colors.red);
}

async function build() {
  log("\nBuilding Server Runtime\n", colors.cyan);

  try {
    step(1, "Validating server build output");
    const serverBundle = path.join(CONFIG.serverOutDir, "server.js");
    if (!fs.existsSync(serverBundle)) {
      error(`Server bundle not found: ${serverBundle}`);
      process.exit(1);
    }
    success("Server bundle found");

    step(2, "Creating clean output directory");
    fs.rmSync(CONFIG.outputDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(CONFIG.outputDir, "dist", "server"), { recursive: true });
    success(`Output directory ready: ${CONFIG.outputDir}`);

    step(3, "Copying Node runtime and server assets");
    copyNodeRuntime();
    copyFile(serverBundle, path.join(CONFIG.outputDir, "dist", "server", "server.js"));
    copyIfExists(
      path.join(CONFIG.serverOutDir, "node-worker"),
      path.join(CONFIG.outputDir, "dist", "server", "node-worker"),
    );
    copyIfExists(
      path.join(CONFIG.serverOutDir, "ort-wasm"),
      path.join(CONFIG.outputDir, "dist", "server", "ort-wasm"),
    );
    copyIfExists(
      path.join(CONFIG.serverOutDir, "models"),
      path.join(CONFIG.outputDir, "dist", "server", "models"),
    );
    success("Runtime assets copied");

    const totalSizeMB = getDirectorySize(CONFIG.outputDir) / 1024 / 1024;
    log("\nBuild completed successfully", colors.green);
    log(`\nRuntime: ${CONFIG.outputDir}`, colors.green);
    log(`Size: ${totalSizeMB.toFixed(2)} MB\n`, colors.green);
  } catch (err) {
    error(`\nBuild failed: ${err.message}`);
    if (err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

function copyNodeRuntime() {
  fs.copyFileSync(process.execPath, CONFIG.outputExe);
  fs.chmodSync(CONFIG.outputExe, fs.statSync(process.execPath).mode);
}

function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function copyIfExists(source, target) {
  if (!fs.existsSync(source)) {
    return;
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true });
}

function getDirectorySize(dir) {
  let size = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      size += getDirectorySize(entryPath);
    } else if (entry.isFile()) {
      size += fs.statSync(entryPath).size;
    }
  }
  return size;
}

build();
