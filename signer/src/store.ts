import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Where a session keeps the small files that must survive a restart: its signing log and open executions. */
export interface SessionStore {
  read(name: string): string | undefined;
  write(name: string, data: string): void;
}

/** Files under `dir`, written atomically (temporary file, then rename). */
export function fileStore(dir: string): SessionStore {
  return {
    read(name) {
      const path = join(dir, name);
      return existsSync(path) ? readFileSync(path, "utf8") : undefined;
    },
    write(name, data) {
      mkdirSync(dir, { recursive: true });
      const temporary = join(dir, `${name}.tmp`);
      writeFileSync(temporary, data);
      renameSync(temporary, join(dir, name));
    },
  };
}

/** Keeps everything in memory: the command-line server and tests. */
export function memoryStore(): SessionStore {
  const files = new Map<string, string>();
  return { read: (name) => files.get(name), write: (name, data) => void files.set(name, data) };
}
