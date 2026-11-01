"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { IconMenu } from "@/components/Icons";
import { TOUR_OPEN_EVENT } from "@/lib/tour";

export const PAGES: [href: string, label: string][] = [
  ["/ask", "Ask"],
  ["/guests", "Guests"],
  ["/prep", "Prep brief"],
  ["/clips", "Clips"],
  ["/saved", "Saved"],
  ["/insights", "Insights"],
  ["/future", "Future"],
];

/** Top bar links; under 820px they all fold into one menu button. */
export function NavLinksView({ path }: { path: string }) {
  const menuRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (menuRef.current) menuRef.current.open = false; }, [path]);
  const links = PAGES.map(([href, label]) => {
    const current = path === href || path.startsWith(href + "/");
    return (
      <Link key={href} href={href} aria-current={current ? "page" : undefined}>
        {label}
      </Link>
    );
  });
  return (
    <>
      <nav className="links" aria-label="Main">{links}</nav>
      <details className="menu" ref={menuRef}>
        <summary aria-label="Menu"><IconMenu /></summary>
        <nav className="menu__list" aria-label="Main">
          {links}
          <button
            className="menu__tour"
            type="button"
            onClick={() => { if (menuRef.current) menuRef.current.open = false; window.dispatchEvent(new Event(TOUR_OPEN_EVENT)); }}
          >
            Take the tour
          </button>
        </nav>
      </details>
    </>
  );
}

/** Reads the URL, so it sits behind a Suspense boundary whose fallback is NavLinksView with no page marked. */
export function NavLinks() {
  return <NavLinksView path={usePathname()} />;
}
