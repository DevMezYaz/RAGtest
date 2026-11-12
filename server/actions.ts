import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expand, isSensitive, loadConfig, underRoot, canWrite } from "./config.js";
import { requestScan } from "./scanner.js";
import { getFile } from "./search.js";
import type { EditAction } from "./editor.js";

/** Things Claude can propose but only the user can run (the UI shows a confirm card first). */
export type Action =
  | EditAction
  | { type: "move"; fileId: number; name: string; from: string; to: string }
  | { type: "email"; fileId: number | null; name: string | null; to: string; subject: string; body: string; attach: boolean };

const HOME = os.homedir();
const tilde = (p: string) => (p === HOME ? "~" : p.startsWith(HOME + path.sep) ? "~" + p.slice(HOME.length) : p).replace(/\\/g, "/");
const inHome = (p: string) => p === HOME || p.startsWith(HOME + path.sep);

const sharedFile = (id: number) => {
  const cfg = loadConfig();
  const f = getFile(id);
  if (!f || isSensitive(f.path, cfg) || !canWrite(f.path)) throw new Error("that file isn't in a folder Yab may change (only folders you ticked, or your home folder with Full PC)");
  return f;
};

/** Accepts a full path, ~/path, or just a folder name ("Invoices", "Documents/Invoices") found inside the shared folders. */
function resolveFolder(dest: string): string {
  const d = dest.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!d) throw new Error("no destination given");
  if (d.startsWith("~") || path.isAbsolute(d)) return path.resolve(expand(d));
  const want = "/" + d.replace(/^\.?\//, "").toLowerCase();
  const found: string[] = [];
  let seen = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 4 || seen > 6000 || found.length > 6) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
      seen++;
      const full = path.join(dir, e.name);
      if (full.replace(/\\/g, "/").toLowerCase().endsWith(want)) found.push(full);
      walk(full, depth + 1);
    }
  };
  for (const r of loadConfig().folders) {
    if (r.replace(/\\/g, "/").toLowerCase().endsWith(want)) found.push(r);
    walk(r, 0);
  }
  if (found.length === 1) return found[0];
  if (!found.length) throw new Error(`no folder called "${dest}" inside the shared folders — ask the user for the full path`);
  throw new Error(`several folders match "${dest}": ${found.slice(0, 5).map(tilde).join(", ")} — ask the user which one`);
}

export function planMove(fileId: number, dest: string): Action {
  const f = sharedFile(fileId);
  const dir = resolveFolder(dest);
  if (!inHome(dir) || dir.split(path.sep).some((s) => s.startsWith("."))) throw new Error("files can only be moved to normal folders inside your home folder");
  if (isSensitive(dir + path.sep, loadConfig())) throw new Error("that destination isn't allowed");
  if (path.resolve(f.folder) === dir) throw new Error("the file is already in that folder");
  if (!fs.existsSync(dir) && !fs.existsSync(path.dirname(dir))) throw new Error("that folder and its parent don't exist");
  if (fs.existsSync(path.join(dir, f.name))) throw new Error(`${tilde(dir)} already has a file called ${f.name}`);
  return { type: "move", fileId, name: f.name, from: tilde(f.folder), to: tilde(dir) };
}

export function executeMove(fileId: number, dest: string): { to: string } {
  const plan = planMove(fileId, dest);
  if (plan.type !== "move") throw new Error("bad plan");
  const f = sharedFile(fileId);
  const dir = path.resolve(expand(plan.to));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir); // creates one new folder level at most (planMove checked the parent exists)
  const target = path.join(dir, f.name);
  try {
    fs.renameSync(f.path, target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    fs.copyFileSync(f.path, target, fs.constants.COPYFILE_EXCL); // another drive: copy, then remove the original
    fs.unlinkSync(f.path);
  }
  requestScan();
  return { to: tilde(target) };
}

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]{2,}$/;

export function planEmail(a: { to: string; subject: string; body: string; fileId?: number | null; attach?: boolean }): Action {
  const to = a.to.trim();
  if (!EMAIL.test(to)) throw new Error("that isn't a valid email address — ask the user for it");
  if (!a.subject.trim() || !a.body.trim()) throw new Error("subject and body are required");
  const f = a.fileId ? sharedFile(a.fileId) : null;
  return { type: "email", fileId: f?.id ?? null, name: f?.name ?? null, to, subject: a.subject.trim().slice(0, 200), body: a.body.trim().slice(0, 6000), attach: !!(a.attach && f) };
}

const run = (cmd: string, args: string[], stdin?: string) =>
  new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: [stdin ? "pipe" : "ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr?.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split("\n").pop() || `exit ${code}`))));
    if (stdin) p.stdin!.end(stdin);
  });

const MAIL_SCRIPT = `on run argv
  set theTo to item 1 of argv
  set theSubject to item 2 of argv
  set theBody to item 3 of argv
  set thePath to item 4 of argv
  set doSend to (item 5 of argv is "send")
  tell application "Mail"
    set m to make new outgoing message with properties {subject:theSubject, content:theBody & return & return, visible:(not doSend)}
    tell m
      make new to recipient at end of to recipients with properties {address:theTo}
      if thePath is not "" then
        tell content to make new attachment with properties {file name:(POSIX file thePath)} at after the last paragraph
      end if
    end tell
    if doSend then
      if thePath is not "" then delay 2 -- let the attachment finish loading before sending
      send m
    else
      activate
    end if
  end tell
end run`;

/**
 * "send": Mail sends it straight away. "mail": opens the draft in Mail. "mailto": opens the default mail app (no attachment).
 * Only ever called from the confirm card's buttons, after the user has read the whole draft there.
 */
export async function executeEmail(a: Parameters<typeof planEmail>[0], via: "send" | "mail" | "mailto"): Promise<string> {
  const plan = planEmail(a);
  if (plan.type !== "email") throw new Error("bad plan");
  const file = plan.attach && plan.fileId ? sharedFile(plan.fileId).path : "";
  if (via !== "mailto" && process.platform === "darwin") {
    await run("osascript", ["-", plan.to, plan.subject, plan.body, file, via], MAIL_SCRIPT);
    if (via === "send") return `Sent to ${plan.to}${file ? " with the file attached" : ""}. It's in Mail's Sent folder.`;
    return file ? "Draft opened in Mail with the file attached." : "Draft opened in Mail.";
  }
  const url = `mailto:${encodeURIComponent(plan.to)}?subject=${encodeURIComponent(plan.subject)}&body=${encodeURIComponent(plan.body.slice(0, 1800))}`;
  if (process.platform === "darwin") await run("open", [url]);
  else if (process.platform === "win32") await run("cmd", ["/c", "start", "", url.replace(/&/g, "^&")]);
  else await run("xdg-open", [url]);
  return "Draft opened in your mail app (attach the file yourself — mail links can't attach).";
}
