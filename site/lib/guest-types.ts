/** Shapes shared by the Guests server code (lib/guests.ts) and the client components. All numbers and
    text come from verified rows (CLAUDE.md rules 2 and 9). */

/** The guest's top takeaway on a directory card, with where it was said. */
export type CardTakeaway = { id: number; text: string; videoId: string; startS: number; endS: number; episode: string };

/** One merged guest (one guest_key) on the directory, similar-guests row and quick search. */
export type GuestCard = {
  /** The raw guest_key (server use) and the clean URL slug. */
  key: string;
  slug: string;
  name: string;
  org: string | null;
  /** All sector tags, written for display. */
  tags: string[];
  photoUrl: string | null;
  photoLicense: string | null;
  /** Date of the latest episode (ISO). */
  latest: string;
  /** Total YouTube views of the guest's episodes. */
  views: number;
  /** Length of the latest episode in seconds. */
  lengthS: number | null;
  /** Verified clips in the guest's episodes. */
  clips: number;
  episodes: number;
  years: number[];
  /** "en" and/or "hi". */
  langs: string[];
  take: CardTakeaway | null;
};

export type Sector = { key: string; label: string; n: number };
export type Directory = { guests: GuestCard[]; sectors: Sector[]; years: number[] };

export type EpisodeInfo = {
  videoId: string;
  title: string;
  publishedAt: string | null;
  durationS: number | null;
  views: number;
  lang: string | null;
};

/** A verified insight with its time range in the episode. */
export type ProfileItem = { id: number; videoId: string; text: string; startS: number; endS: number };
export type OpportunityItem = ProfileItem & { category: string | null };
export type DisagreementItem = ProfileItem & { host: string | null; guest: string | null };
export type ClipItem = { id: number; videoId: string; startS: number; endS: number; topic: string };

export type Profile = {
  slug: string;
  name: string;
  org: string | null;
  role: string | null;
  /** Month of the episode the role was taken from, e.g. "Mar 2025". */
  asOf: string;
  tags: string[];
  /** Up to three bio sentences (every one passed the checks). */
  bio: string[];
  photo: { url: string; credit: string | null; license: string | null; source: string | null } | null;
  links: {
    linkedinProfile: string | null;
    linkedinSearch: string | null;
    youtube: string | null;
    wikipedia: string | null;
    /** link_source = 'auto': the YouTube / Wikipedia pills say "Matched automatically". */
    auto: boolean;
  };
  /** Newest first. */
  episodes: EpisodeInfo[];
  takeaways: ProfileItem[];
  opportunities: OpportunityItem[];
  quotes: ProfileItem[];
  disagreements: DisagreementItem[];
  clips: ClipItem[];
  similar: GuestCard[];
};
