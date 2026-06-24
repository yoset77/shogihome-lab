process.stdin.setEncoding("utf-8");
let buffer = "";

process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const index = buffer.indexOf("\n");
  if (index < 0) return;

  const request = JSON.parse(buffer.slice(0, index).trim());
  process.stdout.write(JSON.stringify({ id: request.id + 1000, ok: true, result: {} }) + "\n");
});
