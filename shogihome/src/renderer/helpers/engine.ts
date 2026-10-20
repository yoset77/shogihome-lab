import type { LanEngineInfo, LanEngineType } from "@/common/engine/relay_protocol";
import type { USIEngine } from "@/common/settings/usi";
import { getLanEngineId } from "@/common/uri";

export function resolveLanEngine(
  uri: string,
  engines: readonly Pick<LanEngineInfo, "id" | "name">[],
  engineType: LanEngineType,
): USIEngine | undefined {
  const id = getLanEngineId(uri, engineType);
  if (!id) return;
  return { uri, name: engines.find((engine) => engine.id === id)?.name ?? id };
}
