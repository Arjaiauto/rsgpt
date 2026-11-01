import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/Logo";
import "./not-found.css";

export const metadata: Metadata = { title: "Page not found" };

/** Any address that isn't a page (and an unknown guest): the real 404 status is sent by Next.js. */
export default function NotFound() {
  return (
    <section className="nf-page" aria-labelledby="nf-h">
      <header className="nf-nav"><Logo href="/" /></header>
      <div className="nf-box">
        <p className="nf-code">404</p>
        <h1 id="nf-h">That page isn&apos;t here<span>It may have moved, or the address is mistyped.</span></h1>
        <div className="nf-actions">
          <Link className="pill pill--primary" href="/ask">Ask the archive</Link>
          <Link className="pill pill--ghost" href="/guests">Browse guests</Link>
        </div>
      </div>
    </section>
  );
}
