import esbuild from "esbuild";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");

async function build() {
  try {
    await esbuild.build({
      entryPoints: [path.join(projectRoot, "server.ts")],
      bundle: true,
      platform: "node",
      target: "node20",
      outfile: path.join(projectRoot, "dist", "server", "server.js"),
      minify: true,
      format: "esm",
      external: ["fsevents"], // Exclude platform-specific native modules  
      define: {
        "process.env.NODE_ENV": '"production"',
      },
      banner: {
        // ESM bundle in Node.js sometimes needs shims for __dirname/__filename and require if used by dependencies
        js: `
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
`,
      },
    });
    console.log("✓ Server built successfully (ESM).");
  } catch (err) {
    console.error("✗ Server build failed:", err);
    process.exit(1);
  }
}

build();
