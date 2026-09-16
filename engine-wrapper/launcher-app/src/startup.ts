import type { api } from "./api";

export interface MigrationStatus {
  needed: boolean;
  pendingSource: string | null;
}

// Migration must finish before the server can create its data directory.
export async function startAfterMigration(
  backend: Pick<typeof api, "migrationStatus" | "startServices">,
  migrate: (status: MigrationStatus) => Promise<boolean>,
): Promise<boolean> {
  const status = await backend.migrationStatus();
  if (status.needed && !(await migrate(status))) return false;
  await backend.startServices();
  return true;
}
