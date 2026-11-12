import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import { getDocumentProxy } from "unpdf";
import * as XLSX from "xlsx";
import { z } from "zod";
import { HOME_DIR, isSensitive, loadConfig, underRoot, canWrite } from "./config.js";
import { refreshIfStale } from "./scanner.js";
import { getFile } from "./search.js";

/** Edits Claude can propose. Nothing is written until the user presses the button on the confirm card. */
export const EditSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("replace_text"), find: z.string().min(1), replace: z.string(), all: z.boolean().optional() }),
  z.object({ op: z.literal("insert_paragraph"), after: z.string().min(1), text: z.string().min(1) }),
  z.object({ op: z.literal("set_cell"), sheet: z.string().optional(), cell: z.string(), value: z.union([z.string(), z.number()]) }),
  z.object({ op: z.literal("delete_pages"), pages: z.array(z.number().int().min(1)).min(1) }),
  z.object({ op: z.literal("rotate_pages"), pages: z.array(z.number().int().min(1)).min(1), degrees: z.union([z.literal(90), z.literal(180), z.literal(270)]) }),
]);
export type Edit = z.infer<typeof EditSchema>;
export type EditAction = { type: "edit"; fileId: number; name: string; ext: string; edits: Edit[]; lines: string[]; note: string | null };

const BACKUPS = path.join(HOME_DIR, "data", "backups");
const EDITABLE = new Set(["docx", "xlsx", "pdf"]);
const short = (s: string, n = 60) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

interface Applied { buf: Uint8Array; lines: string[]; note?: string }

/** Find every non-overlapping match, exact case first, then ignoring case. */
function matchAll(text: string, find: string): [number, number][] {
  for (const flags of ["g", "gi"]) {
    const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    const out = [...text.matchAll(re)].map((m) => [m.index!, m.index! + m[0].length] as [number, number]);
    if (out.length) return out;
  }
  return [];
}

// ───────────────────────────── Word ─────────────────────────────

const W_T = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
const PARA = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;

/** Text is split across runs in Word files, so match per paragraph and write the change into the first run it touches (keeps formatting). */
function replaceInXml(xml: string, find: string, rep: string, all: boolean, budget: { left: number }): { xml: string; count: number } {
  let count = 0;
  const out = xml.replace(PARA, (para) => {
    if (budget.left <= 0) return para;
    const segs = [...para.matchAll(W_T)].map((m) => unesc(m[1]));
    if (!segs.length) return para;
    const text = segs.join("");
    let hits = matchAll(text, find);
    if (!hits.length) return para;
    if (!all) hits = hits.slice(0, budget.left);
    else hits = hits.slice(0, Math.max(budget.left, 0));
    const starts: number[] = [];
    segs.reduce((n, s, i) => ((starts[i] = n), n + s.length), 0);
    for (const [s, e] of [...hits].reverse()) {
      let i = starts.findIndex((st, k) => s >= st && s < st + segs[k].length);
      if (i < 0) continue;
      for (let first = true; i < segs.length && starts[i] < e; i++, first = false) {
        const a = Math.max(s, starts[i]) - starts[i];
        const b = Math.min(e, starts[i] + segs[i].length) - starts[i];
        segs[i] = segs[i].slice(0, a) + (first ? rep : "") + segs[i].slice(b);
      }
    }
    count += hits.length;
    budget.left -= hits.length;
    let k = 0;
    return para.replace(W_T, () => `<w:t xml:space="preserve">${esc(segs[k++])}</w:t>`);
  });
  return { xml: out, count };
}

