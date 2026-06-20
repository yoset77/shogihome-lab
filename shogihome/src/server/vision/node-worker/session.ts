import * as ort from "onnxruntime-web";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const sessions = new Map<string, ort.InferenceSession>();
let wasmConfigured = false;

const configureWasm = (): void => {
  if (wasmConfigured) return;
  wasmConfigured = true;

  if (typeof ort.env?.wasm === "undefined") return;

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));

  const candidates = [
    process.env.ORT_WASM_PATH,
    path.resolve(moduleDir, "..", "ort-wasm"),
    path.resolve(moduleDir, "ort-wasm"),
    path.resolve(process.cwd(), "dist", "server", "ort-wasm"),
    path.resolve(process.cwd(), "node_modules", "onnxruntime-web", "dist"),
    path.resolve(moduleDir, "..", "..", "..", "..", "node_modules", "onnxruntime-web", "dist"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const dir of candidates) {
    const mjsPath = path.join(dir, "ort-wasm-simd-threaded.mjs");
    const wasmPath = path.join(dir, "ort-wasm-simd-threaded.wasm");
    if (fs.existsSync(mjsPath) && fs.existsSync(wasmPath)) {
      ort.env.wasm.wasmPaths = {
        mjs: pathToFileURL(mjsPath).href,
        wasm: pathToFileURL(wasmPath).href,
      };
      return;
    }
  }
};

export const loadSession = async (modelPath: string): Promise<ort.InferenceSession> => {
  const cached = sessions.get(modelPath);
  if (cached) return cached;

  configureWasm();

  const modelBuffer = fs.readFileSync(modelPath);
  const session = await ort.InferenceSession.create(modelBuffer, {
    executionProviders: ["wasm"],
  });
  sessions.set(modelPath, session);
  return session;
};

export const createTensor = (
  _name: string,
  data: Float32Array | Uint8Array,
  dims: number[],
): ort.Tensor => {
  return new ort.Tensor(data instanceof Float32Array ? "float32" : "uint8", data, dims);
};
