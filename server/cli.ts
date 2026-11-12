import path from "node:path";
import { scan, status, stats } from "./scanner.js";
import { searchContent, findFiles } from "./search.js";

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "scan") {
  const t = setInterval(() => process.stdout.write(`\r${status.phase} ${status.processed}/${status.found} · ${status.current.slice(0, 40).padEnd(40)}`), 300);
  await scan(rest.length ? rest : undefined);
  clearInterval(t);
  console.log(`\nDone in ${((status.finishedAt - status.startedAt) / 1000).toFixed(1)}s`, status, stats());
} else if (cmd === "ocr") {
  // yab ocr <image…>: the text the system's OCR finds in each image (a quick check that reading images works on this computer)
  const { ocrBatch } = await import("./ocr.js");
  const out = await ocrBatch(rest.map((f) => path.resolve(f)));
  rest.forEach((f, i) => console.log(`--- ${f}\n${out[i] === null ? "(could not be read)" : (out[i]!.text || "(no text found)") + (out[i]!.labels.length ? `\n[shows] ${out[i]!.labels.join(", ")}` : "")}`));
} else if (cmd === "offline") {
  const { offlineSearch } = await import("./offline.js");
  const a = offlineSearch(rest.join(" "));
  console.log(a.message);
  a.files.forEach((f, i) => console.log(`${String(i + 1).padStart(2)}. ${f.file.name}  [${f.file.kind}${f.page ? " p" + f.page : ""}]  ${f.reason ?? ""}${f.quote ? "  “" + f.quote.slice(0, 90) + "”" : ""}`));
} else if (cmd === "search") {
  const query = rest.join(" ");
  console.log(JSON.stringify({ content: searchContent({ query, limit: 6 }), names: findFiles({ query, limit: 6 }) }, null, 2));
} else if (cmd === "ask") {
  const { ask } = await import("./agent.js");
  const res = await ask(rest.join(" "), undefined, (ev) => console.error("·", ev.type, JSON.stringify(ev).slice(0, 160)));
  console.log(JSON.stringify(res, null, 2));
} else {
  console.log("usage: scan [folders…] | search <query> | ask <question> | ocr <image…> | offline <query>");
}
