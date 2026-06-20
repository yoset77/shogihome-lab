import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";

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
  fs.mkdirSync(targetDir, { recursive: true });
  for (const fileName of fs.readdirSync(sourceDir)) {
    if (fileName.endsWith(".onnx")) {
      const sourcePath = path.join(sourceDir, fileName);
      assertRealOnnxModel(sourcePath);
      fs.copyFileSync(sourcePath, path.join(targetDir, fileName));
    }
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
