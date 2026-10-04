import { Hono } from "hono";
import { validator } from "hono/validator";
import { decodeGameRequest, decodeGameCommand } from "@/common/game/protocol";
import { identifier } from "@/common/analysis/validation";
import { gameTexts } from "@/common/i18n/game";
import { GameSessionManager, gameSessionManager } from "@/server/game/manager";
import { HttpError } from "@/server/errors";
import {
  createBodyLimit,
  LARGE_BODY_LIMIT,
  DEFAULT_JSON_BODY_LIMIT,
  type AppEnv,
} from "@/server/hono";
import { parseJsonObject } from "./body";

function id(value: string): string {
  try {
    return identifier(value);
  } catch {
    throw new HttpError(400, gameTexts().invalid);
  }
}
export const createGameSessionRoutes = (manager: GameSessionManager = gameSessionManager) =>
  new Hono<AppEnv>()
    .use("*", async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
    })
    .get("/capabilities", (c) => c.json(manager.capabilities()))
    .post(
      "/",
      createBodyLimit(LARGE_BODY_LIMIT),
      validator("json", (value) => {
        const decoded = decodeGameRequest(parseJsonObject(value));
        if (!decoded.ok) throw new HttpError(400, gameTexts().invalid);
        return decoded.value;
      }),
      (c) => c.json(manager.create(c.req.valid("json")).snapshot(), 202),
    )
    .get("/by-request/:requestId", (c) =>
      c.json(manager.byRequest(id(c.req.param("requestId"))).snapshot()),
    )
    .get("/:sessionId/records/:gameId", (c) =>
      c.json(manager.get(id(c.req.param("sessionId"))).record(id(c.req.param("gameId")))),
    )
    .post(
      "/:sessionId/commands",
      createBodyLimit(DEFAULT_JSON_BODY_LIMIT),
      validator("json", (value) => {
        const decoded = decodeGameCommand(parseJsonObject(value));
        if (!decoded.ok) throw new HttpError(400, gameTexts().invalid);
        return decoded.value;
      }),
      async (c) =>
        c.json(await manager.get(id(c.req.param("sessionId"))).command(c.req.valid("json"))),
    )
    .get("/:sessionId", (c) => c.json(manager.get(id(c.req.param("sessionId"))).snapshot()));
export const gameSessionRoutes = createGameSessionRoutes();
