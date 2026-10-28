/** The clean URL slug of a guest_key: lower case, repeated dashes collapsed, leading and trailing dashes trimmed
    ("khan-sir--" -> "khan-sir", "sandeep-das--mars" -> "sandeep-das-mars"). Pure, so the proxy can use it to
    redirect old guest_key URLs without touching the database. */
export const guestSlug = (key: string): string => key.toLowerCase().replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");

/** Slugs that no longer exist because pipeline/corrections.json merged the guest into another key (a misheard
    organisation fixed), and where they went. Mirrors the "guest_keys" map there. */
const MERGED_SLUGS: Record<string, string> = {
  "vaibhav-sisinty-roseschool": "vaibhav-sisinty",
  "vaibhav-sisinty-growthschool": "vaibhav-sisinty",
  "vaibhav-sisinty-curahome": "vaibhav-sisinty",
  "vaibhav": "vaibhav-sisinty",
};

/** The slug a guest page lives at now, for a raw guest_key or an old slug. */
export const currentGuestSlug = (keyOrSlug: string): string => {
  const slug = guestSlug(keyOrSlug);
  return MERGED_SLUGS[slug] ?? slug;
};
