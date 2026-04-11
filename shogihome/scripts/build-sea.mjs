#!/usr/bin/env node

/**
 * Build script for Single Executable Application (SEA)
 * Creates a standalone executable from the server bundle
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

// Configuration
const CONFIG = {
  seaConfig: path.join(projectRoot, "sea-config.json"),
  blobPath: path.join(projectRoot, "dist", "server", "sea-prep.blob"),
  outputDir: path.join(projectRoot, "dist", "bin"),
  outputExe: path.join(projectRoot, "dist", "bin", "shogihome-server.exe"),
  sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
};

// Color output helpers
const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function step(stepNum, message) {
  log(`\n[${stepNum}/4] ${message}`, colors.cyan);
}

function success(message) {
  log(`✓ ${message}`, colors.green);
}

function error(message) {
  log(`✗ ${message}`, colors.red);
}

function execute(command, options = {}) {
  try {
    execSync(command, { stdio: "inherit", ...options });
    return true;
  } catch {
    return false;
  }
}

// Main build process
async function build() {
  log("\n╔════════════════════════════════════════╗", colors.cyan);
  log("║  Building Single Executable (SEA)      ║", colors.cyan);
  log("╚════════════════════════════════════════╝\n", colors.cyan);

  try {
    // Step 1: Generate SEA blob
    step(1, "Generating SEA blob");
    if (!fs.existsSync(CONFIG.seaConfig)) {
      error(`SEA config not found: ${CONFIG.seaConfig}`);
      process.exit(1);
    }

    if (!execute(`node --experimental-sea-config "${CONFIG.seaConfig}"`)) {
      error("Failed to generate SEA blob");
      process.exit(1);
    }

    if (!fs.existsSync(CONFIG.blobPath)) {
      error(`Blob file not generated: ${CONFIG.blobPath}`);
      process.exit(1);
    }
    success("SEA blob generated");

    // Step 2: Create output directory
    step(2, "Creating output directory");
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
    success(`Output directory ready: ${CONFIG.outputDir}`);

    // Step 3: Copy Node.js executable
    step(3, "Copying Node.js executable");
    fs.copyFileSync(process.execPath, CONFIG.outputExe);
    success(`Executable copied to: ${CONFIG.outputExe}`);

    // Step 4: Inject SEA blob using postject
    step(4, "Injecting SEA blob with postject");
    const postjectCmd = `postject "${CONFIG.outputExe}" NODE_SEA_BLOB "${CONFIG.blobPath}" --sentinel-fuse ${CONFIG.sentinelFuse}`;

    if (!execute(postjectCmd)) {
      error("Failed to inject SEA blob");
      process.exit(1);
    }
    success("SEA blob injected successfully");

    // Final status
    const stats = fs.statSync(CONFIG.outputExe);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

    log("\n╔════════════════════════════════════════╗", colors.green);
    log("║  Build Completed Successfully!         ║", colors.green);
    log("╚════════════════════════════════════════╝", colors.green);
    log(`\nExecutable: ${CONFIG.outputExe}`, colors.green);
    log(`Size: ${sizeMB} MB\n`, colors.green);
  } catch (err) {
    error(`\nBuild failed: ${err.message}`);
    if (err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

// Run build
build();
