import { loadYbbBook, YbbExpansionLimitError } from "@/server/book/ybb";

try {
  await loadYbbBook(process.argv[2]);
  throw new Error("Unexpectedly accepted an amplifying YBB file");
} catch (error) {
  if (!(error instanceof YbbExpansionLimitError)) throw error;
  process.stdout.write("YBB_EXPANSION_REJECTED\n");
}
