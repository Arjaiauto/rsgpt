import type { Metadata } from "next";
import { Suspense } from "react";
import { SearchView } from "@/components/search/SearchView";
import { PageSkeleton } from "@/components/states";
import { getScopeIndex } from "@/lib/ask/scope";
import { parseScope, scopeIsEmpty, scopeKey, scopeLabel } from "@/lib/ask/scope-types";
import { requireSession } from "@/lib/auth";
import "./search.css";

/** The title is set to "Search: <q>" by SearchView once it knows q (the root layout adds " · Cuepoint"). */
export const metadata: Metadata = { title: "Search" };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/** /search?q=&scope=&literal=1. q is the text; scope is JSON like {"guest":"khan-sir","topic":"startups","year":2025,"lang":"hi"};
    literal=1 searches the words as typed (no typo correction). The page shows the names and titles at once and the passages
    when they arrive; both come from /api/search (the browser asks for the fast phase, then the full one). */
async function Loader({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  await requireSession();
  const sp = await searchParams;
  const q = one(sp.q).replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  let scope = {};
  try { scope = parseScope(JSON.parse(one(sp.scope).slice(0, 500))); } catch { /* no scope */ }
  const parsed = scope as ReturnType<typeof parseScope>;
  const ix = await getScopeIndex();
  const text = scopeIsEmpty(parsed) ? "" : scopeLabel(ix, parsed);
  const literal = one(sp.literal) === "1";
  return <SearchView key={`${q}|${scopeKey(parsed)}|${literal}`} q={q} scope={parsed} scopeText={text} scopeTopics={ix.topics.map((t) => t.key)} literal={literal} />;
}

type SearchParams = { [key: string]: string | string[] | undefined };

// An explicit type: PageProps<"/search"> only exists once Next has generated the route types (a build or dev run).
export default function Page({ searchParams }: { searchParams: Promise<SearchParams> }) {
  return (
    <div className="sx-page">
      <Suspense fallback={<PageSkeleton kind="list" />}>
        <Loader searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
