import fs from "node:fs";
import path from "node:path";

function checkPackageJson(packageJsonPath: string) {
  try {
    const stat = fs.lstatSync(packageJsonPath);
    if (!stat.isFile()) {
      return;
    }
    const packageJson = fs.readFileSync(packageJsonPath, "utf-8");
    const { name, version, scripts } = JSON.parse(packageJson);

    // All packages should NOT have preinstall or install scripts
    if (scripts?.preinstall) {
      throw new Error(`Package ${name}@${version} has unexpected preinstall scripts`);
    }
    if (scripts?.install) {
      throw new Error(`Package ${name}@${version} has unexpected install scripts`);
    }

    switch (name) {
      // These packages have install.js scripts
      case "electron":
      case "esbuild":
        if (!scripts?.postinstall) {
          throw new Error(`Package ${name}@${version} is missing postinstall scripts`);
        }
        if (scripts.postinstall !== "node install.js") {
          throw new Error(`Package ${name}@${version} has unexpected postinstall scripts`);
        }
        break;

      // The postinstall is introduced since https://github.com/unrs/unrs-resolver/pull/66 (v1.6.0)
      case "unrs-resolver":
        if (!scripts?.postinstall) {
          throw new Error(`Package ${name}@${version} is missing postinstall scripts`);
        }
        if (!scripts.postinstall.match(/^napi-postinstall unrs-resolver [\d.]+ check$/)) {
          throw new Error(`Package ${name}@${version} has unexpected postinstall scripts`);
        }
        break;

      // Other packages should not have postinstall scripts
      default:
        if (scripts?.postinstall) {
          throw new Error(`Package ${name}@${version} has unexpected postinstall scripts`);
        }
        break;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      // Ignore if file was deleted between check and read (TOCTOU)
      return;
    }
    throw e;
  }
}

/**
 * Recursively check node_modules directory
 * @param nodeModulesPath Path to node_modules directory
 */
function checkNodeModules(nodeModulesPath: string) {
  if (!fs.existsSync(nodeModulesPath)) {
    return;
  }

  const modules = fs.readdirSync(nodeModulesPath);
  for (const module of modules) {
    if (module.startsWith(".")) {
      continue;
    }

    const modulePath = path.join(nodeModulesPath, module);
    const lstat = fs.lstatSync(modulePath);

    // Skip symbolic links to avoid infinite loops and follow standard security practices
    if (lstat.isSymbolicLink()) {
      continue;
    }

    if (!lstat.isDirectory()) {
      continue;
    }

    if (module.startsWith("@")) {
      // Handle scoped packages
      const subModules = fs.readdirSync(modulePath);
      for (const subModule of subModules) {
        if (subModule.startsWith(".")) {
          continue;
        }
        const subModulePath = path.join(modulePath, subModule);
        const subLstat = fs.lstatSync(subModulePath);
        if (subLstat.isSymbolicLink() || !subLstat.isDirectory()) {
          continue;
        }

        const packageJsonPath = path.join(subModulePath, "package.json");
        checkPackageJson(packageJsonPath);

        // Recurse into nested node_modules if they exist
        const nestedNodeModules = path.join(subModulePath, "node_modules");
        checkNodeModules(nestedNodeModules);
      }
    } else {
      const packageJsonPath = path.join(modulePath, "package.json");
      checkPackageJson(packageJsonPath);

      // Recurse into nested node_modules if they exist
      const nestedNodeModules = path.join(modulePath, "node_modules");
      checkNodeModules(nestedNodeModules);
    }
  }
}

function main() {
  // Only audit the node_modules directory in the current working directory.
  // This is more efficient than scanning the entire project and avoids
  // false positives in build artifacts or source code.
  checkNodeModules("node_modules");
}

main();
