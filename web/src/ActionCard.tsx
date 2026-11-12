import { useEffect, useState } from "react";
import { doEdit, doEmail, doMove, undoEdit, type Action } from "./api";

type Saved = { state: "idle" | "busy" | "done" | "off"; msg: string; undo: string | null };
// The card moves between the thread and a floating spot while a file is open; this keeps what was pressed so it can't be applied twice.
const kept = new Map<string, Saved>();

/** A move, edit or email Claude proposed. Nothing happens until a button here is pressed. */
export function ActionCard({ action, onMoved, onEdited, canSend }: { action: Action; onMoved: () => void; onEdited: (fileId: number) => void; canSend: boolean }) {
  const key = JSON.stringify(action);
  const was = kept.get(key);
  const [state, setState] = useState<Saved["state"]>(was && was.state !== "busy" ? was.state : "idle");
  const [msg, setMsg] = useState(was?.msg ?? "");
  const [err, setErr] = useState("");
  const [undo, setUndo] = useState<string | null>(was?.undo ?? null); // backup id once an edit has been applied
  useEffect(() => { kept.set(key, { state, msg, undo }); }, [key, state, msg, undo]);

  const run = async (fn: () => Promise<string>) => {
    setState("busy"); setErr("");
    try { setMsg(await fn()); setState("done"); } catch (e) { setErr((e as Error).message); setState("idle"); }
  };

  if (state === "off") return null;
  return (
    <div className={`act ${state}`}>
      {action.type === "edit" ? (
        <>
          <div className="act-k">edit file</div>
          <div className="act-t"><b>{action.name}</b></div>
          {action.lines.map((l, i) => <div className="act-row" key={i}>{l}</div>)}
          {action.note && <div className="act-note">{action.note}</div>}
        </>
      ) : action.type === "move" ? (
        <>
          <div className="act-k">move file</div>
          <div className="act-t"><b>{action.name}</b></div>
          <div className="act-p">{action.from} <span>→</span> {action.to}</div>
        </>
      ) : (
        <>
          <div className="act-k">email draft</div>
          <div className="act-row"><span>to</span> {action.to}</div>
          <div className="act-row"><span>subject</span> <b>{action.subject}</b></div>
          {action.attach && action.name && <div className="act-row"><span>attached</span> {action.name}</div>}
          <pre className="act-body">{action.body}</pre>
        </>
      )}
      {err && <div className="act-err">{err}</div>}
      {state === "done" ? (
        <div className="act-done">
          ✓ {msg}
          {action.type === "edit" && undo && (
            <button className="act-undo" onClick={() => undoEdit(action.fileId, undo).then((r) => { setMsg(r.message); setUndo(null); onEdited(action.fileId); }, (e) => setErr((e as Error).message))}>undo</button>
          )}
        </div>
      ) : (
        <div className="act-btns">
          {action.type === "edit" ? (
            <button className="go" disabled={state === "busy"} onClick={() => run(async () => { const r = await doEdit(action.fileId, action.edits); setUndo(r.undo); onEdited(action.fileId); return r.message; })}>
              {state === "busy" ? "applying…" : "apply edit"}
            </button>
          ) : action.type === "move" ? (
            <button className="go" disabled={state === "busy"} onClick={() => run(async () => { const r = await doMove(action.fileId, action.to); onMoved(); return `Moved to ${r.to}`; })}>
              {state === "busy" ? "moving…" : "move it"}
            </button>
          ) : canSend ? (<>
            <button className="go" disabled={state === "busy"} onClick={() => run(() => doEmail({ ...action, via: "send" }).then((r) => r.message))}>
              {state === "busy" ? "sending…" : "send"}
            </button>
            <button disabled={state === "busy"} onClick={() => run(() => doEmail({ ...action, via: "mail" }).then((r) => r.message))}>open as draft</button>
          </>) : (<>
            <button className="go" disabled={state === "busy"} onClick={() => run(() => doEmail({ ...action, via: "mailto" }).then((r) => r.message))}>
              {state === "busy" ? "opening…" : "open in mail app"}
            </button>
          </>)}
          <button disabled={state === "busy"} onClick={() => setState("off")}>not now</button>
        </div>
      )}
    </div>
  );
}
