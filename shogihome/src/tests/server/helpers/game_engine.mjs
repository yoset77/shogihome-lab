import readline from "node:readline";
import fs from "node:fs";

let position = "position startpos";
let pending;
const output = (line) => process.stdout.write(line + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (process.env.GAME_TEST_LOG) fs.appendFileSync(process.env.GAME_TEST_LOG, line + "\n");
  if (line === "usi") {
    output("id name Game Fixture");
    output("usiok");
  } else if (line === "isready") output("readyok");
  else if (line.startsWith("position ")) position = line;
  else if (line.startsWith("go ")) {
    const ply = position.includes(" moves ") ? position.split(" moves ")[1].split(" ").length : 0;
    const move = ["7g7f", "3c3d", "2g2f", "8c8d"][ply] ?? "resign";
    output(`info depth 8 score cp 20 nodes 100 pv ${move === "resign" ? "7g7f" : move}`);
    pending = setTimeout(() => {
      pending = undefined;
      output(`bestmove ${move}`);
    }, 200);
  } else if (line === "stop") {
    clearTimeout(pending);
    pending = undefined;
    output("info depth 99 score cp 999 pv 3c3d");
    output("bestmove resign");
  } else if (line === "quit") process.exit(0);
});
