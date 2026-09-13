import { describe, expect, it, vi } from "vitest";
import { startAfterMigration } from "./startup";

describe("startup migration barrier", () => {
  it("does not start while migration is pending", async () => {
    let finish!: (value: boolean) => void;
    const migration = new Promise<boolean>((resolve) => { finish = resolve; });
    const backend = {
      migrationStatus: vi.fn().mockResolvedValue({ needed: true, pendingSource: "old" }),
      startServices: vi.fn().mockResolvedValue(1),
    };
    const migrate = vi.fn(() => migration);
    const startup = startAfterMigration(backend, migrate);
    await vi.waitFor(() => expect(migrate).toHaveBeenCalled());
    expect(backend.startServices).not.toHaveBeenCalled();
    finish(true);
    expect(await startup).toBe(true);
    expect(backend.startServices).toHaveBeenCalledOnce();
  });

  it("leaves services stopped on a failed or deferred migration", async () => {
    const backend = {
      migrationStatus: vi.fn().mockResolvedValue({ needed: true, pendingSource: "old" }),
      startServices: vi.fn(),
    };
    expect(await startAfterMigration(backend, async () => false)).toBe(false);
    await expect(startAfterMigration(backend, async () => { throw new Error("copy failed"); })).rejects.toThrow("copy failed");
    expect(backend.startServices).not.toHaveBeenCalled();
  });

  it("starts an existing installation without asking to migrate", async () => {
    const backend = {
      migrationStatus: vi.fn().mockResolvedValue({ needed: false, pendingSource: null }),
      startServices: vi.fn().mockResolvedValue(1),
    };
    const migrate = vi.fn();
    expect(await startAfterMigration(backend, migrate)).toBe(true);
    expect(migrate).not.toHaveBeenCalled();
  });
});
