import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/Logo";
import { LoginForm } from "./LoginForm";
import "./login.css";

export const metadata: Metadata = { title: "Log in · Cuepoint" };

export default function LoginPage() {
  return (
    <section className="auth" aria-label="Log in">
      <header className="nav">
        <Logo href="/" />
        <Link className="pill pill--ghost" href="/">Back</Link>
      </header>
      <LoginForm />
    </section>
  );
}
