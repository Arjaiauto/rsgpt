import type { ReactNode } from "react";

/** Stand-in for a page that later tickets build: its title and one muted line. */
export function Placeholder({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <>
      <h1 className="page-title rise">{title}</h1>
      {children}
      <p className="coming rise d1">Coming in the next tickets</p>
    </>
  );
}
