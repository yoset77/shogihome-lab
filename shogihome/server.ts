import { app, EngineSession, EngineState, startIfExecutedDirectly } from "./src/server/main";

export { app, EngineSession, EngineState, startIfExecutedDirectly };

startIfExecutedDirectly(process.argv[1]);
