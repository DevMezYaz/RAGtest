import { useEffect, useRef, useState } from "react";
import { getAccessFull, listFolders, saveAccess, type FolderNode } from "./api";

const under = (p: string, parent: string) => p.startsWith(parent + "/");

interface Load { folders?: FolderNode[]; error?: string; loading?: boolean }

/** Tick the folders Sleepy may read. A ticked folder includes everything inside it. */
export function Access({ onClose, onSaved }: { onClose: () => void; onSaved: (folders: string[]) => void }) {
  const [sel, setSel] = useState<string[]>([]);
  const [fullPc, setFullPc] = useState(false);
  const [confirmed, setConfirmed] = useState(false);   // the Full PC warning has been accepted (now or earlier)
  const [asking, setAsking] = useState(false);          // the warning is showing
  const [ack, setAck] = useState(false);
  const [tree, setTree] = useState<Record<string, Load>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const loaded = useRef(new Set<string>());

  const load = async (path: string) => {
    if (loaded.current.has(path)) return;
    loaded.current.add(path);
    setTree((t) => ({ ...t, [path]: { loading: true } }));
    try {
      const folders = await listFolders(path === "~" ? undefined : path);
      setTree((t) => ({ ...t, [path]: { folders } }));
    } catch {
      setTree((t) => ({ ...t, [path]: { error: "can’t read this folder (macOS may need your permission)" } }));
    }
  };

  useEffect(() => {
    void (async () => {
      const got = await getAccessFull().catch(() => ({ folders: [] as string[], fullPc: false, fullPcConfirmed: false }));
      const current = got.folders;
      setSel(current); setFullPc(got.fullPc); setConfirmed(!!got.fullPcConfirmed);
      await load("~");
      // open the branches that already hold a chosen folder
      for (const f of current) {
        const parts = f.split("/");
        for (let i = 1; i < parts.length; i++) {
          const anc = parts.slice(0, i).join("/");
          await load(anc);
          setOpen((o) => ({ ...o, [anc]: true }));
        }
      }
    })();
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  const covered = (p: string) => fullPc || sel.some((s) => under(p, s));
  const toggle = (p: string) =>
    setSel((s) => (s.includes(p) ? s.filter((x) => x !== p) : [...s.filter((x) => !under(x, p)), p]));
  const expand = (p: string) => { void load(p); setOpen((o) => ({ ...o, [p]: !o[p] })); };

  const save = async () => {
    setSaving(true); setErr("");
    try { const r = await saveAccess(sel, fullPc, confirmed); onSaved(r.fullPc ? ["Full PC", ...r.folders] : r.folders); }
    catch (e) { setErr((e as Error).message); setSaving(false); }
  };

  const rows = (parent: string, depth: number): React.ReactElement[] => {
    const node = tree[parent];
    if (!node) return [];
    if (node.loading) return [<div key={parent + "…"} className="ac-note" style={{ paddingLeft: 14 + depth * 20 }}>looking…</div>];
    if (node.error) return [<div key={parent + "!"} className="ac-note" style={{ paddingLeft: 14 + depth * 20 }}>{node.error}</div>];
    if (!node.folders?.length && depth > 0) return [<div key={parent + "-"} className="ac-note" style={{ paddingLeft: 14 + depth * 20 }}>no subfolders</div>];
    return (node.folders ?? []).flatMap((f) => {
      const inherited = covered(f.path);
      const checked = inherited || sel.includes(f.path);
      return [
        <div key={f.path} className={`ac-row ${checked ? "on" : ""}`} style={{ paddingLeft: 8 + depth * 20 }}>
          <button className="ac-caret" onClick={() => expand(f.path)} aria-label={open[f.path] ? "collapse" : "expand"}>{open[f.path] ? "▾" : "▸"}</button>
          <label title={inherited ? "included because a folder above it is ticked" : ""}>
            <input type="checkbox" checked={checked} disabled={inherited} onChange={() => toggle(f.path)} />
            <span className="ac-name">{f.name}</span>
            {inherited && <em>included</em>}
          </label>
        </div>,
        ...(open[f.path] ? rows(f.path, depth + 1) : []),
      ];
    });
  };

  return (
    <div className="ac-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ac" role="dialog" aria-label="Choose folders">
        <header>
          <h3>Which folders can Yab read?</h3>
          <button className="close" onClick={onClose} aria-label="close">✕</button>
        </header>
        <p className="muted">Tick a folder to include everything inside it, subfolders too. Only matching snippets ever go to the AI. In the folders you tick, files with names like password, bank or secret are always skipped (Full PC, below, is the exception: it includes everything).</p>
        <div className="ac-list">
          {/* the first thing in the panel: the whole computer. Ticked, the folder list below is only there to look at */}
          <div className={`ac-full ${fullPc ? "on" : ""}`}>
            <label>
              <input type="checkbox" checked={fullPc || asking} onChange={() => (asking ? setAsking(false) : fullPc ? setFullPc(false) : confirmed ? setFullPc(true) : (setAck(false), setAsking(true)))} />
              <span className="ac-full-text"><b>Full PC</b><small>{asking ? "waiting for your confirmation below" : "every file on this computer"}</small></span>
            </label>
          </div>
          {asking && (
            <div className="ac-warn" role="alertdialog" aria-label="Full PC access">
              <b>Give Yab access to this whole computer?</b>
              <ul>
                <li>Yab will be able to find and read <b>every file on this computer</b> (the operating system, installed programs and hidden folders aside).</li>
                <li><b>Nothing is skipped for looking sensitive.</b> Files with names like password, bank, tax, medical or wallet, and key, certificate and vault files, are all included, so everything can be found. In your own folders those are still skipped.</li>
                <li>As always, only the few snippets needed to answer a question go to the AI, but in this mode <b>that can include text from those sensitive files</b>.</li>
                <li>Yab can only <b>edit, move or email</b> files inside your home folder or folders you ticked yourself, never on other drives, and only when you press confirm.</li>
                <li>The first scan of a whole computer can take a long time.</li>
              </ul>
              <label className="ac-ack"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I understand and want to give Yab access to the whole computer</label>
              <div className="ac-warn-btns">
                <button onClick={() => setAsking(false)}>no, keep it to my folders</button>
                <button className="go" disabled={!ack} onClick={() => { setConfirmed(true); setFullPc(true); setAsking(false); }}>turn on Full PC access</button>
              </div>
            </div>
          )}
          {fullPc && <div className="ac-note">Full PC access is on. Everything is included, system and program folders aside, and nothing is skipped for looking sensitive. Changes only inside your home folder or folders you ticked. Untick it to go back to your own folders.</div>}
          <div className="ac-or">or choose folders</div>
          <div className={fullPc ? "ac-tree dim" : "ac-tree"}>{rows("~", 0)}</div>
        </div>
        <footer>
          <span className="muted">{fullPc ? "Full PC access" : sel.length ? `${sel.length} folder${sel.length > 1 ? "s" : ""} ticked` : "nothing ticked — Yab can’t read any files"}</span>
          {err && <span className="ac-err">{err}</span>}
          <button onClick={onClose}>cancel</button>
          <button className="go" disabled={saving || (!fullPc && !sel.length)} onClick={save}>{saving ? "saving…" : "give access & scan"}</button>
        </footer>
      </div>
    </div>
  );
}