async function applyDocx(buf: Buffer, edits: Edit[]): Promise<Applied> {
  const zip = await JSZip.loadAsync(buf);
  const parts = Object.keys(zip.files).filter((n) => /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(n));
  if (!zip.files["word/document.xml"]) throw new Error("this doesn't look like a Word document");
  const xml: Record<string, string> = {};
  for (const n of parts) xml[n] = await zip.files[n].async("string");
  const lines: string[] = [];
  for (const e of edits) {
    if (e.op === "replace_text") {
      const budget = { left: e.all === false ? 1 : Infinity };
      let total = 0;
      for (const n of parts) { const r = replaceInXml(xml[n], e.find, e.replace, e.all !== false, budget); xml[n] = r.xml; total += r.count; }
      if (!total) throw new Error(`couldn't find “${short(e.find)}” in the document (it must match the text exactly)`);
      lines.push(`“${short(e.find)}” → ${e.replace ? `“${short(e.replace)}”` : "(removed)"}${total > 1 ? `  · ${total} places` : ""}`);
    } else if (e.op === "insert_paragraph") {
      let done = false;
      xml["word/document.xml"] = xml["word/document.xml"].replace(PARA, (para) => {
        if (done) return para;
        const text = [...para.matchAll(W_T)].map((m) => unesc(m[1])).join("");
        if (!matchAll(text, e.after).length) return para;
        done = true;
        const pPr = para.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] ?? "";
        const rPr = para.match(/<w:r\b[^>]*>\s*(<w:rPr>[\s\S]*?<\/w:rPr>)/)?.[1] ?? "";
        const mk = (t: string) => `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`;
        return para + e.text.split(/\r?\n/).filter((t) => t.trim()).map(mk).join("");
      });
      if (!done) throw new Error(`couldn't find the paragraph containing “${short(e.after)}”`);
      lines.push(`new paragraph after “${short(e.after, 40)}”: “${short(e.text)}”`);
    } else throw new Error(`“${e.op}” can't be done on a Word file`);
  }
  for (const n of parts) zip.file(n, xml[n]);
  return { buf: await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }), lines };
}

// ───────────────────────────── Excel ─────────────────────────────

const colNum = (s: string) => [...s].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);

async function sheetPath(zip: JSZip, sheet?: string): Promise<{ file: string; name: string }> {
  const wb = await zip.files["xl/workbook.xml"]?.async("string");
  const rels = await zip.files["xl/_rels/workbook.xml.rels"]?.async("string");
  if (!wb || !rels) throw new Error("this doesn't look like an Excel workbook");
  const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({
    name: unesc(/\bname="([^"]*)"/.exec(m[0])?.[1] ?? ""), rid: /\br:id="([^"]*)"/.exec(m[0])?.[1] ?? "",
  }));
  const s = sheet ? sheets.find((x) => x.name.toLowerCase() === sheet.toLowerCase()) : sheets[0];
  if (!s) throw new Error(`no sheet called “${sheet}” (sheets: ${sheets.map((x) => x.name).join(", ")})`);
  const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((r) => new RegExp(`\\bId="${s.rid}"`).test(r));
  const target = /\bTarget="([^"]*)"/.exec(rel ?? "")?.[1];
  if (!target) throw new Error("couldn't locate that sheet in the file");
  return { file: target.startsWith("/") ? target.slice(1) : "xl/" + target, name: s.name };
}

async function sharedStrings(zip: JSZip): Promise<string[]> {
  const x = await zip.files["xl/sharedStrings.xml"]?.async("string");
  if (!x) return [];
  return [...x.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => [...m[1].matchAll(/<t\b[^>]*>([^<]*)<\/t>/g)].map((t) => unesc(t[1])).join(""));
}

