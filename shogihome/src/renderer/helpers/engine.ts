import type { LanEngineInfo } from "@/common/engine/relay_protocol";
import type { USIEngine } from "@/common/settings/usi";
import { isLanEngineURI } from "@/common/uri";

export function resolveLanEngine(
  uri: string,
  engines: readonly Pick<LanEngineInfo, "id" | "name">[],
): USIEngine | undefined {
  if (!isLanEngineURI(uri)) return;
  const id = uri === "lan-engine" ? uri : uri.substring("lan-engine:".length);
  return { uri, name: engines.find((engine) => engine.id === id)?.name ?? id };
}
