import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const projectRoot = path.resolve(import.meta.dirname, "..");
const serverOutDir = path.join(projectRoot, "dist", "server");
const onnxRuntimeAssetNames = ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"];
const nodeBanner = `
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
`;

async function build() {
  try {
    await esbuild.build({
      entryPoints: [path.join(projectRoot, "server.ts")],
      bundle: true,
      platform: "node",
      target: "node20",
      outfile: path.join(serverOutDir, "server.js"),
      minify: true,
      format: "esm",
      external: ["fsevents"], // Exclude platform-specific native modules
      define: {
        "process.env.NODE_ENV": '"production"',
      },
      banner: {
        // ESM bundle in Node.js sometimes needs shims for __dirname/__filename and require if used by dependencies
        js: nodeBanner,
      },
    });
    await esbuild.build({
      entryPoints: [path.join(projectRoot, "src", "server", "vision", "node-worker", "worker.ts")],
      bundle: true,
      platform: "node",
      target: "node20",
      outfile: path.join(serverOutDir, "node-worker", "worker.js"),
      minify: true,
      format: "esm",
      external: ["fsevents"],
      banner: {
        js: nodeBanner,
      },
    });
    copyOnnxRuntimeAssets();
    copyVisionModels();
    copyStrategyModel();
    console.log("✓ Server built successfully (ESM).");
  } catch (err) {
    console.error("✗ Server build failed:", err);
    process.exit(1);
  }
}

function copyOnnxRuntimeAssets() {
  const sourceDir = path.join(projectRoot, "node_modules", "onnxruntime-web", "dist");
  const targetDir = path.join(serverOutDir, "ort-wasm");
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`onnxruntime-web dist not found: ${sourceDir}`);
  }
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  for (const fileName of onnxRuntimeAssetNames) {
    const sourcePath = path.join(sourceDir, fileName);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`onnxruntime-web asset not found: ${sourcePath}`);
    }
    fs.copyFileSync(sourcePath, path.join(targetDir, fileName));
  }
}

function copyVisionModels() {
  const sourceDir = path.join(projectRoot, "src", "server", "vision", "models");
  const targetDir = path.join(serverOutDir, "models");
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Vision models not found: ${sourceDir}`);
  }
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  for (const fileName of fs.readdirSync(sourceDir)) {
    if (fileName.endsWith(".onnx")) {
      const sourcePath = path.join(sourceDir, fileName);
      assertRealOnnxModel(sourcePath);
      fs.copyFileSync(sourcePath, path.join(targetDir, fileName));
    }
  }
}

function copyStrategyModel() {
  const sourceDir = path.join(projectRoot, "src", "server", "kifu_index", "models");
  const targetDir = path.join(serverOutDir, "models", "strategy");
  const files = ["manifest.json", "weights.f64"];
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Strategy model directory not found: ${sourceDir}`);
  }
  fs.mkdirSync(targetDir, { recursive: true });
  for (const fileName of files) {
    const sourcePath = path.join(sourceDir, fileName);
    if (!fs.existsSync(sourcePath) || fs.statSync(sourcePath).size === 0) {
      throw new Error(`Strategy model asset not found: ${sourcePath}`);
    }
    fs.copyFileSync(sourcePath, path.join(targetDir, fileName));
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, "manifest.json"), "utf8"));
  const weights = fs.readFileSync(path.join(sourceDir, "weights.f64"));
  const coefficientBytes =
    manifest.coefficientShape[0] * manifest.coefficientShape[1] * Float64Array.BYTES_PER_ELEMENT;
  const coefficientHash = createHash("sha256")
    .update(weights.subarray(0, coefficientBytes))
    .digest("hex");
  const interceptHash = createHash("sha256")
    .update(weights.subarray(coefficientBytes))
    .digest("hex");
  if (
    coefficientHash !== manifest.coefficientSha256 ||
    interceptHash !== manifest.interceptSha256
  ) {
    throw new Error("Strategy model weights checksum is invalid");
  }
}

function assertRealOnnxModel(modelPath) {
  const stat = fs.statSync(modelPath);
  const fd = fs.openSync(modelPath, "r");
  const buffer = Buffer.alloc(128);
  const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
  fs.closeSync(fd);
  const header = buffer.subarray(0, bytesRead).toString("utf8");
  if (header.startsWith("version https://git-lfs.github.com/spec/v1")) {
    throw new Error(`Vision model is a Git LFS pointer. Run git lfs pull: ${modelPath}`);
  }
  if (stat.size < 1024 * 1024) {
    throw new Error(`Vision model is unexpectedly small (${stat.size} bytes): ${modelPath}`);
  }
}

build();