const ROW = /<row\b[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g;
const CELL = /<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g;

function cellXml(ref: string, style: string, value: string | number): string {
  const s = style ? ` s="${style}"` : "";
  if (typeof value === "string" && value.startsWith("=")) return `<c r="${ref}"${s}><f>${esc(value.slice(1))}</f></c>`;
  if (typeof value === "number" || /^-?(0|[1-9]\d*)(\.\d+)?$/.test(value.trim())) return `<c r="${ref}"${s}><v>${Number(value)}</v></c>`;
  if (value === "") return `<c r="${ref}"${s}/>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(String(value))}</t></is></c>`;
}

function setCell(xml: string, ref: string, value: string | number, strings: string[]): { xml: string; old: string } {
  const m = /^([A-Z]{1,3})([1-9]\d*)$/.exec(ref.toUpperCase());
  if (!m) throw new Error(`“${ref}” isn't a cell address (use something like B7)`);
  const [, col, rowN] = m;
  ref = col + rowN;
  let old = "";
  xml = xml.replace(/<sheetData\b[^>]*\/>/, "<sheetData></sheetData>");
  if (!/<sheetData\b/.test(xml)) throw new Error("that sheet has no data section");
  const from = xml.indexOf("<sheetData"), end = xml.indexOf("</sheetData>");
  const head = xml.slice(0, xml.indexOf(">", from) + 1), body = xml.slice(head.length, end), tail = xml.slice(end);
  const rows = [...body.matchAll(ROW)].map((r) => r[0]);
  const rowOf = (r: string) => Number(/\br="(\d+)"/.exec(r.match(/<row\b[^>]*>/)![0])?.[1]);
  const patch = (row: string): string => {
    const tag = row.match(/<row\b[^>]*?(\/?)>/)!;
    const inner = tag[1] ? "" : row.slice(tag[0].length, row.length - "</row>".length);
    const openTag = tag[0].replace(/\/>$/, ">");
    const cells = [...inner.matchAll(CELL)].map((c) => c[0]);
    const refOf = (c: string) => /\br="([A-Z]+)\d+"/.exec(c)?.[1] ?? "";
    const i = cells.findIndex((c) => refOf(c) === col);
    let style = "";
    if (i >= 0) {
      const c = cells[i];
      style = /\bs="(\d+)"/.exec(c.match(/<c\b[^>]*>/)![0])?.[1] ?? "";
      const v = /<v>([^<]*)<\/v>/.exec(c)?.[1];
      const t = /\bt="(\w+)"/.exec(c.match(/<c\b[^>]*>/)![0])?.[1];
      const f = /<f\b[^>]*>([^<]*)<\/f>/.exec(c)?.[1];
      old = t === "inlineStr" ? unesc([...c.matchAll(/<t\b[^>]*>([^<]*)<\/t>/g)].map((x) => x[1]).join(""))
        : t === "s" && v !== undefined ? strings[Number(v)] ?? "" : f ? "=" + unesc(f) : v !== undefined ? unesc(v) : "";
      cells[i] = cellXml(ref, style, value);
    } else {
      const at = cells.findIndex((c) => colNum(refOf(c)) > colNum(col));
      at < 0 ? cells.push(cellXml(ref, style, value)) : cells.splice(at, 0, cellXml(ref, style, value));
    }
    return `${openTag}${cells.join("")}</row>`;
  };
  const n = Number(rowN);
  const k = rows.findIndex((r) => rowOf(r) === n);
  if (k >= 0) rows[k] = patch(rows[k]);
  else {
    const fresh = patch(`<row r="${n}"/>`);
    const at = rows.findIndex((r) => rowOf(r) > n);
    at < 0 ? rows.push(fresh) : rows.splice(at, 0, fresh);
  }
  // grow the declared used-range so readers (Excel, SheetJS) see a cell that landed outside it
  const dim = /<dimension\s+ref="([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?"\s*\/>/.exec(head);
  let out = head;
  if (dim) {
    const c1 = dim[1], r1 = Number(dim[2]), c2 = dim[3] ?? dim[1], r2 = Number(dim[4] ?? dim[2]);
    const lastCol = colNum(col) > colNum(c2) ? col : c2, lastRow = Math.max(r2, n);
    out = head.replace(dim[0], `<dimension ref="${c1}${r1}:${lastCol}${lastRow}"/>`);
  }
  return { xml: out + rows.join("") + tail, old };
}

async function applyXlsx(buf: Buffer, edits: Edit[]): Promise<Applied> {
  const zip = await JSZip.loadAsync(buf);
  const strings = await sharedStrings(zip);
  const sheets = new Map<string, string>();
  const lines: string[] = [];
  let formula = false;
  for (const e of edits) {
    if (e.op !== "set_cell") throw new Error(`“${e.op}” can't be done on an Excel file`);
    const sp = await sheetPath(zip, e.sheet);
    const xml = sheets.get(sp.file) ?? (await zip.files[sp.file]?.async("string"));
    if (!xml) throw new Error("couldn't read that sheet");
    const r = setCell(xml, e.cell, e.value, strings);
    sheets.set(sp.file, r.xml);
    if (typeof e.value === "string" && e.value.startsWith("=")) formula = true;
    const shown = (v: string | number) => (v === "" ? "(empty)" : `“${short(String(v), 40)}”`);
    lines.push(`${sp.name}!${e.cell.toUpperCase()}:  ${shown(r.old)} → ${shown(e.value)}`);
  }
  for (const [f, x] of sheets) zip.file(f, x);
  // formulas elsewhere must recalculate when Excel opens the file, and a stale calc chain would make Excel "repair" it
  let wb = await zip.files["xl/workbook.xml"].async("string");
  wb = /<calcPr\b/.test(wb)
    ? wb.replace(/<calcPr\b([^>]*?)(\/?)>/, (_m, a: string, s: string) => `<calcPr${a.replace(/\sfullCalcOnLoad="[^"]*"/, "")} fullCalcOnLoad="1"${s}>`)
    : wb.replace(/(<extLst\b|<\/workbook>)/, '<calcPr fullCalcOnLoad="1"/>$1');
  zip.file("xl/workbook.xml", wb);
  if (zip.files["xl/calcChain.xml"]) {
    zip.remove("xl/calcChain.xml");
    const rels = await zip.files["xl/_rels/workbook.xml.rels"].async("string");
    zip.file("xl/_rels/workbook.xml.rels", rels.replace(/<Relationship\b[^>]*calcChain[^>]*\/>/g, ""));
    const ct = await zip.files["[Content_Types].xml"].async("string");
    zip.file("[Content_Types].xml", ct.replace(/<Override\b[^>]*calcChain[^>]*\/>/g, ""));
  }
  return { buf: await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }), lines, note: formula ? "Formulas recalculate when the file is opened in Excel." : undefined };
}

