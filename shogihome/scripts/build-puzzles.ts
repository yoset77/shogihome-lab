import fs from "fs";
import path from "path";

const puzzlesDir = path.join("public", "puzzles");
const manifestPath = path.join("public", "puzzles-manifest.json");

try {
  const files = fs.readdirSync(puzzlesDir).filter((file) => file.endsWith(".json"));

  const manifest = files.map((file) => {
    const filePath = path.join(puzzlesDir, file);
    const content = fs.readFileSync(filePath, "utf-8");
    const puzzles = JSON.parse(content);
    return {
      file: file,
      count: Array.isArray(puzzles) ? puzzles.length : 0,
    };
  });

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Generated puzzle manifest at ${manifestPath}`);
} catch (error) {
  console.error("Failed to generate puzzle manifest:", error);
  // If the puzzles directory does not exist, create an empty manifest.
  if ((error as { code?: string }).code === "ENOENT") {
    fs.writeFileSync(manifestPath, JSON.stringify([], null, 2));
    console.log(`Puzzles directory not found. Generated an empty puzzle manifest.`);
  } else {
    process.exit(1);
  }
}
