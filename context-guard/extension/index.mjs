import { readFileSync } from "node:fs";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import config from "../config.cjs";
import { PLUGIN_ID, registerGuard } from "./core.mjs";

// 仅访问本插件私有目录；不读会话文件、工作区、凭据或宿主设置。
const directory = join(process.env.PI_DESKTOP_DATA_DIR || join(homedir(), ".pi-desktop"), "plugins", "data", PLUGIN_ID);
function readSettings() {
  try {
    const raw = readFileSync(join(directory, "settings.json"), "utf8");
    if (raw.length > 65536) return { ...config.DEFAULTS };
    return config.normalize(JSON.parse(raw));
  } catch { return { ...config.DEFAULTS }; }
}
function readPrivate(prefix, id) {
  try {
    const hash = createHash("sha256").update(id).digest("hex").slice(0, 24);
    const raw = readFileSync(join(directory, `${prefix}-${hash}.json`), "utf8");
    return raw.length <= 32768 ? JSON.parse(raw) : {};
  } catch { return {}; }
}
let publications = Promise.resolve();
function publish(status) {
  const operation = publications.catch(() => {}).then(async () => {
    const name = `status-${createHash("sha256").update(status.sessionId).digest("hex").slice(0, 24)}.json`;
    const destination = join(directory, name);
    const temporary = `${destination}.${process.pid}.tmp`;
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, JSON.stringify(status), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, destination);
  });
  publications = operation;
  return operation;
}
export default function contextGuard(pi) {
  return registerGuard(pi, { readSettings, publish, readState: id => readPrivate("status", id), readControl: id => readPrivate("system", id) });
}
