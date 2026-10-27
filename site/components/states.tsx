"use client";

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { IconCloudOff } from "./Icons";

/* ---------- loading ---------- */

/** One shimmering block; the shimmer is off under reduced motion. */
export function Skeleton({ w, h, round, style }: { w?: string | number; h?: string | number; round?: boolean; style?: CSSProperties }) {
  return <div className="sk" aria-hidden="true" style={{ width: w, height: h, borderRadius: round ? "50%" : undefined, ...style }} />;
}
export const SkLine = ({ w }: { w: number }) => <Skeleton w={`${w}%`} h={12} style={{ borderRadius: 6 }} />;

/** Page-shaped skeletons, matching design/10-global-components.html. */
export function PageSkeleton({ kind }: { kind: "player" | "player-list" | "list" | "grid" | "doc" | "stats" | "deck" }) {
  const rows = (
    <div className="list">
      {Array.from({ length: 4 }, (_, i) => (
        <div className="card item" key={i}>
          <Skeleton w={84} style={{ aspectRatio: "16/9", flex: "none" }} />
          <div style={{ flex: 1, display: "grid", gap: 8 }}><SkLine w={70} /><SkLine w={40} /></div>
        </div>
      ))}
    </div>
  );
  let body: ReactNode = rows;
  if (kind === "player" || kind === "player-list") {
    body = (
      <>
        <div className="card" style={{ marginBottom: 22, overflow: "hidden" }}>
          <Skeleton style={{ aspectRatio: "16/9", maxHeight: 440, borderRadius: 0 }} />
          <div style={{ padding: 18, display: "grid", gap: 10 }}><SkLine w={55} /><SkLine w={30} /></div>
        </div>
        {kind === "player-list" && rows}
      </>
    );
  } else if (kind === "grid") {
    body = (
      <div className="sgrid">
        {Array.from({ length: 6 }, (_, i) => (
          <div className="card gc" key={i}><Skeleton w={56} h={56} round /><SkLine w={70} /><SkLine w={45} /></div>
        ))}
      </div>
    );
  } else if (kind === "stats") {
    body = (
      <div className="stats">
        {Array.from({ length: 3 }, (_, i) => (
          <div className="card stat" key={i} style={{ display: "grid", gap: 12 }}><Skeleton w="50%" h={34} /><SkLine w={80} /></div>
        ))}
      </div>
    );
  } else if (kind === "doc") {
    body = <div className="card doc">{[40, 95, 90, 70, 35, 92, 60].map((w, i) => <SkLine key={i} w={w} />)}</div>;
  } else if (kind === "deck") {
    body = <div className="card" style={{ overflow: "hidden" }}><Skeleton style={{ aspectRatio: "16/9", borderRadius: 0 }} /></div>;
  }
  return (
    <div className="state-page" aria-busy="true" aria-label="Loading">
      <Skeleton w="30%" h={30} style={{ marginBottom: 12 }} />
      <Skeleton w="50%" h={14} style={{ marginBottom: 26 }} />
      {body}
    </div>
  );
}

/* ---------- empty ---------- */

export type StateAction = { label: string; href?: string; onClick?: () => void; primary?: boolean };

function Actions({ actions }: { actions: StateAction[] }) {
  if (!actions.length) return null;
  return (
    <div className="state__row">
      {actions.map((a) => {
        const cls = `pill ${a.primary ? "pill--primary pill--sm" : "pill--ghost"}`;
        return a.href ? (
          <Link key={a.label} className={cls} href={a.href}>{a.label}</Link>
        ) : (
          <button key={a.label} className={cls} type="button" onClick={a.onClick}>{a.label}</button>
        );
      })}
    </div>
  );
}

/** "Nothing here" with a next step: icon, title, text and action buttons. */
export function EmptyState({ icon, title, text, actions = [] }: { icon: ReactNode; title: string; text: string; actions?: StateAction[] }) {
  return (
    <div className="card state">
      <div className="state__ico">{icon}</div>
      <h2>{title}</h2>
      <p>{text}</p>
      <Actions actions={actions} />
    </div>
  );
}

/* ---------- error ---------- */

/** The archive could not be reached. Saved items are never lost. */
export function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="card state state--err" role="alert">
      <div className="state__ico"><IconCloudOff /></div>
      <h2>Couldn&apos;t reach the archive</h2>
      <p>Check your connection and try again. Nothing you saved is lost.</p>
      <Actions actions={[{ label: "Try again", onClick: onRetry, primary: true }]} />
    </div>
  );
}
