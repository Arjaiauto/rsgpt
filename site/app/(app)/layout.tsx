import { Suspense, type ReactNode } from "react";
import { Logo } from "@/components/Logo";
import { NavLinks, NavLinksView } from "@/components/app/NavLinks";
import { requireSession } from "@/lib/auth";
import { logout } from "../login/actions";
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
        <Suspense fallback={<span className="hello" />}>
          <Hello />
        </Suspense>
        <form action={logout}>
          <button className="pill pill--ghost" type="submit">Log out</button>
        </form>
      </header>
      <main className="app-main">{children}</main>
    </div>
  );
}
