import esbuild from "esbuild";
import path from "node:path";
import fs from "node:fs";

const projectRoot = path.resolve(import.meta.dirname, "..");

const replacementPlugin = {
  name: "replacement",
  setup(build) {
    build.onResolve({ filter: /-electron\.js$/ }, (args) => {
      return { path: path.join(args.resolveDir, args.path.replace(/-electron\.js$/, "-cmd.js")) };
    });
  },
};

async function build() {
  const outfile = path.join(projectRoot, "dist", "command", "usi-csa-bridge", "index.js");
  try {
    await esbuild.build({
      entryPoints: [path.join(projectRoot, "src/command/usi-csa-bridge/index.ts")],
      bundle: true,
      platform: "node",
      target: "node20",
      outfile,
      minify: true,
      format: "cjs",
      banner: {
        js: "#!/usr/bin/env node",
      },
      plugins: [replacementPlugin],
      packages: "external",
    });
    fs.chmodSync(outfile, "755");
    console.log("✓ Command line tool built successfully.");
  } catch (err) {
    console.error("✗ Command line tool build failed:", err);
    process.exit(1);
  }
}

build();
