import express, { type Express } from "express";
import path from "path";
import { shogiHomePath } from "@/server/config";
import { errorHandler, sendError } from "@/server/errors";

export const registerStaticRoutes = (app: Express) => {
  app.all(/^\/api(?:\/|$)/, (req, res) => {
    sendError(res, 404, "API endpoint not found");
  });

  app.use(express.static(shogiHomePath));

  app.get(/.*/, (req, res) => {
    res.sendFile(path.join(shogiHomePath, "index.html"));
  });

  app.use(errorHandler);
};