/** Cell addresses and values, so the model can say exactly which cell to change. */
export function readCells(fileId: number, sheet?: string, limit = 400): string {
  const f = getFile(fileId);
  if (!f || f.ext !== "xlsx") throw new Error("not an .xlsx file");
  const wb = XLSX.read(fs.readFileSync(f.path), { type: "buffer" });
  const names = sheet ? wb.SheetNames.filter((n) => n.toLowerCase() === sheet.toLowerCase()) : wb.SheetNames;
  if (!names.length) throw new Error(`no sheet called “${sheet}” (sheets: ${wb.SheetNames.join(", ")})`);
  const out: string[] = [];
  for (const n of names) {
    out.push(`[sheet ${n}]`);
    const ws = wb.Sheets[n];
    for (const addr of Object.keys(ws).filter((k) => !k.startsWith("!"))) {
      if (out.length > limit) return out.join("\n") + "\n…(more cells; ask for one sheet)";
      const c = ws[addr] as XLSX.CellObject;
      if (c.v === undefined || c.v === "") continue;
      out.push(`${addr}=${c.f ? `=${c.f} (${c.v})` : String(c.v).slice(0, 120)}`);
    }
  }
  return out.join("\n");
}

// ───────────────────────────── PDF ─────────────────────────────

interface Spot { page: number; x: number; y: number; w: number; size: number }

