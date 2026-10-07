import { createHash } from "node:crypto";

// Attachment rules (PRD 5.7). Pure: no DB. A file is accepted only if its
// bytes are what its extension says (magic bytes, not the name or the
// browser's Content-Type), and CSVs can't smuggle spreadsheet formulas.

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_SAVE = 5;
export const MAX_FILES_PER_REMINDER = 20;
export const EMAIL_ATTACHMENT_BUDGET = 20 * 1024 * 1024;

type Kind = "pdf" | "png" | "jpeg" | "gif" | "webp" | "zip" | "docx" | "xlsx" | "pptx" | "ole" | "text";

// Extension -> the kind its content must be, and the type we serve it as.
const ALLOWED: Record<string, { kind: Kind; contentType: string }> = {
  pdf: { kind: "pdf", contentType: "application/pdf" },
  png: { kind: "png", contentType: "image/png" },
  jpg: { kind: "jpeg", contentType: "image/jpeg" },
  jpeg: { kind: "jpeg", contentType: "image/jpeg" },
  gif: { kind: "gif", contentType: "image/gif" },
  webp: { kind: "webp", contentType: "image/webp" },
  zip: { kind: "zip", contentType: "application/zip" },
  docx: { kind: "docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  xlsx: { kind: "xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  pptx: { kind: "pptx", contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
  doc: { kind: "ole", contentType: "application/msword" },
  xls: { kind: "ole", contentType: "application/vnd.ms-excel" },
  ppt: { kind: "ole", contentType: "application/vnd.ms-powerpoint" },
  txt: { kind: "text", contentType: "text/plain; charset=utf-8" },
  csv: { kind: "text", contentType: "text/csv; charset=utf-8" },
};
export const ACCEPT = Object.keys(ALLOWED)
  .map((e) => `.${e}`)
  .join(",");

const has = (b: Uint8Array, sig: number[] | string, at = 0) =>
  (typeof sig === "string" ? [...sig].map((c) => c.charCodeAt(0)) : sig).every((v, i) => b[at + i] === v);
const contains = (b: Uint8Array, text: string) => Buffer.from(b).includes(text, 0, "latin1");

// What the bytes are, regardless of the name.
export function sniff(b: Uint8Array): Kind | null {
  if (has(b, "%PDF-")) return "pdf";
  if (has(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (has(b, [0xff, 0xd8, 0xff])) return "jpeg";
  if (has(b, "GIF87a") || has(b, "GIF89a")) return "gif";
  if (has(b, "RIFF") && has(b, "WEBP", 8)) return "webp";
  if (has(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "ole";
  if (has(b, [0x50, 0x4b, 0x03, 0x04])) {
    // Office Open XML is a zip with [Content_Types].xml; entry names are plain
    // text in the zip headers, so a byte scan is enough (no unzip library).
    if (contains(b, "[Content_Types].xml")) {
      if (contains(b, "word/")) return "docx";
      if (contains(b, "xl/")) return "xlsx";
      if (contains(b, "ppt/")) return "pptx";
    }
    return "zip";
  }
  if (!b.includes(0)) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(b);
      return "text";
    } catch {
      return null;
    }
  }
  return null;
}

export function safeFileName(name: string) {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, "").replace(/\s+/g, " ").trim();
  if (!clean || clean === "." || clean === "..") return "file";
  if (clean.length <= 150) return clean;
  const dot = clean.lastIndexOf(".");
  const ext = dot > 0 && clean.length - dot <= 10 ? clean.slice(dot) : "";
  return clean.slice(0, 150 - ext.length) + ext;
}

// --- CSV formula injection ---------------------------------------------------------

// RFC 4180: quoted fields, "" escapes, commas/newlines inside quotes, CRLF.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [[]];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === ",") {
      rows.at(-1)!.push(cell);
      cell = "";
    }
    else if (c === "\n" || (c === "\r" && text[i + 1] === "\n")) {
      if (c === "\r") i++;
      rows.at(-1)!.push(cell);
      rows.push([]);
      cell = "";
    } else cell += c;
  }
  rows.at(-1)!.push(cell);
  if (rows.length > 1 && rows.at(-1)!.length === 1 && rows.at(-1)![0] === "") rows.pop(); // trailing newline
  return rows;
}

const NUMBER = /^[+-]?\d+([.,]\d+)?$/;
const PHONE = /^\+[\d\s().-]{6,}$/; // "+44 20 7946 0958": one leading +, then phone characters only

// Spreadsheets run a cell starting with = + - @ (or tab/CR) as a formula.
// Returns an error naming the cell, or null.
export function csvFormulaCheck(text: string) {
  const rows = parseCsv(text);
  for (let r = 0; r < rows.length; r++)
    for (let c = 0; c < rows[r].length; c++) {
      const v = rows[r][c];
      if (!/^[=+\-@\t\r]/.test(v)) continue;
      if (NUMBER.test(v) || PHONE.test(v)) continue;
      return `The CSV has a cell that a spreadsheet would run as a formula (row ${r + 1}, column ${c + 1}: "${v.slice(0, 30)}"). Remove the leading ${JSON.stringify(v[0])} or quote it as text.`;
    }
  return null;
}

// --- One file ------------------------------------------------------------------------

export type CheckedFile = { fileName: string; contentType: string; size: number; sha256: string; data: Buffer };

export function checkFile(name: string, bytes: Uint8Array): { file: CheckedFile } | { error: string } {
  const fileName = safeFileName(name);
  if (bytes.length === 0) return { error: `${fileName} is empty.` };
  if (bytes.length > MAX_FILE_BYTES) return { error: `${fileName} is over the 10 MB limit.` };
  const ext = fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : "";
  const rule = ALLOWED[ext];
  if (!rule) return { error: `${fileName}: this file type isn't allowed. Allowed: PDF, Office documents, CSV/TXT, images (PNG, JPG, GIF, WEBP) and ZIP.` };
  if (sniff(bytes) !== rule.kind) return { error: `${fileName}: the file's content doesn't match its .${ext} extension.` };
  if (ext === "csv") {
    const formula = csvFormulaCheck(new TextDecoder().decode(bytes));
    if (formula) return { error: `${fileName}: ${formula}` };
  }
  const data = Buffer.from(bytes);
  return { file: { fileName, contentType: rule.contentType, size: data.length, sha256: createHash("sha256").update(data).digest("hex"), data } };
}
