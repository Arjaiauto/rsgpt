"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { loadSavedAnswer, moveSaved, noteSaved, removeSaved, restoreSaved } from "@/app/actions/saved";
import { IconPlay } from "@/components/Icons";
import { ReelCover } from "@/components/clips/ReelCover";
import { ClipPlayer } from "@/components/player/ClipPlayer";
import { stashAnswerForAsk } from "@/lib/ask/reopen";
import { fmtDay } from "@/lib/guest-format";
import { fmtTime, type Clip } from "@/lib/player-types";
import { folderName } from "@/lib/saved-folder";
import { savedClipsCsv } from "@/lib/saved-csv";
import { SAVED_LIMITS, type SavedAnswer, type SavedBrief, type SavedClip, type SavedList } from "@/lib/saved-types";
import { toast } from "@/lib/toast";

type Item = SavedClip | SavedAnswer | SavedBrief;
type Kind = Item["kind"];

const TABS: [Kind, string][] = [["clip", "Clips"], ["answer", "Answers"], ["brief", "Prep briefs"]];
/** The "New folder…" choice in an item's folder menu. Folder names never contain control characters (folderName strips
    them), so this can't clash with one. Not \u0000: the HTML parser turns a NUL in the server-rendered option into U+FFFD,
    so the page never recognised the choice and filed items in a folder called "�new". */
const NEW_FOLDER = "\u001Fnew";
const UNDO_MS = 6000;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const hueOf = (name: string) => { let h = 7; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
const newest = (a: Item, b: Item) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id;

/* ---------- one note, saved as you type ---------- */

/** The note box of one item. It keeps its own text (so typing is never reset by a re-render), tells the page the text
    as it changes (the CSV export reads it), and saves 800 ms after the last key, when it loses focus, and when the
    item leaves the screen. Only the newest save updates the tick, so a slow earlier one cannot show a stale "Saved". */
function NoteBox({ id, initial, onText }: { id: number; initial: string; onText: (id: number, text: string) => void }) {
  const [text, setText] = useState(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const timer = useRef<number | undefined>(undefined);
  const fade = useRef<number | undefined>(undefined);
  const dirty = useRef(false);
  const latest = useRef(initial);
  const seq = useRef(0);

  const save = useCallback(async () => {
    window.clearTimeout(timer.current);
    if (!dirty.current) return;
    dirty.current = false;
    const mine = ++seq.current;
    const sent = latest.current;
    setState("saving");
    const res = await noteSaved(id, sent).catch(() => ({ ok: false }));
    if (mine !== seq.current) return;
    if (!res.ok) { dirty.current = true; setState("error"); return; }
    setState("saved");
    window.clearTimeout(fade.current);
    fade.current = window.setTimeout(() => setState("idle"), 2200);
  }, [id]);

  // Whatever was typed is saved when the item goes away (another page, a removed item).
  useEffect(() => () => {
    window.clearTimeout(fade.current);
    if (dirty.current) void noteSaved(id, latest.current).catch(() => null);
    window.clearTimeout(timer.current);
  }, [id]);

  return (
    <div className="sv-notewrap">
      <label className="sr" htmlFor={`sv-n${id}`}>Note</label>
      <textarea
        id={`sv-n${id}`}
        className="sv-note"
        rows={1}
        maxLength={SAVED_LIMITS.note}
        placeholder="Add a note"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          latest.current = e.target.value;
          dirty.current = true;
          setState("idle");
          onText(id, e.target.value);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => void save(), 800);
        }}
        onBlur={() => void save()}
      />
      <span className={`sv-tick sv-tick--${state}`} role="status" aria-live="polite">
        {state === "saving" ? "Saving…" : state === "saved" ? "Saved ✓" : state === "error" ? "Couldn't save. Keep typing to retry." : ""}
      </span>
    </div>
  );
}

/* ---------- one item ---------- */

type RowProps = {
  item: Item;
  folders: string[];
  leaving: boolean;
  playing: boolean;
  opening: boolean;
  onText: (id: number, text: string) => void;
  onMove: (id: number, folder: string | null) => void;
  onRemove: (id: number) => void;
  onPlay: (id: number) => void;
  onOpenAnswer: (id: number) => void;
};