/** Where a phrase sits on each page, from the PDF's own text positions. */
async function findInPdf(buf: Buffer, find: string, all: boolean, font: { widthOfTextAtSize(t: string, s: number): number }): Promise<Spot[]> {
  const pdf = await getDocumentProxy(Uint8Array.from(buf));
  const spots: Spot[] = [];
  for (let p = 1; p <= pdf.numPages && (all || !spots.length); p++) {
    const items = ((await (await pdf.getPage(p)).getTextContent()).items as { str?: string; transform?: number[]; width?: number }[])
      .filter((i) => typeof i.str === "string" && i.transform && i.str !== "") as { str: string; transform: number[]; width: number }[];
    const lines: typeof items[] = [];
    for (const it of items) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last[0].transform[5] - it.transform[5]) < 1.5) last.push(it); else lines.push([it]);
    }
    for (const line of lines) {
      const text = line.map((i) => i.str).join("");
      for (const [s, e] of matchAll(text, find)) {
        let at = 0, x0 = 0, x1 = 0, item = line[0];
        // where inside a text run a character offset falls: real glyph widths beat counting characters
        const frac = (str: string, k: number) => {
          try { const t = font.widthOfTextAtSize(str, 10); if (t > 0) return font.widthOfTextAtSize(str.slice(0, k), 10) / t; } catch { /* unencodable: count characters */ }
          return k / str.length;
        };
        for (const it of line) {
          const len = it.str.length;
          if (s >= at && s < at + len) { item = it; x0 = it.transform[4] + it.width * frac(it.str, s - at); }
          if (e > at && e <= at + len) x1 = it.transform[4] + it.width * frac(it.str, e - at);
          at += len;
        }
        if (x1 > x0) spots.push({ page: p, x: x0, y: item.transform[5], w: x1 - x0, size: Math.hypot(item.transform[0], item.transform[1]) || 11 });
      }
    }
  }
  return all ? spots : spots.slice(0, 1);
}

async function applyPdf(buf: Buffer, edits: Edit[]): Promise<Applied> {
  let doc: PDFDocument;
  try { doc = await PDFDocument.load(buf); } catch (e) { throw new Error(`can't open this PDF for editing (${short((e as Error).message, 80)}) — it may be password-protected`); }
  const font = await doc.embedStandardFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const lines: string[] = [];
  const check = (list: number[]) => { const bad = list.find((n) => n > pages.length); if (bad) throw new Error(`the PDF has ${pages.length} pages, there is no page ${bad}`); };
  const drop = new Set<number>();
  for (const e of edits) {
    if (e.op === "replace_text") {
      const spots = await findInPdf(buf, e.find, e.all !== false, font);
      if (!spots.length) throw new Error(`couldn't find “${short(e.find)}” in the PDF (a scanned PDF has no text to find)`);
      for (const s of spots) {
        const page = pages[s.page - 1];
        const pad = s.size * 0.12;
        page.drawRectangle({ x: s.x - pad, y: s.y - s.size * 0.25, width: s.w + pad * 2, height: s.size * 1.25, color: rgb(1, 1, 1) });
        if (e.replace) {
          let size = s.size;
          try {
            const w = font.widthOfTextAtSize(e.replace, size);
            if (w > s.w + pad * 2) size = Math.max(size * 0.7, (size * (s.w + pad * 2)) / w);
            page.drawText(e.replace, { x: s.x, y: s.y, size, font, color: rgb(0, 0, 0) });
          } catch { throw new Error(`“${short(e.replace)}” has characters this PDF editor can't write (plain Latin letters, digits and common symbols only)`); }
        }
      }
      const where = [...new Set(spots.map((s) => s.page))];
      lines.push(`“${short(e.find)}” → ${e.replace ? `“${short(e.replace)}”` : "(blanked)"}  · page${where.length > 1 ? "s" : ""} ${where.join(", ")}${spots.length > 1 ? ` (${spots.length}×)` : ""}`);
    } else if (e.op === "rotate_pages") {
      check(e.pages);
      for (const n of e.pages) pages[n - 1].setRotation(degrees((pages[n - 1].getRotation().angle + e.degrees) % 360));
      lines.push(`rotate page${e.pages.length > 1 ? "s" : ""} ${e.pages.join(", ")} by ${e.degrees}°`);
    } else if (e.op === "delete_pages") {
      check(e.pages);
      e.pages.forEach((n) => drop.add(n));
      lines.push(`delete page${e.pages.length > 1 ? "s" : ""} ${e.pages.join(", ")}`);
    } else throw new Error(`“${e.op}” can't be done on a PDF`);
  }
  if (drop.size >= pages.length) throw new Error("that would delete every page");
  [...drop].sort((a, b) => b - a).forEach((n) => doc.removePage(n - 1));
  const replaced = edits.some((e) => e.op === "replace_text");
  return {
    buf: await doc.save(), lines,
    note: replaced ? "PDF text is covered with a white box and the new text is written on top. The old words stay in the file's data underneath, so this is not a safe way to redact." : undefined,
  };
}

