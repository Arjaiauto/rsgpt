/** Strips the quote marks Find a line is triggered by (and the spaces inside them). */
export const unquote = (q: string) => q.replace(/^["“”'‘’\s]+|["“”'‘’\s]+$/g, "").trim();

/** True when the whole text is in quotes: asking for a line, not a question. */
export const isQuoted = (q: string) => /^\s*["“'‘][\s\S]+["”'’]\s*$/.test(q);
