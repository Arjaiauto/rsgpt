import { gradientOf, initialsOf } from "@/lib/guest-format";

/** A guest's Commons photo (copy kept in Supabase Storage) or, without one, their initials on a gradient generated
    from the name. Never a YouTube thumbnail (CLAUDE.md rule 1). Fills the box its parent gives it. */
export function Portrait({ name, photoUrl, priority = false }: { name: string; photoUrl: string | null; priority?: boolean }) {
  return (
    <div className="gx-portrait" style={{ background: gradientOf(name) }}>
      {photoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- a 400 px webp already resized by the photo script
        <img src={photoUrl} alt={name} width={400} height={400} loading={priority ? "eager" : "lazy"} decoding="async" />
      ) : (
        <span className="gx-ini" aria-hidden="true">{initialsOf(name)}</span>
      )}
    </div>
  );
}
