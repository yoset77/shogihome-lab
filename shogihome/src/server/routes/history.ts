import express, { type Express } from "express";
import { addHistory, clearHistory, getHistory, saveBackup } from "@/background/file/history";
import { sendError } from "@/server/errors";

export const registerHistoryRoutes = (app: Express) => {
  app.get("/api/history", async (req, res) => {
    const history = await getHistory();
    res.json(history);
  });

  app.post("/api/history/add", express.json(), async (req, res) => {
    const { path } = req.body;
    if (typeof path !== "string" || !path) {
      sendError(res, 400, "path is required");
      return;
    }
    addHistory(path);
    res.send("ok");
  });

  app.post("/api/history/backup", express.text({ limit: "10mb" }), async (req, res) => {
    const kif = req.body;
    if (typeof kif !== "string" || !kif) {
      sendError(res, 400, "kif text body is required");
      return;
    }
    await saveBackup(kif);
    res.send("ok");
  });

  app.post("/api/history/clear", async (req, res) => {
    await clearHistory();
    res.send("ok");
  });
};
