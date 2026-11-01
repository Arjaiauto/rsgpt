"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Mark, Wordmark } from "@/components/Logo";
import { login, type LoginState } from "./actions";

const initial: LoginState = { error: "", field: "", attempt: 0 };

export function LoginForm() {
  const [state, action, pending] = useActionState(login, initial);
  const fnameRef = useRef<HTMLInputElement>(null);
  const pwRef = useRef<HTMLInputElement>(null);
  // Cleared as soon as the person edits the field that failed.
  const [cleared, setCleared] = useState(0);
  const invalid = state.error && cleared !== state.attempt ? state.field : "";

  useEffect(() => {
    fnameRef.current?.focus({ preventScroll: true });
  }, []);

  // Shake the failing field 6 px twice and focus it.
  useEffect(() => {
    if (!state.field) return;
    const el = state.field === "fname" ? fnameRef.current : pwRef.current;
    if (!el) return;
    el.classList.remove("shake");
    void el.offsetWidth;
    el.classList.add("shake");
    el.focus();
  }, [state]);

  const onInput = () => { if (invalid) setCleared(state.attempt); };

  return (
    <form className="auth__box" action={action} noValidate>
      <Mark className="mark rise" />
      <h1 className="rise">
        Log in
        <span>to <Wordmark /></span>
      </h1>
      <div className="fields rise d1">
        <label htmlFor="fname" className="sr">First name</label>
        <input
          ref={fnameRef}
          className="input"
          id="fname"
          name="fname"
          type="text"
          placeholder="First name"
          autoComplete="given-name"
          maxLength={40}
          aria-invalid={invalid === "fname" || undefined}
          aria-describedby="msg"
          onInput={onInput}
        />
        <label htmlFor="pw" className="sr">Access password</label>
        <input
          ref={pwRef}
          className="input"
          id="pw"
          name="pw"
          type="password"
          placeholder="Access password"
          autoComplete="current-password"
          aria-invalid={invalid === "pw" || undefined}
          aria-describedby="msg"
          onInput={onInput}
        />
        <div className={`msg${invalid ? " err" : ""}`} id="msg" aria-live="polite">{invalid ? state.error : ""}</div>
      </div>
      <button className="pill pill--primary rise d2" type="submit" disabled={pending}>Enter</button>
      <p className="auth__note rise d3">
        Your first name, the kind of device you use (phone, tablet or desktop) and the pages you open are saved with your questions so we can see who used Cuepoint during the beta. Your IP address and password are not stored.
      </p>
    </form>
  );
}
