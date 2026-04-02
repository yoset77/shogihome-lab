import { spawnSync, type ChildProcess } from "child_process";

export function killTree(proc: ChildProcess): void {
  if (proc.pid) {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", proc.pid.toString(), "/f", "/t"]);
    } else {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch (e) {
        // ignore
      }
    }
  }
}
