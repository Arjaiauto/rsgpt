"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { player } from "@/components/player/store";
import { IconAsk, IconEpisode, IconPage, IconSearch, IconUser } from "@/components/Icons";
import { PAGES } from "./NavLinks";

type Row = { group: string; icon: ReactNode; label: string; side: string; run: () => void };
type Results = {
  guests: { slug: string; name: string; organisation: string | null; episodes: number }[];
  episodes: { videoId: string; title: string; publishedAt: string | null; durationS: number | null }[];
};

const year = (d: string | null) => (d ? new Date(d).getFullYear() : "");
const EMPTY: Results = { guests: [], episodes: [] };
const noop = () => () => {};

/** Top bar search box + command palette (Ctrl K / Cmd K / "/"). */
export function QuickSearch() {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [found, setFound] = useState<{ term: string; results: Results; status: "loading" | "done" | "error" }>({ term: "", results: EMPTY, status: "done" });
  const mac = useSyncExternalStore(noop, () => /Mac|iPhone|iPad/.test(navigator.platform), () => false);

  const open = () => {
    setQ(""); setSel(0);
    dialogRef.current?.showModal();
    inputRef.current?.focus();
  };
  const close = () => dialogRef.current?.close();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const d = dialogRef.current;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (d?.open) d.close(); else open();
      } else if (e.key === "/" && !document.querySelector("dialog[open]")) {
        const t = e.target as HTMLElement;
        if (/INPUT|TEXTAREA|SELECT/.test(t.tagName) || t.isContentEditable) return;
        e.preventDefault();
        open();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Guests and episodes from the server, 150 ms after the last keystroke.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    const ctrl = new AbortController();
    const t = window.setTimeout(async () => {
      setFound({ term, results: EMPTY, status: "loading" });
      try {
        const r = await fetch(`/api/search?phase=quick&q=${encodeURIComponent(term)}`, { signal: ctrl.signal });
        if (!r.ok) throw new Error(String(r.status));
        setFound({ term, results: await r.json(), status: "done" });
      } catch {
        if (!ctrl.signal.aborted) setFound({ term, results: EMPTY, status: "error" });
      }
    }, 150);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [q]);

  const term = q.trim();
  // Server results only count for the text they were fetched for.
  const current = term.length >= 2 && found.term === term;
  const results = current ? found.results : EMPTY;
  const status = !current ? (term.length >= 2 ? "loading" : "idle") : found.status === "done" ? "idle" : found.status;
  const go = (href: string) => () => router.push(href);
  const rows: Row[] = [];
  if (term) rows.push({ group: "Ask", icon: <IconAsk />, label: `Ask Cuepoint: “${term}”`, side: "Enter", run: go(`/ask?q=${encodeURIComponent(term)}`) });
  const lower = term.toLowerCase();
  for (const [href, label] of PAGES) {
    if (!lower || label.toLowerCase().includes(lower)) rows.push({ group: "Pages", icon: <IconPage />, label, side: "Go to page", run: go(href) });
  }
  for (const g of results.guests) {
    rows.push({
      group: "Guests", icon: <IconUser />, label: g.name,
      side: [g.organisation, `${g.episodes} episode${g.episodes === 1 ? "" : "s"}`].filter(Boolean).join(" · "),
      run: go(`/guests/${g.slug}`),
    });
  }
  for (const e of results.episodes) {
    rows.push({
      group: "Episodes", icon: <IconEpisode />, label: e.title, side: `${year(e.publishedAt)} · Play`,
      run: () => player.play({
        key: `episode:${e.videoId}`, itemType: "episode", itemId: e.videoId, videoId: e.videoId,
        startS: 0, endS: e.durationS ?? 4 * 3600, title: e.title, guest: "", episode: e.title, sourcePath: null,
      }),
    });
  }
  const active = rows.length ? Math.min(sel, rows.length - 1) : 0;
  const runRow = (i: number) => { const r = rows[i]; if (!r) return; close(); r.run(); };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (!rows.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((active + 1) % rows.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((active - 1 + rows.length) % rows.length); }
    else if (e.key === "Enter") { e.preventDefault(); runRow(active); }
  };

  useEffect(() => {
    document.getElementById(`qs-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  let lastGroup = "";
  return (
    <>
      <button className="qs" type="button" onClick={open} aria-label="Quick search" aria-haspopup="dialog">
        <IconSearch />
        <span>Search guests, episodes…</span>
        <kbd>{mac ? "⌘K" : "Ctrl K"}</kbd>
      </button>
      <dialog ref={dialogRef} className="pal" aria-label="Quick search" onClick={(e) => { if (e.target === dialogRef.current) close(); }}>
        <div className="pin">
          <IconSearch />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => { setQ(e.target.value); setSel(0); }}
            onKeyDown={onKeyDown}
            placeholder="Search guests, episodes, pages… or ask a question"
            autoComplete="off"
            role="combobox"
            aria-expanded="true"
            aria-controls="qs-results"
            aria-activedescendant={rows.length ? `qs-${active}` : undefined}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="pres" id="qs-results" role="listbox" aria-busy={status === "loading"}>
          {rows.map((r, i) => {
            const head = r.group !== lastGroup ? <div className="pg" role="presentation">{r.group}</div> : null;
            lastGroup = r.group;
            return (
              <div key={`${r.group}-${i}`}>
                {head}
                <div
                  className="pr"
                  role="option"
                  id={`qs-${i}`}
                  aria-selected={i === active}
                  onMouseMove={() => i !== active && setSel(i)}
                  onClick={() => runRow(i)}
                >
                  <span className="k">{r.icon}</span>
                  <span className="pr__l">{r.label}</span>
                  <span className="s">{r.side}</span>
                </div>
              </div>
            );
          })}
          {status === "loading" && <div className="pnote">Searching…</div>}
          {status === "error" && <div className="pnote">Couldn&apos;t reach the archive. Pages and Ask still work.</div>}
          {!rows.length && status === "idle" && <div className="pnone">Nothing found. Try a guest name or a topic.</div>}
        </div>
        <div className="pfoot"><span>↑ ↓ to move</span><span>Enter to open</span><span>Esc to close</span></div>
      </dialog>
    </>
  );
}
