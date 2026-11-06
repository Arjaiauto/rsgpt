"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { IconAsk, IconEpisode, IconPage, IconPlay, IconSearch, IconTag, IconUser } from "@/components/Icons";
import { PAGES } from "./NavLinks";

/** Top bar search box + command palette (Ctrl K / Cmd K / "/"). While typing it asks /api/search/suggest (about 100 ms
    after the last keystroke; an older request is cancelled when a newer one starts). Enter searches (/search?q=) unless a
    suggestion is highlighted; Tab completes the highlighted suggestion. A combobox: the input owns a listbox of options and
    names the highlighted one with aria-activedescendant. Under 820 px it is a full-screen sheet. */

type Kind = "guest" | "topic" | "episode" | "clip" | "term";
type Suggestion = { kind: Kind; label: string; sub: string; href: string; ref: string };
/** `complete`: what Tab puts in the box when this row is highlighted. */
type Row = { id: string; group: string; icon: ReactNode; label: string; side: string; complete?: string; run: () => void };

const GROUPS: { kind: Kind; title: string; icon: ReactNode }[] = [
  { kind: "guest", title: "Guests", icon: <IconUser /> },
  { kind: "topic", title: "Topics", icon: <IconTag /> },
  { kind: "episode", title: "Episodes", icon: <IconEpisode /> },
  { kind: "clip", title: "Clips", icon: <IconPlay /> },
  { kind: "term", title: "Search for", icon: <IconSearch /> },
];
const DEBOUNCE_MS = 100;
const noop = () => () => {};

export function QuickSearch() {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popular = useRef<Suggestion[] | null>(null);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  /** The last answer, kept while the next one loads so the list does not flash empty between keystrokes. */
  const [got, setGot] = useState<{ items: Suggestion[]; status: "done" | "error" | "limited" }>({ items: [], status: "done" });
  const [pending, setPending] = useState(false);
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

  // Suggestions from the server, 100 ms after the last keystroke. The popular ones (nothing typed) are fetched once.
  const term = q.trim();
  useEffect(() => {
    const short = term.length < 2;
    const ctrl = new AbortController();
    const t = window.setTimeout(async () => {
      if (short && popular.current) { setGot({ items: popular.current, status: "done" }); setPending(false); return; }
      setPending(true);
      try {
        const r = await fetch(`/api/search/suggest?q=${encodeURIComponent(short ? "" : term)}`, { signal: ctrl.signal });
        if (r.status === 429) { setGot((g) => ({ ...g, status: "limited" })); setPending(false); return; }
        if (!r.ok) throw new Error(String(r.status));
        const items: Suggestion[] = (await r.json()).items ?? [];
        if (short) popular.current = items;
        setGot({ items, status: "done" });
        setPending(false);
      } catch {
        if (!ctrl.signal.aborted) { setGot((g) => ({ ...g, status: "error" })); setPending(false); }
      }
    }, short ? 0 : DEBOUNCE_MS);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [term]);

  const go = (href: string) => () => router.push(href);
  const rows: Row[] = [];
  if (term) {
    rows.push({ id: "search", group: "", icon: <IconSearch />, label: `Search for “${term}”`, side: "Enter", run: go(`/search?q=${encodeURIComponent(term)}`) });
    rows.push({ id: "ask", group: "Ask", icon: <IconAsk />, label: `Ask Cuepoint: “${term}”`, side: "", run: go(`/ask?q=${encodeURIComponent(term)}`) });
  }
  // Suggestions for what is typed (or the popular ones), grouped by kind in a fixed order.
  const shown = got.items.slice(0, 8);
  for (const g of GROUPS) {
    for (const s of shown.filter((x) => x.kind === g.kind)) {
      rows.push({
        id: `s-${g.kind}-${s.ref}`, group: term ? g.title : "Popular", icon: g.icon, label: s.label, side: s.sub,
        complete: s.kind === "episode" || s.kind === "clip" ? undefined : s.label, run: go(s.href),
      });
    }
  }
  const lower = term.toLowerCase();
  for (const [href, label] of PAGES) {
    if (!lower || label.toLowerCase().includes(lower)) rows.push({ id: `p-${href}`, group: "Pages", icon: <IconPage />, label, side: "Go to page", run: go(href) });
  }
  const active = rows.length ? Math.min(sel, rows.length - 1) : 0;
  const runRow = (i: number) => { const r = rows[i]; if (!r) return; close(); r.run(); };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (rows.length) runRow(active);
      else if (term) { close(); router.push(`/search?q=${encodeURIComponent(term)}`); }
      return;
    }
    if (!rows.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((active + 1) % rows.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((active - 1 + rows.length) % rows.length); }
    else if (e.key === "Tab" && !e.shiftKey && rows[active]?.complete) { e.preventDefault(); setQ(rows[active].complete!); setSel(0); }
  };

  const activeId = rows.length ? `qs-${rows[active].id}` : undefined;
  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const status = pending && !got.items.length ? "loading" : got.status === "error" ? "error" : got.status === "limited" ? "limited" : "idle";
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
            type="search"
            enterKeyHint="search"
            value={q}
            onChange={(e) => { setQ(e.target.value); setSel(0); }}
            onKeyDown={onKeyDown}
            placeholder="Search guests, episodes, clips… or ask a question"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            role="combobox"
            aria-label="Search"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls="qs-results"
            aria-activedescendant={activeId}
          />
          <kbd>Esc</kbd>
          <button type="button" className="pcancel" onClick={close}>Cancel</button>
        </div>
        <div className="pres" id="qs-results" role="listbox" aria-label="Suggestions" aria-busy={pending}>
          {rows.map((r, i) => {
            const head = r.group && r.group !== lastGroup ? <div className="pg" role="presentation">{r.group}</div> : null;
            if (r.group) lastGroup = r.group;
            return (
              <div key={r.id} role="presentation">
                {head}
                <div
                  className="pr"
                  role="option"
                  id={`qs-${r.id}`}
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
          {status === "loading" && <div className="pnote" role="status">Searching…</div>}
          {status === "error" && <div className="pnote" role="status">Couldn&apos;t load suggestions. Press Enter to search anyway.</div>}
          {status === "limited" && <div className="pnote" role="status">Too many suggestions at once. Keep typing, or press Enter.</div>}
          {!rows.length && status === "idle" && <div className="pnone">Nothing to suggest.</div>}
        </div>
        <div className="pfoot"><span>↑ ↓ to move</span><span>Tab to complete</span><span>Enter to search</span><span>Esc to close</span></div>
      </dialog>
    </>
  );
}