// ───────────────────────────── plan / apply / undo ─────────────────────────────

const editable = (id: number) => {
  const cfg = loadConfig();
  const f = getFile(id);
  if (!f || isSensitive(f.path, cfg) || !canWrite(f.path)) throw new Error("that file isn't in a folder Yab may change (only folders you ticked, or your home folder with Full PC)");
  if (!EDITABLE.has(f.ext)) throw new Error(`editing works on PDF, Word (.docx) and Excel (.xlsx) files, not .${f.ext}${f.ext === "doc" || f.ext === "xls" ? " (save it as the newer format first)" : ""}`);
  return f;
};

const run = (ext: string, buf: Buffer, edits: Edit[]) => (ext === "docx" ? applyDocx(buf, edits) : ext === "xlsx" ? applyXlsx(buf, edits) : applyPdf(buf, edits));

/** Dry run: proves the edit is possible and describes it for the confirm card, without touching the file. */
export async function planEdit(fileId: number, edits: Edit[]): Promise<EditAction> {
  const f = editable(fileId);
  if (!edits.length) throw new Error("no edits given");
  if (edits.length > 40) throw new Error("too many edits at once");
  await refreshIfStale(f);
  const r = await run(f.ext, fs.readFileSync(f.path), edits);
  return { type: "edit", fileId, name: f.name, ext: f.ext, edits, lines: r.lines, note: r.note ?? null };
}

/** Keeps a copy of the original in data/backups, then swaps the new version in atomically. Only called from the confirm card. */
export async function executeEdit(fileId: number, edits: Edit[]): Promise<{ undo: string; message: string }> {
  const f = editable(fileId);
  const before = fs.readFileSync(f.path);
  const r = await run(f.ext, before, edits);
  fs.mkdirSync(BACKUPS, { recursive: true });
  const backup = `${Date.now()}__${f.id}__${f.name}`;
  fs.writeFileSync(path.join(BACKUPS, backup), before);
  const tmp = path.join(f.folder, `.sleepy-${process.pid}-${f.name}.tmp`);
  try {
    fs.writeFileSync(tmp, r.buf);
    fs.renameSync(tmp, f.path);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(code === "EBUSY" || code === "EPERM" || code === "EACCES" ? "the file is open in another program that has it locked — close it there and try again" : (e as Error).message);
  }
  await refreshIfStale({ ...f, mtime: 0 });
  return { undo: backup, message: `Saved. ${r.note ?? ""}`.trim() };
}

export async function undoEdit(fileId: number, backup: string): Promise<string> {
  const f = editable(fileId);
  if (path.basename(backup) !== backup || !backup.includes(`__${f.id}__`)) throw new Error("that backup doesn't belong to this file");
  const src = path.join(BACKUPS, backup);
  if (!fs.existsSync(src)) throw new Error("the backup is gone");
  const tmp = path.join(f.folder, `.sleepy-${process.pid}-${f.name}.tmp`);
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, f.path);
  await refreshIfStale({ ...f, mtime: 0 });
  return "Put back the way it was.";
}
