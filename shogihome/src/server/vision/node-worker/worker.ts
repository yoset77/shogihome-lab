import { createInterface, type Interface } from "node:readline";
import { scanImage, type ScanOptions } from "./pipeline.js";

const parseArgs = (argv: string[]): { modelDir: string } => {
  const args = argv.slice(2);
  let modelDir = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model-dir" && i + 1 < args.length) {
      modelDir = args[++i];
    }
  }
  return { modelDir: modelDir || "../models" };
};

const main = (): void => {
  const { modelDir } = parseArgs(process.argv);
  const rl: Interface = createInterface({ input: process.stdin, terminal: false });
  let pending = 0;
  let inputClosed = false;

  const finish = (): void => {
    pending--;
    if (inputClosed && pending === 0) {
      process.stdout.end(() => process.exit(0));
    }
  };

  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    pending++;
    handleLine(trimmed, modelDir).finally(finish);
  });

  rl.on("close", () => {
    inputClosed = true;
    if (pending === 0) {
      process.stdout.end(() => process.exit(0));
    }
  });
};

const handleLine = async (line: string, modelDir: string): Promise<void> => {
  let requestId: number | null = null;
  try {
    const request = JSON.parse(line);
    requestId = request.id != null ? Number(request.id) : null;

    if (request.type !== "scan") {
      const resp = { id: requestId, ok: false, error: "unsupported request type" };
      process.stdout.write(JSON.stringify(resp) + "\n");
      return;
    }

    const options: ScanOptions = {
      imagePath: request.imagePath,
      sideToMove: request.sideToMove === "white" ? "white" : "black",
      maxCandidates: Math.max(1, Math.min(Number(request.maxCandidates) || 5, 20)),
      modelDir,
    };

    const result = await scanImage(options);
    const resp = { id: requestId, ok: true, result };
    process.stdout.write(JSON.stringify(resp) + "\n");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const resp = { id: requestId, ok: false, error: message };
    process.stdout.write(JSON.stringify(resp) + "\n");
  }
};

main();
