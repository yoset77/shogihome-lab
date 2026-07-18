import fs from "node:fs";
import { spawn } from "node:child_process";

const STARTPOS_SFEN = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";
const dispatchLog = process.argv[2];
let buffer = "";
let blocked = false;

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) return;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handleRequest(JSON.parse(line));
  }
});

function handleRequest(request) {
  fs.appendFileSync(dispatchLog, `${request.imagePath}\n`);
  if (blocked) return;

  switch (request.imagePath) {
    case "timeout":
      blocked = true;
      return;
    case "crash":
      process.exit(1);
      return;
    case "invalid-json":
      blocked = true;
      process.stdout.write("not-json\n");
      return;
    case "stale-output":
      blocked = true;
      spawn(
        process.execPath,
        ["-e", "setTimeout(() => process.stdout.write('stale-output\\n'), 100)"],
        { stdio: ["ignore", process.stdout, process.stderr] },
      );
      process.stdout.write("not-json\n");
      return;
    case "slow":
      setTimeout(() => writeResponse(request), 200);
      return;
    case "slow-exit":
      setTimeout(() => writeResponse(request, true), 250);
      return;
    default:
      writeResponse(request, request.imagePath === "ok-exit");
  }
}

function writeResponse(request, exit = false) {
  const response = {
    id: request.id,
    ok: true,
    result: {
      ok: true,
      sfen: STARTPOS_SFEN,
      confidence: 0.94,
      candidates: [],
      warnings: [],
    },
  };
  process.stdout.write(`${JSON.stringify(response)}\n`, () => {
    if (exit) process.exit(0);
  });
}
