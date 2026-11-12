// Downloads the small on-device "search by meaning" model (MIT licence, about 30 MB) into ./models, from where the packaging scripts copy it into the app.
//   node scripts/get-models.mjs
import fs from "node:fs";
import path from "node:path";
const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "models", "potion-base-8M");
fs.mkdirSync(dir, { recursive: true });
for (const f of ["model.safetensors", "tokenizer.json", "config.json"]) {
  const out = path.join(dir, f);
  if (fs.existsSync(out) && fs.statSync(out).size > 100) { console.log("have", f); continue; }
  const r = await fetch(`https://huggingface.co/minishlab/potion-base-8M/resolve/main/${f}`);
  if (!r.ok) throw new Error(`${f}: ${r.status}`);
  fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
  console.log("downloaded", f, fs.statSync(out).size);
}
