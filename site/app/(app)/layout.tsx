import { Suspense, type ReactNode } from "react";
import { Logo } from "@/components/Logo";
import { NavLinks, NavLinksView } from "@/components/app/NavLinks";
import { LogoutButton } from "@/components/app/LogoutButton";
import { PageViewBeacon } from "@/components/app/PageViewBeacon";
import { QuickSearch } from "@/components/app/QuickSearch";
import { TourButton } from "@/components/tour/TourButton";
import { TourGate } from "@/components/tour/TourGate";
import { requireSession } from "@/lib/auth";
import { displayName } from "@/lib/display-name";
import "./app.css";

async function Hello() {
  const { firstName } = await requireSession();
  return (
    <span className="hello">
      <span className="avatar" aria-hidden="true">{firstName.slice(0, 1).toUpperCase()}</span>
      <span className="hello__name">Hi {displayName(firstName)}</span>
    </span>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <header className="bar-top">
        <Logo href="/ask" />
        <Suspense fallback={<NavLinksView path="" />}>
          <NavLinks />
        </Suspense>
        <QuickSearch />
        <Suspense fallback={<span className="hello" />}>
          <Hello />
        </Suspense>
        <TourButton />
        <LogoutButton />
      </header>
      <main id="main" className="app-main" tabIndex={-1}>{children}</main>
      <Suspense fallback={null}>
        <PageViewBeacon />
      </Suspense>
      <Suspense fallback={null}>
        <TourGate />
      </Suspense>
    </div>
  );
}
