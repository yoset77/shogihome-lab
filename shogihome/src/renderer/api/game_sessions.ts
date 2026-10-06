import {
  decodeGameCapabilities,
  decodeGameSnapshot,
  type GameSessionRequest,
  type GameCommand,
  type GameSnapshot,
  type GameCapabilities,
} from "@/common/game/protocol";
import type { DecodeResult } from "@/common/engine/relay_protocol";
import { t } from "@/common/i18n/index";
import { createApiRequestOptions, createHonoApiClient, parseJsonResponse } from "./client";
import {
  decodeJobList,
  decodeJobOperationOutcome,
  type JobOperationOutcome,
  type JobAttachRequest,
  type JobBinding,
  type JobSummary,
} from "@/common/jobs/types";

export interface GameSessionsClient {
  commandOutcome(id: string, requestId: string): Promise<JobOperationOutcome>;
  list(): Promise<JobSummary[]>;
  attach(id: string, request: JobAttachRequest): Promise<GameSnapshot>;
  detach(id: string, binding: JobBinding): Promise<GameSnapshot>;
  capabilities(): Promise<GameCapabilities>;
  create(request: GameSessionRequest): Promise<GameSnapshot>;
  byRequest(id: string): Promise<GameSnapshot>;
  snapshot(id: string): Promise<GameSnapshot>;
  command(id: string, command: GameCommand): Promise<GameSnapshot>;
}
async function decode<T>(
  response: Response,
  decoder: (value: unknown) => DecodeResult<T>,
): Promise<T> {
  const result = decoder(await parseJsonResponse<unknown>(response));
  if (!result.ok) throw new Error(t.gameInvalid);
  return result.value;
}
export function createGameSessionsClient(): GameSessionsClient {
  const client = createHonoApiClient().api["game-sessions"];
  return {
    commandOutcome: async (id, requestId) =>
      decode(
        await client[":sessionId"].commands[":requestId"].$get({
          param: { sessionId: id, requestId },
        }),
        decodeJobOperationOutcome,
      ),
    list: async () => decode(await client.$get(), decodeJobList),
    attach: async (id, request) =>
      decode(
        await client[":sessionId"].attach.$post({ param: { sessionId: id }, json: request }),
        decodeGameSnapshot,
      ),
    detach: async (id, binding) =>
      decode(
        await client[":sessionId"].detach.$post({ param: { sessionId: id }, json: binding }),
        decodeGameSnapshot,
      ),
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
  };
}
