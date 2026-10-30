import { briefExport } from "./export";
import type { Brief } from "./types";

/** A Word (.docx) file written by hand: a .docx is a zip of a few XML parts, so a small zip writer (stored, not
    compressed) is all it takes and no library is needed. Timestamps are links to the moment on YouTube. */

const enc = new TextEncoder();

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip with every file stored as it is. */
export function zipStore(files: { name: string; data: Uint8Array }[]): Uint8Array<ArrayBuffer> {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const DOS_TIME = 0, DOS_DATE = (46 << 9) | (1 << 5) | 1; // 2026-01-01 00:00, fixed so the same brief gives the same file
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true); head.setUint16(8, 0, true);
    head.setUint16(10, DOS_TIME, true); head.setUint16(12, DOS_DATE, true); head.setUint32(14, crc, true);
    head.setUint32(18, f.data.length, true); head.setUint32(22, f.data.length, true); head.setUint16(26, name.length, true); head.setUint16(28, 0, true);
    local.push(new Uint8Array(head.buffer), name, f.data);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true); dir.setUint16(4, 20, true); dir.setUint16(6, 20, true); dir.setUint16(8, 0x0800, true); dir.setUint16(10, 0, true);
    dir.setUint16(12, DOS_TIME, true); dir.setUint16(14, DOS_DATE, true); dir.setUint32(16, crc, true);
    dir.setUint32(20, f.data.length, true); dir.setUint32(24, f.data.length, true); dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const parts = [...local, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** XML text: the five special characters escaped, characters XML cannot hold removed. */
const esc = (s: string) => s
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

type RunStyle = { bold?: boolean; size?: number; color?: string; caps?: boolean; underline?: boolean };
const run = (text: string, s: RunStyle = {}) =>
  `<w:r><w:rPr>${s.bold ? "<w:b/>" : ""}${s.caps ? "<w:caps/>" : ""}${s.color ? `<w:color w:val="${s.color}"/>` : ""}${s.size ? `<w:sz w:val="${s.size}"/><w:szCs w:val="${s.size}"/>` : ""}${s.underline ? '<w:u w:val="single"/>' : ""}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const para = (runs: string, o: { before?: number; after?: number; indent?: number; hanging?: number; keepNext?: boolean } = {}) =>
  `<w:p><w:pPr>${o.keepNext ? "<w:keepNext/>" : ""}<w:spacing w:before="${o.before ?? 0}" w:after="${o.after ?? 80}"/>${o.indent ? `<w:ind w:left="${o.indent}" w:hanging="${o.hanging ?? 0}"/>` : ""}</w:pPr>${runs}</w:p>`;

const INK = "1B1B24", SOFT = "6B6B78", LINK = "0B7A66", VIOLET = "5B07FB";

export function briefDocx(b: Brief): Uint8Array<ArrayBuffer> {
  const x = briefExport(b);
  const links: string[] = [];
  const link = (url: string, label: string) => {
    let i = links.indexOf(url);
    if (i < 0) i = links.push(url) - 1;
    return `<w:hyperlink r:id="rIdL${i + 1}" w:history="1">${run(`[${label}]`, { color: LINK, underline: true, size: 19 })}</w:hyperlink>`;
  };

  const body: string[] = [
    para(run(x.meta, { size: 18, color: VIOLET, caps: true }), { after: 60 }),
    para(run(x.title, { bold: true, size: 48, color: INK }), { after: 40 }),
  ];
  if (x.subtitle) body.push(para(run(x.subtitle, { size: 24, color: SOFT }), { after: 80 }));
  if (x.already) body.push(para(run(x.already, { size: 22, color: x.alreadyMuted ? SOFT : INK }), { after: 80 }));
  for (const s of x.sections) {
    body.push(para(run(s.heading, { bold: true, size: 30, color: INK }), { before: 320, after: 40, keepNext: true }));
    if (s.note) body.push(para(run(s.note, { size: 19, color: SOFT }), { after: 100, keepNext: true }));
    if (s.empty) body.push(para(run(s.empty, { size: 22, color: SOFT }), { after: 90 }));
    let n = 0;
    for (const item of s.items) {
      if (item.group) {
        body.push(para(run(item.group, { bold: true, size: 20, color: SOFT }), { before: 120, after: 60, keepNext: true }));
        n = 0;
      }
      const marker = s.numbered ? `${++n}.` : "•";
      body.push(para(
        run(`${marker} `, { size: 22, color: SOFT })
        + (item.badge ? run(`${item.badge.toUpperCase()}  `, { bold: true, size: 17, color: VIOLET }) : "")
        + run(item.text, { size: 22, color: INK })
        + (item.note ? run(`  ${item.note}`, { size: 19, color: SOFT }) : "")
        + item.cites.map((c) => run("  ") + link(c.url, c.label)).join(""),
        { indent: 360, hanging: 300, after: 90 },
      ));
    }
  }
  body.push(para("", { before: 240 }));
  for (const line of x.footer) body.push(para(run(line, { size: 17, color: SOFT }), { after: 40 }));

  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Nirmala UI"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-IN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>`;
  const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdS" Type="${R}/styles" Target="styles.xml"/>${links.map((u, i) => `<Relationship Id="rIdL${i + 1}" Type="${R}/hyperlink" Target="${esc(u)}" TargetMode="External"/>`).join("")}</Relationships>`;
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
  const root = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`;

  return zipStore([
    { name: "[Content_Types].xml", data: enc.encode(types) },
    { name: "_rels/.rels", data: enc.encode(root) },
    { name: "word/document.xml", data: enc.encode(document) },
    { name: "word/styles.xml", data: enc.encode(styles) },
    { name: "word/_rels/document.xml.rels", data: enc.encode(rels) },
  ]);
}
