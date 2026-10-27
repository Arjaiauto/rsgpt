"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { fold, sortName } from "@/lib/guest-format";
import type { Directory } from "@/lib/guest-types";
import { IconSearch } from "@/components/Icons";
import { EmptyState } from "@/components/states";
import { GuestCardView } from "./GuestCardView";

const PAGE_SIZE = 60;
type Sort = "views" | "new" | "az";

/**
 * The guest directory (design/03-guests.html): one search box (name or organisation), sector chips, year and language
 * filters and a sort, over the cached list of every verified guest. Filtering runs in the browser on that list, so it
 * answers as you type; the grid draws 60 cards at a time.
 */
export function GuestDirectory({ directory }: { directory: Directory }) {
  const { guests, sectors, years } = directory;
  const [q, setQ] = useState("");
  const query = useDeferredValue(q);
  const [year, setYear] = useState("");
  const [lang, setLang] = useState("");
  const [sort, setSort] = useState<Sort>("views");
  const [active, setActive] = useState<ReadonlySet<string>>(new Set());
  const [shown, setShown] = useState(PAGE_SIZE);
  const [open, setOpen] = useState<string | null>(null);

  const haystack = useMemo(() => new Map(guests.map((g) => [g.slug, fold(`${g.name} ${g.org ?? ""}`)])), [guests]);
  const list = useMemo(() => {
    const words = fold(query).split(/\s+/).filter(Boolean);
    const found = guests.filter((g) => {
      if (words.length && !words.every((w) => haystack.get(g.slug)!.includes(w))) return false;
      if (year && !g.years.includes(Number(year))) return false;
      if (lang && !g.langs.includes(lang)) return false;
      if (active.size && !g.tags.some((t) => active.has(t.toLowerCase()))) return false;
      return true;
    });
    if (sort === "views") found.sort((a, b) => b.views - a.views || sortName(a.name).localeCompare(sortName(b.name)));
    else if (sort === "new") found.sort((a, b) => b.latest.localeCompare(a.latest) || sortName(a.name).localeCompare(sortName(b.name)));
    else found.sort((a, b) => sortName(a.name).localeCompare(sortName(b.name)));
    return found;
  }, [guests, haystack, query, year, lang, active, sort]);

  const changed = (apply: () => void) => { apply(); setShown(PAGE_SIZE); setOpen(null); };
  const filtered = Boolean(q || year || lang || active.size);
  const clear = () => changed(() => { setQ(""); setYear(""); setLang(""); setActive(new Set()); });
  const toggleSector = (key: string) =>
    changed(() => setActive((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; }));

  return (
    <>
      <div className="gx-head">
        <h1 className="page-title">Guests</h1>
        <p className="gx-count" aria-live="polite"><b className="num">{list.length}</b> of {guests.length} guests</p>
      </div>

      <div className="gx-tools">
        <div className="gx-row">
          <label className="gx-search" htmlFor="gx-q">
            <IconSearch aria-hidden="true" />
            <span className="sr">Search guests</span>
            <input id="gx-q" type="search" placeholder="Search by name or organisation" autoComplete="off" value={q}
              onChange={(e) => changed(() => setQ(e.target.value))} />
          </label>
          <label className="sr" htmlFor="gx-year">Year</label>
          <select className="gx-sel" id="gx-year" value={year} onChange={(e) => changed(() => setYear(e.target.value))}>
            <option value="">All years</option>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <label className="sr" htmlFor="gx-lang">Language</label>
          <select className="gx-sel" id="gx-lang" value={lang} onChange={(e) => changed(() => setLang(e.target.value))}>
            <option value="">All languages</option>
            <option value="en">English</option>
            <option value="hi">Hindi / Hinglish</option>
          </select>
          <label className="sr" htmlFor="gx-sort">Sort</label>
          <select className="gx-sel" id="gx-sort" value={sort} onChange={(e) => changed(() => setSort(e.target.value as Sort))}>
            <option value="views">Most viewed</option>
            <option value="new">Newest</option>
            <option value="az">A to Z</option>
          </select>
        </div>
        <div className="gx-chips" role="group" aria-label="Sector">
          <button className="gx-chip" type="button" aria-pressed={!active.size} onClick={() => changed(() => setActive(new Set()))}>All sectors</button>
          {sectors.map((s) => (
            <button key={s.key} className="gx-chip" type="button" aria-pressed={active.has(s.key)} onClick={() => toggleSector(s.key)}>{s.label}</button>
          ))}
        </div>
      </div>

      {list.length === 0 ? (
        <EmptyState
          icon={<IconSearch />}
          title="No guests match these filters"
          text="Try a different name, or remove a filter to see more guests."
          actions={[{ label: "Clear filters", onClick: clear, primary: true }]}
        />
      ) : (
        <>
          <div className="gx-grid">
            {list.slice(0, shown).map((g, i) => (
              <GuestCardView key={g.slug} g={g} index={i} open={open === g.slug} onToggle={() => setOpen(open === g.slug ? null : g.slug)} />
            ))}
          </div>
          {shown < list.length && (
            <div className="gx-more-row">
              <button className="pill pill--ghost" type="button" onClick={() => setShown((n) => n + PAGE_SIZE)}>
                Show more ({list.length - shown} left)
              </button>
            </div>
          )}
          {filtered && <p className="gx-note">Showing guests that match your filters. <button className="linkbtn" type="button" onClick={clear}>Clear filters</button></p>}
        </>
      )}
    </>
  );
}
