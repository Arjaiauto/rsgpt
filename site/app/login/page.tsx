import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/Logo";
import { LoginForm } from "./LoginForm";
import "./login.css";

export const metadata: Metadata = { title: "Log in" };

export default function LoginPage() {
  return (
    <main id="main" className="auth" aria-label="Log in" tabIndex={-1}>
      <header className="nav">
        <Logo href="/" />
        <Link className="pill pill--ghost" href="/">Back</Link>
      </header>
      <LoginForm />
    </main>
  );
}