const Row = memo(function Row({ item, folders, leaving, playing, opening, onText, onMove, onRemove, onPlay, onOpenAnswer }: RowProps) {
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const clip: Clip | null = useMemo(() => item.kind !== "clip" ? null : ({
    key: `saved:${item.id}`, itemType: "clip", itemId: String(item.id), videoId: item.videoId, startS: item.startS,
    endS: item.endS > item.startS ? item.endS : item.startS + 30, title: item.title || item.episode, guest: item.guest, episode: item.episode || item.title,
    date: item.date || undefined, sourcePath: "/saved",
  }), [item]);

  const submitFolder = (e: FormEvent) => {
    e.preventDefault();
    const name = folderName(draft);
    if (!name) return;
    setCreating(false);
    setDraft("");
    onMove(item.id, name);
  };

  let tile, title, sub: string | null = null, meta: string, action;
  if (item.kind === "clip") {
    tile = (
      <div className="sv-thumb" aria-hidden="true">
        <ReelCover name={item.guest || item.title} photo={item.photo} />
        <span className="sv-pl"><IconPlay /></span>
        <span className="sv-len num">{fmtTime(Math.max(0, (clip?.endS ?? item.endS) - item.startS))}</span>
      </div>
    );
    title = item.title || item.episode;
    sub = item.episode && item.episode !== title ? item.episode : null;
    meta = [item.guest, item.date, `starts ${fmtTime(item.startS)}`].filter(Boolean).join(" · ");
    action = (
      <button className="sv-mini sv-mini--cite" type="button" aria-pressed={playing} onClick={() => onPlay(item.id)}>{playing ? "Hide player" : "Play"}</button>
    );
  } else if (item.kind === "answer") {
    tile = (
      <div className="sv-thumb sv-thumb--sq" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 5h14v10H9l-4 4z" /></svg>
      </div>
    );
    title = item.question;
    sub = item.preview || null;
    meta = `${plural(item.sources, "source")} · saved ${fmtDay(item.createdAt)}`;
    action = <button className="sv-mini" type="button" onClick={() => onOpenAnswer(item.id)} disabled={opening}>{opening ? "Opening…" : "Open in Ask"}</button>;
  } else {
    tile = (
      <div className="sv-thumb sv-thumb--sq" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M7 3h7l4 4v14H7z" /><path d="M14 3v4h4M9.5 12h5M9.5 16h5" /></svg>
      </div>
    );
    title = item.title;
    sub = item.description || null;
    meta = `Prep brief · ${fmtDay(item.builtAt)} · ${plural(item.sections, "section")}`;
    action = <Link className="sv-mini" href={`/prep?brief=${item.id}`}>Open brief</Link>;
  }

  return (
    <article className={`sv-it${leaving ? " out" : ""}`}>
      {tile}
      <div className="sv-bd">
        <b>{title}</b>
        {sub && <span className="sv-sub">{sub}</span>}
        <span className="sv-m">{meta}</span>
        <NoteBox id={item.id} initial={item.note} onText={onText} />
        <div className="sv-ctl">
          {action}
          <label className="sr" htmlFor={`sv-f${item.id}`}>Folder</label>
          <select
            id={`sv-f${item.id}`}
            className="sv-fsel"
            value={item.folder ?? ""}
            onChange={(e) => {
              if (e.target.value === NEW_FOLDER) setCreating(true);
              else onMove(item.id, e.target.value || null);
            }}
          >
            <option value="">No folder</option>
            {folders.map((f) => <option key={f} value={f}>{f}</option>)}
            <option value={NEW_FOLDER}>New folder…</option>
          </select>
          <button className="sv-rm" type="button" onClick={() => onRemove(item.id)} aria-label={`Remove: ${title}`}>Remove</button>
        </div>
        {creating && (
          <form className="sv-newf sv-newf--row" onSubmit={submitFolder}>
            <label className="sr" htmlFor={`sv-nf${item.id}`}>New folder name</label>
            <input
              id={`sv-nf${item.id}`} value={draft} maxLength={SAVED_LIMITS.folder} placeholder="Folder name" autoFocus autoComplete="off"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") { setCreating(false); setDraft(""); } }}
            />
            <button type="submit" disabled={!folderName(draft)}>Move here</button>
            <button type="button" onClick={() => { setCreating(false); setDraft(""); }}>Cancel</button>
          </form>
        )}
      </div>
      {playing && clip && (
        <div className="sv-player"><ClipPlayer clip={clip} report={false} canSave={false} /></div>
      )}
    </article>
  );
});

/* ---------- the page ---------- */

