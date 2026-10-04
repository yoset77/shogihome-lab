import {
  decodeGameCapabilities,
  decodeGameSnapshot,
  type GameSessionRequest,
  type GameCommand,
  type GameSnapshot,
  type GameCapabilities,
} from "@/common/game/protocol";
import { decodeRecordSnapshot, type RecordSnapshot } from "@/common/record/snapshot";
import type { DecodeResult } from "@/common/engine/relay_protocol";
import { gameTexts } from "@/common/i18n/game";
import { createApiRequestOptions, createHonoApiClient, parseJsonResponse } from "./client";

export interface GameSessionsClient {
  capabilities(): Promise<GameCapabilities>;
  create(request: GameSessionRequest): Promise<GameSnapshot>;
  byRequest(id: string): Promise<GameSnapshot>;
  snapshot(id: string): Promise<GameSnapshot>;
  command(id: string, command: GameCommand): Promise<GameSnapshot>;
  record(id: string, gameId: string): Promise<RecordSnapshot>;
}
async function decode<T>(
  response: Response,
  decoder: (value: unknown) => DecodeResult<T>,
): Promise<T> {
  const result = decoder(await parseJsonResponse<unknown>(response));
  if (!result.ok) throw new Error(gameTexts().invalid);
  return result.value;
}
export function createGameSessionsClient(): GameSessionsClient {
  const client = createHonoApiClient().api["game-sessions"];
  return {
    capabilities: async () => decode(await client.capabilities.$get(), decodeGameCapabilities),
    create: async (request) =>
      decode(
        await client.$post({ json: request }, createApiRequestOptions({ timeoutMs: 30_000 })),
        decodeGameSnapshot,
      ),
    byRequest: async (id) =>
      decode(
        await client["by-request"][":requestId"].$get({ param: { requestId: id } }),
        decodeGameSnapshot,
      ),
    snapshot: async (id) =>
      decode(await client[":sessionId"].$get({ param: { sessionId: id } }), decodeGameSnapshot),
    command: async (id, command) =>
      decode(
        await client[":sessionId"].commands.$post(
          { param: { sessionId: id }, json: command },
          createApiRequestOptions({ timeoutMs: 30_000 }),
        ),
        decodeGameSnapshot,
      ),
    record: async (id, gameId) =>
      decode(
        await client[":sessionId"].records[":gameId"].$get({ param: { sessionId: id, gameId } }),
        decodeRecordSnapshot,
      ),
  };
}
