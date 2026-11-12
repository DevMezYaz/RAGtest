import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Where Yab keeps what the user owns (config, index, backups, key). A packaged app sets YAB_HOME to a writable folder; otherwise it's the project folder. */
export const HOME_DIR = process.env.YAB_HOME ? path.resolve(process.env.YAB_HOME) : ROOT;
const CONFIG_PATH = path.join(HOME_DIR, "sleepy.config.json");
export const DB_PATH = path.join(HOME_DIR, "data", "sleepy.db");
// first run of a packaged app: start from the default config shipped inside it
if (HOME_DIR !== ROOT && !fs.existsSync(CONFIG_PATH)) {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.copyFileSync(path.join(ROOT, "sleepy.config.json"), CONFIG_PATH);
}

export interface Config {
  folders: string[];
  excludeFolders: string[];
  /** File names/paths containing any of these (case-insensitive) are never indexed or sent to Claude. */
  sensitivePatterns: string[];
  model: string;
  /** Which key is active when both are set. */
  provider?: "openrouter" | "anthropic";
  openrouterModel?: string;
  maxOutputTokens?: number;
  maxSteps?: number;
  allowedOrigins: string[];
  maxFileMB: number;
  /** Extensions never indexed (binaries, game assets, caches). */
  skipExtensions: string[];
  /** "Full PC" access: every file on this computer, sensitive-looking names included (the folders below are then extras). System and hidden folders are still not walked. */
  fullPc?: boolean;
  /** The user has been shown the Full PC warning and accepted it (the server refuses to switch Full PC on without it). */
  fullPcConfirmed?: boolean;
  /** Spreadsheets larger than this are listed by name but not read (default 10 MB): they are the slowest files to index. */
  maxSheetMB?: number;
  /** Minutes between the automatic background re-scans (default 15). */
  scanIntervalMin?: number;
  /** "offline": no AI model is ever contacted (search only); "online" (default): the AI answers. */
  aiMode?: "online" | "offline";
  /** How much the AI model may see, 1 (private) to 5 (full smart index); 2 = how Yab has always worked. */
  aiLevel?: number;
  /** The model used for the smart-index pass when it has its own key (the key itself lives in .env as INDEX_API_KEY). */
  indexModel?: string;
  /** The user has approved the current (large) smart-index pass; cleared when it finishes. */
  smartApproved?: boolean;
  /** Read the text in images (screenshots, scans) with the system's own OCR so it can be searched (default on). */
  ocr?: boolean;
}

export const expand = (p: string) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

/** Folders that are never walked in full-PC mode: the operating system, installed programs, caches, bins. */
const FULLPC_EXCLUDES = ["Windows", "Program Files", "Program Files (x86)", "ProgramData", "$Recycle.Bin", "System Volume Information", "Recovery", "AppData", "MSOCache",
  "Applications", "System", "private", "usr", "opt", "cores", "bin", "sbin", "etc", "var", "tmp", "Library"];

/** Where "the whole PC" starts: the home folder + shared + external drives on a Mac, every drive letter on Windows. */
export function fullPcRoots(): string[] {
  const roots: string[] = [];
  if (process.platform === "win32") {
    for (const L of "CDEFGHIJKLMNOPQRSTUVWXYZ") { const r = `${L}:\\`; try { fs.readdirSync(r); roots.push(r); } catch { /* no such drive */ } }
  } else {
    roots.push(os.homedir());
    if (fs.existsSync("/Users/Shared")) roots.push("/Users/Shared");
    try {
      for (const d of fs.readdirSync("/Volumes")) {
        const p = path.join("/Volumes", d);
        if (["Recovery", "Preboot", "VM", "Update", "xarts", "iSCPreboot", "Hardware"].includes(d)) continue;   // the system's own helper volumes
        try { if (fs.realpathSync(p) !== "/") roots.push(p); } catch { /* unreadable */ }   // "Macintosh HD" is a link to "/": skip it
      }
    } catch { /* no /Volumes */ }
  }
  return roots;
}

/** True when `p` is inside `root` (a root like C:\ already ends with a separator). */
export const underRoot = (p: string, root: string) => p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

export const isOffline = () => { try { return (JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Config).aiMode === "offline"; } catch { return false; } };

export function loadConfig(): Config {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Config;
  const own = raw.folders.map(expand);
  const folders = raw.fullPc ? [...new Set([...fullPcRoots(), ...own])] : own;
  const excludeFolders = [...raw.excludeFolders.map(expand), ...(raw.fullPc ? FULLPC_EXCLUDES : [])];
  // Full PC is for the case where the user wants EVERY file on the computer findable, so the sensitive-name list is switched off in that mode (the user accepts this in the
  // warning before it can be turned on). In normal folder mode the list applies exactly as before. System / program folders and hidden folders are still not walked.
  const sensitivePatterns = raw.fullPc ? [] : raw.sensitivePatterns;
  return { ...raw, folders, excludeFolders, sensitivePatterns };
}

/**
 * Where Yab may CHANGE things (edit a file, move it, attach it to an email). Reading can cover the whole PC, but writing never does:
 * only the folders the user ticked themselves, plus their home folder when Full PC is on. Never other drives, never system areas.
 */
export function canWrite(filePath: string): boolean {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Config;
  const roots = raw.folders.map(expand);
  if (raw.fullPc) roots.push(os.homedir());
  return roots.some((r) => underRoot(filePath, r));
}

/** What the user ticked in the Access panel (not the expanded full-PC roots). */
export function accessChoice(): { folders: string[]; fullPc: boolean; fullPcConfirmed: boolean } {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Config;
  return { folders: raw.folders.map(expand), fullPc: !!raw.fullPc, fullPcConfirmed: !!raw.fullPcConfirmed };
}

export function saveConfig(patch: Partial<Config>): Config {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const next = { ...raw, ...patch };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  return loadConfig();
}

const reCache = new Map<string, RegExp>();
function patternRe(s: string) {
  let re = reCache.get(s);
  if (!re) {
    const esc = s.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[^a-z0-9]+");
    // a pattern that starts with a dot (".pem", ".env") is an extension: it follows a file name, so it must not need a non-letter before it
    re = new RegExp(`${s.startsWith(".") ? "" : "(?<![a-z0-9])"}${esc}s?(?![a-z0-9])`);
    reCache.set(s, re);
  }
  return re;
}

export function isSensitive(filePath: string, cfg: Config): boolean {
  const p = filePath.toLowerCase();
  return cfg.sensitivePatterns.some((s) => patternRe(s).test(p));
}

export function isExcluded(dirOrFile: string, cfg: Config): boolean {
  const base = path.basename(dirOrFile);
  if (base.startsWith(".")) return true;
  return cfg.excludeFolders.some((e) =>
    path.isAbsolute(e) ? dirOrFile === e || dirOrFile.startsWith(e + path.sep) : base === e,
  );
}
