const STARTPOS_SFEN = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";

process.stdin.setEncoding("utf-8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) {
      break;
    }
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      handleRequest(JSON.parse(line));
    }
  }
});

function handleRequest(request) {
  const mode =
    request.maxCandidates === 4 ? "invalid-sfen" : request.maxCandidates === 6 ? "timeout" : "ok";
  if (mode === "timeout") {
    setTimeout(() => undefined, 10000);
  } else if (mode === "invalid-sfen") {
    writeResponse(request.id, {
      ok: true,
      sfen: "invalid-sfen",
      confidence: 0.9,
      board: [],
      candidates: [],
      warnings: [],
    });
  } else {
    writeResponse(request.id, {
      ok: true,
      sfen: STARTPOS_SFEN,
      confidence: 0.94,
      board: [],
      candidates: [
        {
          sfen: STARTPOS_SFEN,
          score: 0.94,
          violations: [],
        },
      ],
      warnings: [],
    });
  }
}

function writeResponse(id, result) {
  process.stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`);
}