export function SavedView({ initial }: { initial: SavedList }) {
  const router = useRouter();
  const [items, setItems] = useState<Item[]>(() => [...initial.clips, ...initial.answers, ...initial.briefs].sort(newest));
  const [tab, setTab] = useState<Kind>("clip");
  const [folderKey, setFolderKey] = useState<string | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  const [newName, setNewName] = useState("");
  const [leaving, setLeaving] = useState<ReadonlySet<number>>(new Set());
  const [playingId, setPlayingId] = useState<number | null>(null);
  const [openingId, setOpeningId] = useState<number | null>(null);
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; }, [items]);

  // Folders in use (a folder is only the name on its items) and the ones just typed in and still empty.
  const folderList = useMemo(() => {
    const byKey = new Map<string, { key: string; name: string; n: number }>();
    for (const i of items) {
      if (!i.folder) continue;
      const k = i.folder.toLowerCase();
      byKey.set(k, { key: k, name: byKey.get(k)?.name ?? i.folder, n: (byKey.get(k)?.n ?? 0) + 1 });
    }
    for (const p of pending) if (!byKey.has(p.toLowerCase())) byKey.set(p.toLowerCase(), { key: p.toLowerCase(), name: p, n: 0 });
    return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [items, pending]);
  const namesKey = folderList.map((f) => f.name).join("\u0001");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the names only change when this joined key does, which keeps every row from re-rendering on each keystroke
  const names = useMemo(() => folderList.map((f) => f.name), [namesKey]);
  const activeKey = folderKey && folderList.some((f) => f.key === folderKey) ? folderKey : null;
  const activeName = folderList.find((f) => f.key === activeKey)?.name ?? null;

  const inFolder = useMemo(() => (activeKey ? items.filter((i) => i.folder?.toLowerCase() === activeKey) : items), [items, activeKey]);
  const counts = useMemo(() => ({
    clip: inFolder.filter((i) => i.kind === "clip").length,
    answer: inFolder.filter((i) => i.kind === "answer").length,
    brief: inFolder.filter((i) => i.kind === "brief").length,
  }), [inFolder]);
  const visible = useMemo(() => inFolder.filter((i) => i.kind === tab), [inFolder, tab]);
  const clipCount = useMemo(() => items.filter((i) => i.kind === "clip").length, [items]);

  /* ---------- changes ---------- */
  const onText = useCallback((id: number, note: string) => setItems((all) => all.map((i) => (i.id === id ? { ...i, note } : i))), []);

  /** Moves an item (shown at once, put back if the server says no). Returns the folder as the server spells it, or
      undefined when it failed. */
  const applyMove = useCallback(async (id: number, folder: string | null): Promise<{ folder: string | null } | undefined> => {
    const prev = itemsRef.current.find((i) => i.id === id)?.folder ?? null;
    setItems((all) => all.map((i) => (i.id === id ? { ...i, folder } : i)));
    const res = await moveSaved(id, folder).catch(() => ({ ok: false, folder: prev }));
    if (!res.ok) {
      setItems((all) => all.map((i) => (i.id === id ? { ...i, folder: prev } : i)));
      toast("Couldn't move it. Try again.");
      return undefined;
    }
    // The server may spell the folder as an existing one does.
    if (res.folder !== folder) setItems((all) => all.map((i) => (i.id === id ? { ...i, folder: res.folder } : i)));
    return { folder: res.folder };
  }, []);

  const onMove = useCallback(async (id: number, folder: string | null) => {
    const prev = itemsRef.current.find((i) => i.id === id)?.folder ?? null;
    const done = await applyMove(id, folder);
    if (!done) return;
    toast(done.folder ? `Moved to “${done.folder}”` : "Removed from its folder", { undo: () => { void applyMove(id, prev); } });
  }, [applyMove]);

  const onRemove = useCallback(async (id: number) => {
    const item = itemsRef.current.find((i) => i.id === id);
    if (!item) return;
    setLeaving((s) => new Set(s).add(id));
    setPlayingId((p) => (p === id ? null : p));
    const [res] = await Promise.all([removeSaved(id).catch(() => ({ ok: false as const })), new Promise((r) => setTimeout(r, 280))]);
    setLeaving((s) => { const n = new Set(s); n.delete(id); return n; });
    if (!res.ok) { toast("Couldn't remove it. Try again."); return; }
    setItems((all) => all.filter((i) => i.id !== id));
    toast("Removed", {
      ms: UNDO_MS,
      undo: () => {
        void restoreSaved(res.row).then((back) => {
          if (!back.ok) { toast("Couldn't bring it back."); return; }
          setItems((all) => [...all, { ...item, id: back.id }].sort(newest));
        }).catch(() => toast("Couldn't bring it back."));
      },
    });
  }, []);

  const onPlay = useCallback((id: number) => setPlayingId((p) => (p === id ? null : id)), []);

  const onOpenAnswer = useCallback(async (id: number) => {
    setOpeningId(id);
    const saved = await loadSavedAnswer(id).catch(() => null);
    setOpeningId(null);
    if (!saved || !stashAnswerForAsk(saved)) { toast("Couldn't open that answer."); return; }
    router.push("/ask");
  }, [router]);

  const addFolder = (e: FormEvent) => {
    e.preventDefault();
    const name = folderName(newName);
    if (!name) return;
    setNewName("");
    const existing = folderList.find((f) => f.key === name.toLowerCase());
    if (existing) { setFolderKey(existing.key); toast(`“${existing.name}” already exists`); return; }
    setPending((p) => [...p, name]);
    setFolderKey(name.toLowerCase());
    toast(`Folder “${name}” is ready. Use the Folder menu on an item to move it in.`);
  };

  const exportCsv = () => {
    const clips = itemsRef.current.filter((i): i is SavedClip => i.kind === "clip");
    if (!clips.length) return;
    const blob = new Blob([savedClipsCsv(clips)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${initial.firstName.replace(/[^\p{L}\p{N}]+/gu, "-").toLowerCase() || "my"}-saved-clips-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    toast(`${plural(clips.length, "clip")} downloaded as CSV`);
  };

  /* ---------- screen ---------- */
  const total = items.length;
  const empty = (() => {
    const filtered = !!activeName;
    if (filtered && inFolder.length === 0) {
      return (
        <div className="sv-empty">
          <b>“{activeName}” is empty.</b>
          <span>Use the Folder menu on any saved item to move it here. A folder goes away when its last item leaves.</span>
          <div className="sv-row"><button className="pill pill--ghost" type="button" onClick={() => setFolderKey(null)}>Show all saved</button></div>
        </div>
      );
    }
    if (filtered) {
      return (
        <div className="sv-empty">
          <b>Nothing in “{activeName}” under {TABS.find(([k]) => k === tab)![1]}.</b>
          <span>Try another tab, or show everything you saved.</span>
          <div className="sv-row"><button className="pill pill--ghost" type="button" onClick={() => setFolderKey(null)}>Show all saved</button></div>
        </div>
      );
    }
    const text = tab === "clip" ? "No saved clips yet." : tab === "answer" ? "No saved answers yet." : "No saved prep briefs yet.";
    const how = tab === "clip" ? "Tap Save on any clip and it appears here." : tab === "answer" ? "Tap Save answer under any answer on Ask." : "Build a brief and tap Save brief.";
    return (
      <div className="sv-empty">
        <b>{text}</b>
        <span>{how}</span>
        <div className="sv-row">
          {tab === "brief"
            ? <Link className="pill pill--ghost" href="/prep">Prep brief</Link>
            : <Link className="pill pill--ghost" href="/clips">Find clips</Link>}
          <Link className="pill pill--primary" href="/ask">Ask a question</Link>
        </div>
      </div>
    );
  })();

  return (
    <>
      <div className="sv-head">
        <div>
          <h1 className="page-title rise">Saved</h1>
          <p className="sv-whose rise d1"><b>{initial.firstName}’s</b> saved items · on this browser</p>
        </div>
        <button className="pill pill--ghost rise d1" type="button" onClick={exportCsv} disabled={clipCount === 0} title={clipCount ? undefined : "Save a clip first"}>
          Export clips as CSV
        </button>
      </div>
      <div className="sv-layout">
        <nav className="sv-folders" aria-label="Folders">
          <h2>Folders</h2>
          <button className="sv-fd" type="button" aria-pressed={!activeKey} onClick={() => setFolderKey(null)}>
            <span>All</span><span className="sv-n num">{total}</span>
          </button>
          {folderList.map((f) => (
            <button key={f.key} className="sv-fd" type="button" aria-pressed={activeKey === f.key} onClick={() => setFolderKey(f.key)}>
              <span className="sv-fn"><i style={{ background: `hsl(${hueOf(f.name)} 65% 68%)` }} />{f.name}</span><span className="sv-n num">{f.n}</span>
            </button>
          ))}
          <form className="sv-newf" onSubmit={addFolder}>
            <label className="sr" htmlFor="sv-newfolder">New folder name</label>
            <input id="sv-newfolder" value={newName} maxLength={SAVED_LIMITS.folder} placeholder="New folder" autoComplete="off" onChange={(e) => setNewName(e.target.value)} />
            <button type="submit" disabled={!folderName(newName)}>Add</button>
          </form>
        </nav>
        <div className="sv-main">
          <div className="sv-tabs" role="tablist" aria-label="Saved items">
            {TABS.map(([k, label]) => (
              <button key={k} className="sv-tab" role="tab" type="button" aria-selected={tab === k} onClick={() => setTab(k)}>
                {label}<span className="num">{counts[k]}</span>
              </button>
            ))}
          </div>
          <div className="sv-list" role="tabpanel">
            {visible.length === 0 ? empty : visible.map((item) => (
              <Row
                key={item.id}
                item={item}
                folders={names}
                leaving={leaving.has(item.id)}
                playing={playingId === item.id}
                opening={openingId === item.id}
                onText={onText}
                onMove={onMove}
                onRemove={onRemove}
                onPlay={onPlay}
                onOpenAnswer={onOpenAnswer}
              />
            ))}
          </div>
          {initial.capped && <p className="sv-cap">Showing your newest items. Older ones are still saved.</p>}
        </div>
      </div>
    </>
  );
}
