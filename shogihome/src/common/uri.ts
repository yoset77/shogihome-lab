import { isRelayEngineId } from "@/common/engine/relay_protocol";

export const ES_HUMAN = "es://human";
export const ES_TEMP_FILE_PREFIX = "es://temp-file/";

export function isLanEngineURI(uri: string): boolean {
  return (
    uri === "lan-engine" ||
    (uri.startsWith("lan-engine:") && isRelayEngineId(uri.substring("lan-engine:".length)))
  );
}

export function issueTempFileURI(name: string): string {
  const now = Date.now();
  const rand = Math.floor(Math.random() * 16 ** 6)
    .toString(16)
    .padStart(6, "0");
  return ES_TEMP_FILE_PREFIX + `${now}/${rand}/${name}`;
}
