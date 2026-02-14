import fs from "fs";
import path from "path";

/**
 * Recursively lists kifu files under the base directory.
 * @param baseDir Absolute path to the base directory.
 * @returns Relative paths of kifu files.
 */
export const getKifuList = async (baseDir: string): Promise<string[]> => {
  const getFiles = async (dir: string): Promise<string[]> => {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const files = await Promise.all(
      entries.map((entry) => {
        const res = path.resolve(dir, entry.name);
        return entry.isDirectory() ? getFiles(res) : res;
      }),
    );
    return Array.prototype.concat(...files);
  };

  if (!fs.existsSync(baseDir)) {
    return [];
  }

  const allFiles = await getFiles(baseDir);
  return allFiles
    .filter((file) => {
      const ext = path.extname(file).toLowerCase();
      return [".kif", ".kifu", ".ki2", ".ki2u", ".csa", ".jkf"].includes(ext);
    })
    .map((file) => path.relative(baseDir, file));
};

/**
 * Resolves a relative path to an absolute path and verifies it's within the base directory.
 * @param baseDir Absolute path to the base directory.
 * @param relPath Relative path to resolve.
 * @returns Absolute path or null if invalid or outside base directory.
 */
export const resolveKifuPath = (baseDir: string, relPath: string): string | null => {
  if (!relPath) {
    return null;
  }
  const fullPath = path.resolve(baseDir, relPath);
  // Security: Ensure the resolved path is inside the base directory
  if (!fullPath.startsWith(baseDir)) {
    return null;
  }
  return fullPath;
};
