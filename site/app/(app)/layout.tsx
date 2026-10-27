import { Suspense, type ReactNode } from "react";
import { Logo } from "@/components/Logo";
import { NavLinks, NavLinksView } from "@/components/app/NavLinks";
import { LogoutButton } from "@/components/app/LogoutButton";
import { QuickSearch } from "@/components/app/QuickSearch";
import { requireSession } from "@/lib/auth";
import "./app.css";

async function Hello() {
  const { firstName } = await requireSession();
  return (
    <span className="hello">
      <span className="avatar" aria-hidden="true">{firstName.slice(0, 1).toUpperCase()}</span>
      <span className="hello__name">Hi {firstName}</span>
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
        <LogoutButton />
      </header>
      <main className="app-main">{children}</main>
    </div>
  );
}
