import { promises as fs } from "node:fs";
import path from "node:path";

export async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch {
    return false;
  }
}

export async function listFiles(dir: string, maxDepth: number): Promise<string[]> {
  const files: string[] = [];
  const fdir = await fs.readdir(dir);
  for (const file of fdir) {
    const fullPath = path.join(dir, file);
    // Use lstat so symbolic links are not traversed as directories.
    const stat = await fs.lstat(fullPath);
    if (stat.isFile()) {
      files.push(fullPath);
    } else if (maxDepth > 0 && stat.isDirectory()) {
      files.push(...(await listFiles(fullPath, maxDepth - 1)));
    }
  }
  return files;
}
