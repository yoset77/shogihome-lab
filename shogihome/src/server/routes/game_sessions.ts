import { Hono } from "hono";
import { validator } from "hono/validator";
import {
  decodeGameRequest,
  decodeGameCommand,
  readGameRecoveryRequest,
} from "@/common/game/protocol";
import { identifier } from "@/common/analysis/validation";
import { t } from "@/common/i18n";
import { GameSessionManager, gameSessionManager } from "@/server/game/manager";
import { HttpError } from "@/server/errors";
import {
  createBodyLimit,
  LARGE_BODY_LIMIT,
  DEFAULT_JSON_BODY_LIMIT,
  type AppEnv,
} from "@/server/hono";
import { parseJsonObject } from "./body";
import { readJobAttachRequest, readJobBinding } from "@/common/jobs/types";

function id(value: string): string {
  try {
    return identifier(value);
  } catch {
    throw new HttpError(400, t.gameInvalid);
  }
}
export const createGameSessionRoutes = (manager: GameSessionManager = gameSessionManager) =>
  new Hono<AppEnv>()
    .use("*", async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
    })
    .get("/capabilities", (c) => c.json(manager.capabilities()))
    .get("/", (c) => c.json(manager.list()))
    .get("/:sessionId/commands/:requestId", async (c) =>
      c.json(
        await manager
          .get(id(c.req.param("sessionId")))
          .commandOutcome(id(c.req.param("requestId"))),
      ),
    )
    .post(
      "/:sessionId/attached-snapshot",
      createBodyLimit(DEFAULT_JSON_BODY_LIMIT),
      validator("json", (value) => {
        try {
          return readGameRecoveryRequest(parseJsonObject(value));
        } catch {
          throw new HttpError(400, t.gameInvalid);
        }
      }),
      (c) => c.json(manager.get(id(c.req.param("sessionId"))).recover(c.req.valid("json"))),
    )
    .post(
      "/:sessionId/attach",
      createBodyLimit(DEFAULT_JSON_BODY_LIMIT),
      validator("json", (value) => {
        try {
          return readJobAttachRequest(parseJsonObject(value));
        } catch {
          throw new HttpError(400, t.gameInvalid);
        }
      }),
      (c) => c.json(manager.get(id(c.req.param("sessionId"))).attach(c.req.valid("json"))),
    )
    .post(
      "/:sessionId/detach",
      createBodyLimit(DEFAULT_JSON_BODY_LIMIT),
      validator("json", (value) => {
        try {
          return readJobBinding(parseJsonObject(value));
        } catch {
          throw new HttpError(400, t.gameInvalid);
        }
      }),
      (c) => {
        const session = manager.get(id(c.req.param("sessionId")));
        session.detach(c.req.valid("json"));
        return c.json(session.publicSnapshot());
      },
    )
    .post(
      "/",
      createBodyLimit(LARGE_BODY_LIMIT),
      validator("json", (value) => {
        const decoded = decodeGameRequest(parseJsonObject(value));
        if (!decoded.ok) throw new HttpError(400, t.gameInvalid);
        return decoded.value;
      }),
      (c) => c.json(manager.create(c.req.valid("json")).creationSnapshot(), 202),
    )
    .get("/by-request/:requestId", (c) =>
      c.json(manager.byRequest(id(c.req.param("requestId"))).publicSnapshot()),
    )
    .post(
      "/:sessionId/commands",
      createBodyLimit(DEFAULT_JSON_BODY_LIMIT),
      validator("json", (value) => {
        const decoded = decodeGameCommand(parseJsonObject(value));
        if (!decoded.ok) throw new HttpError(400, t.gameInvalid);
        const input = parseJsonObject(value);
        try {
          return {
            ...decoded.value,
            ...(input.authorization === undefined
              ? {}
              : { authorization: readJobBinding(input.authorization) }),
          };
        } catch {
          throw new HttpError(400, t.gameInvalid);
        }
      }),
      async (c) => {
        const { authorization, ...command } = c.req.valid("json");
        return c.json(
          await manager.get(id(c.req.param("sessionId"))).command(command, authorization),
        );
      },
    )
    .get("/:sessionId", (c) => c.json(manager.get(id(c.req.param("sessionId"))).publicSnapshot()));
export const gameSessionRoutes = createGameSessionRoutes();
