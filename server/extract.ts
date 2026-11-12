import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import { extractText, getDocumentProxy } from "unpdf";

export type Kind = "pdf" | "doc" | "slides" | "sheet" | "text" | "image" | "other";

const TEXT_EXT = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "yaml", "yml", "xml", "html", "htm", "log", "rtf",
  "py", "js", "ts", "tsx", "jsx", "java", "c", "cpp", "h", "cs", "go", "rb", "php", "sql", "sh", "css", "ipynb", "tex",
]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "svg"]);

export function kindOf(ext: string): Kind {
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "doc";
  if (ext === "pptx") return "slides";
  if (ext === "xlsx" || ext === "xls") return "sheet";
  if (TEXT_EXT.has(ext)) return "text";
  if (IMAGE_EXT.has(ext)) return "image";
  return "other";
}

/** Split long text into pseudo-pages at paragraph boundaries. */
export function paginate(text: string, target = 2800): string[] {
  const paras = text.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  const pages: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.trim()) pages.push(cur.trim());
    cur = "";
  };
  for (const p of paras) {
    if (p.length > target * 1.5) {
      flush();
      for (let i = 0; i < p.length; i += target) pages.push(p.slice(i, i + target).trim());
      continue;
    }
    if (cur.length + p.length > target) flush();
    cur += (cur ? "\n\n" : "") + p;
  }
  flush();
  return pages.filter(Boolean);
}

/** Returns one string per page (PDF page / slide / sheet / pseudo-page). Empty array = no text. */
export async function extractPages(file: string, ext: string): Promise<string[]> {
  switch (kindOf(ext)) {
    case "pdf": {
      const buf = await fs.readFile(file);
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const { text } = await extractText(pdf, { mergePages: false });
      return (text as string[]).map((t) => t.replace(/[ \t]+/g, " ").trim());
    }
    case "doc": {
      const { value } = await mammoth.extractRawText({ path: file });
      return paginate(value);
    }
    case "slides": {
      const zip = await JSZip.loadAsync(await fs.readFile(file));
      const slides = Object.keys(zip.files)
        .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
        .sort((a, b) => parseInt(a.match(/\d+/)![0]) - parseInt(b.match(/\d+/)![0]));
      const out: string[] = [];
      for (const n of slides) {
        const xml = await zip.files[n].async("string");
        const parts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decodeXml(m[1]));
        out.push(parts.join("\n"));
      }
      return out;
    }
    case "sheet": {
      const wb = XLSX.read(await fs.readFile(file), { type: "buffer" });
      const out: string[] = [];
      for (const name of wb.SheetNames) {
        const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
        const chunks = paginate(csv, 3000);
        chunks.forEach((c, i) => out.push(`[${name}${chunks.length > 1 ? ` · part ${i + 1}` : ""}]\n${c}`));
      }
      return out;
    }
    case "text": {
      let raw = await fs.readFile(file, "utf8");
      if (ext === "ipynb") {
        try {
          const nb = JSON.parse(raw);
          raw = (nb.cells ?? [])
            .map((c: { cell_type: string; source: string[] | string }) =>
              `[${c.cell_type}]\n${Array.isArray(c.source) ? c.source.join("") : c.source}`)
            .join("\n\n");
        } catch { /* fall through with raw */ }
      }
      if (raw.includes("\u0000")) return [];
      return paginate(raw);
    }
    default:
      return [];
  }
}

function decodeXml(s: string) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

const STOP = new Set(("about above after again also been before being below between both could did does doing down during each few " +
  "from further have having here hers himself how into just more most must once only other ours over same shall should some such than " +
  "that their them then there these they this those through under until very were what when where which while whom will with would " +
  "your page pdf docx may per").split(/\s+/));

/** Cheap local keywords: top-frequency non-stopword terms + path tokens. No LLM, nothing leaves the machine. */
export function keywordsFor(pages: string[], filePath: string): string {
  const freq = new Map<string, number>();
  let budget = 60_000;
  for (const p of pages) {
    if (budget <= 0) break;
    const slice = p.slice(0, budget);
    budget -= slice.length;
    for (const w of slice.toLowerCase().match(/[a-z][a-z0-9'-]{3,}/g) ?? []) {
      if (!STOP.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }
  const top = [...freq.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([w]) => w);
  const pathTokens = filePath.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  return [...new Set([...top, ...pathTokens])].join(" ");
}

export const extOf = (p: string) => path.extname(p).slice(1).toLowerCase();
