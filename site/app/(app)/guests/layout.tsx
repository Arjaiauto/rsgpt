import type { ReactNode } from "react";
import "./guests.css";

export default function GuestsLayout({ children }: { children: ReactNode }) {
  return <div className="gx-page">{children}</div>;
}
