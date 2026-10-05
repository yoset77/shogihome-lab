import { EngineSession } from "@/server/engine/session";

if (process.argv.includes("--import-only") || process.argv.includes("--start-server")) {
  // Exclude the atomic writer's dependency-level signal-exit hooks.
  await import("proper-lockfile");
  const before = process.listenerCount("SIGTERM") + process.listenerCount("SIGINT");
  const { startServer } = await import("@/server/main");
  if (process.argv.includes("--start-server")) startServer();
  const output = `SIGNAL_LISTENERS:${process.listenerCount("SIGTERM") + process.listenerCount("SIGINT") - before}\n`;
  process.stdout.write(output, () => {
    if (process.argv.includes("--start-server")) process.exit(0);
  });
} else {
  const session = new EngineSession("listener-child", undefined, "internal");
  session.subscribeInternal(() => {
    throw new Error("Injected listener failure");
  });
  session.subscribeInternal(() => process.stdout.write("LATER_LISTENER_RAN\n"));
  session.dispatchInternal({ type: "ping" });
}
