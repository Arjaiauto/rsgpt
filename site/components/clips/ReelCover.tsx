import { gradientOf, initialsOf } from "@/lib/guest-format";

/** The cover of a reel: the guest's photo filling the box (faces kept near the top) under a dark gradient, or, without a
    photo, their initials on a gradient made from the name. The photo is the Guests page's own (a Commons image or one
    added by hand), never a YouTube thumbnail (CLAUDE.md rule 1). It fills whatever box its parent gives it; whatever
    goes over it (caption, badges) is the parent's. `blur` draws it as a soft background (the reels page on a laptop). */
export function ReelCover({ name, photo, eager = false, blur = false }: { name: string; photo: string | null; eager?: boolean; blur?: boolean }) {
  const label = name || "Guest";
  return (
    <span className={`rc${blur ? " rc--blur" : ""}`} style={{ background: gradientOf(label) }} aria-hidden="true">
      {photo ? (
        // eslint-disable-next-line @next/next/no-img-element -- a 400 px webp already resized by the photo script
        <img src={photo} alt="" width={400} height={400} loading={eager ? "eager" : "lazy"} decoding="async" fetchPriority={eager ? "high" : "auto"} />
      ) : (
        !blur && <span className="rc-ini">{initialsOf(label)}</span>
      )}
      <span className="rc-shade" />
    </span>
  );
}
