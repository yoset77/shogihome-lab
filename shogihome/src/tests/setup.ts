import { getTempPathForTesting } from "@/tests/helpers/temp";
import fs from "node:fs";

afterAll(() => {
  fs.rmSync(getTempPathForTesting(), { recursive: true, force: true });
});
