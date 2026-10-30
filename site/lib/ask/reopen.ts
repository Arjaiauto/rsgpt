import { HOST_NAME } from "./config";
import type { Cite, Source } from "./types";

/** Re-opens a saved answer on the Ask page without asking it again: the answer is put in the tab's thread
    (sessionStorage "cp-ask-thread", the one AskView reads when it mounts) as a finished turn, and the caller then
    goes to /ask. The saved answer is one piece of text with all its citations, so they show together after its last
    paragraph; every one still plays its moment. Mirrors AskView's Turn type. */
export function stashAnswerForAsk(saved: { question: string; answer: string; citations: Cite[] }): boolean {
  const seen = new Set<string>();
  const sources: Source[] = [];
  for (const c of saved.citations) {
    if (seen.has(c.videoId)) continue;
    seen.add(c.videoId);
    sources.push({ videoId: c.videoId, episode: c.episode, guest: c.guest, date: c.date, durationS: null, startS: c.startS, endS: c.endS });
  }
  const turn = {
    id: `saved-${Date.now()}`,
    q: saved.question,
    status: "done",
    step: 3,
    blocks: [{ text: saved.answer, cites: saved.citations.map((c) => (c.speaker === "Host" ? { ...c, speaker: HOST_NAME } : c)) }],
    sources,
    followups: [],
    suggestions: [],
    answerId: null,
  };
  try {
    sessionStorage.setItem("cp-ask-thread", JSON.stringify([turn]));
    sessionStorage.removeItem("cp-ask-scope");
    return true;
  } catch {
    return false;
  }
}
