"use client";

export const LOGIN_EVENT = "cuepoint:login";

/** A real link to /login; with JavaScript the hero catches the event and drops the cloth first. */
export function LoginButton({ className }: { className: string }) {
  return (
    <a
      className={className}
      href="/login"
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        window.dispatchEvent(new Event(LOGIN_EVENT));
      }}
    >
      Log in
    </a>
  );
}
