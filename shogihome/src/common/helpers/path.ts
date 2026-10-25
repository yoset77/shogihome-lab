export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function trimTrailingPathSeparators(path: string): string {
  const prefix = path.startsWith("server://") ? "server://" : "";
  return prefix + path.slice(prefix.length).replace(/[\\/]+$/, "");
}
