export const REPORT_REASONS = [
  { label: "Wrong timestamp", hint: "The clip starts or ends in the wrong place" },
  { label: "Wrong speaker", hint: "Someone else said this" },
  { label: "Wrong fact or quote", hint: "The answer says something the episode doesn't" },
  { label: "Transcript error", hint: "Words are mis-heard or mis-spelt" },
  { label: "Something else", hint: "" },
] as const;

export const REPORT_ITEM_TYPES = ["clip", "episode", "answer", "insight", "brief", "guest"] as const;
export type ReportItemType = (typeof REPORT_ITEM_TYPES)[number];

/** What the flag button knows about the item it reports. */
export type ReportItem = {
  itemType: ReportItemType;
  itemId: string;
  videoId?: string;
  startS?: number;
  episode: string;
  title: string;
};

export type ReportInput = Omit<ReportItem, "episode" | "title"> & { reason: string; note?: string; page?: string };
