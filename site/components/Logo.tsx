import Link from "next/link";

/** Lowercase "cuepoint" wordmark: the i has no dot, a teal cue marker sits above its stem. */
export function Wordmark() {
  return (
    <>
      <span className="sr">Cuepoint</span>
      <span className="wm" aria-hidden="true">
        cuepo<span className="ci"><i /></span>nt
      </span>
    </>
  );
}

export function Mark({ className = "mk" }: { className?: string }) {
  return (
    <svg className={className} aria-hidden="true">
      <use href="#cp-mark" />
    </svg>
  );
}

export function Logo({ href }: { href?: string }) {
  const inner = (
    <>
      <Mark />
      <Wordmark />
    </>
  );
  return href ? (
    <Link className="logo" href={href}>
      {inner}
    </Link>
  ) : (
    <span className="logo">{inner}</span>
  );
}
