import {
  app,
  EngineSession,
  EngineState,
  initializeServer,
  startIfExecutedDirectly,
} from "./src/server/main";

export { app, EngineSession, EngineState, initializeServer, startIfExecutedDirectly };

startIfExecutedDirectly(process.argv[1]);
