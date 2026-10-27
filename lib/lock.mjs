import { mkdirSync, openSync, readFileSync, rmSync, writeSync, closeSync } from "node:fs";
import { dirname } from "node:path";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// One loop at a time. A lock left by a dead process is taken over.
export function acquireLock(file) {
  mkdirSync(dirname(file), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      const release = () => rmSync(file, { force: true });
      process.on("exit", release);
      for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
      return release;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const pid = Number(readFileSync(file, "utf8"));
      if (pid && alive(pid)) return null;
      rmSync(file, { force: true });
    }
  }
  return null;
}
