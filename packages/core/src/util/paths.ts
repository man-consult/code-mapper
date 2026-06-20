import path from "node:path";

/**
 * Defense-in-depth: assert that `target` resolves to a location inside `root`.
 * Throws on directory-traversal attempts. Returns the resolved absolute path.
 * (Corridor guardrail: constrain all reads within the user-provided target dir.)
 */
export function assertInside(root: string, target: string): string {
  const r = path.resolve(root);
  const t = path.resolve(target);
  const rel = path.relative(r, t);
  if (rel === "") return t;
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`Path escapes scan root: ${target}`);
  }
  return t;
}

/** Stable node id: POSIX-style path relative to root. */
export function toId(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

const RESTRICTED = new Set([
  "/etc", "/usr", "/bin", "/sbin", "/var", "/opt",
  "/System", "/Library", "/boot", "/dev", "/proc",
]);

/**
 * Refuse to write the vault into the filesystem root, a known system directory,
 * or the user's home directory itself.
 * (Corridor guardrail: verify output destination is not a restricted directory.)
 */
export function assertSafeOutputDir(dir: string): string {
  const resolved = path.resolve(dir);
  const fsRoot = path.parse(resolved).root;
  if (resolved === fsRoot || RESTRICTED.has(resolved)) {
    throw new Error(`Refusing to write to restricted directory: ${resolved}`);
  }
  const home = process.env.HOME;
  if (home && resolved === path.resolve(home)) {
    throw new Error(`Refusing to write directly into home directory: ${resolved}`);
  }
  return resolved;
}
