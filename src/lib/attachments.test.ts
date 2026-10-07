import assert from "node:assert/strict";
import { test } from "node:test";
import { checkFile, csvFormulaCheck, MAX_FILE_BYTES, parseCsv, safeFileName, sniff } from "./attachments";

const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...Buffer.from(p, "latin1")] : p)));
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "rest");
const PDF = bytes("%PDF-1.7\n...");
const ZIP = bytes([0x50, 0x4b, 0x03, 0x04], "....hello.txt");
const DOCX = bytes([0x50, 0x4b, 0x03, 0x04], "...[Content_Types].xml...word/document.xml");
const XLSX = bytes([0x50, 0x4b, 0x03, 0x04], "...[Content_Types].xml...xl/workbook.xml");
const OLE = bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], "...");
const ok = (name: string, b: Uint8Array) => {
  const r = checkFile(name, b);
  assert.ok("file" in r, `${name}: ${"error" in r ? r.error : ""}`);
  return r.file;
};
const err = (name: string, b: Uint8Array) => {
  const r = checkFile(name, b);
  assert.ok("error" in r, `${name} should be refused`);
  return r.error;
};

test("allowed types, by content", () => {
  assert.equal(ok("scan.pdf", PDF).contentType, "application/pdf");
  assert.equal(ok("photo.PNG", PNG).contentType, "image/png");
  assert.equal(ok("a.jpg", bytes([0xff, 0xd8, 0xff, 0xe0], "x")).contentType, "image/jpeg");
  assert.equal(ok("a.gif", bytes("GIF89a...")).contentType, "image/gif");
  assert.equal(ok("a.webp", bytes("RIFF\0\0\0\0WEBPVP8 ")).contentType, "image/webp");
  assert.equal(ok("bundle.zip", ZIP).contentType, "application/zip");
  assert.match(ok("report.docx", DOCX).contentType, /wordprocessingml/);
  assert.match(ok("sheet.xlsx", XLSX).contentType, /spreadsheetml/);
  assert.equal(ok("old.doc", OLE).contentType, "application/msword");
  assert.match(ok("notes.txt", bytes("hello\nworld ✓")).contentType, /^text\/plain/);
  assert.equal(ok("data.csv", bytes("name,amount\nAda,-12.5\n")).sha256.length, 64);
});

test("content must match the extension", () => {
  assert.match(err("invoice.pdf", bytes("MZ\x90\0this is an exe")), /doesn't match its \.pdf/);
  assert.match(err("report.docx", ZIP), /doesn't match its \.docx/); // a plain zip renamed
  assert.match(err("photo.png", PDF), /doesn't match its \.png/);
  assert.match(err("run.exe", PDF), /isn't allowed/);
  assert.match(err("noext", PDF), /isn't allowed/);
  assert.match(err("bin.txt", bytes([0, 1, 2, 3])), /doesn't match its \.txt/); // binary isn't text
  assert.match(err("empty.pdf", new Uint8Array()), /empty/);
  assert.match(err("big.pdf", new Uint8Array(MAX_FILE_BYTES + 1).fill(0x25)), /10 MB/);
  // HTML is text: allowed as .txt, and only ever served as a download.
  assert.equal(sniff(bytes("<script>alert(1)</script>")), "text");
});

test("CSV formula injection (PRD 5.7)", () => {
  for (const bad of ["=SUM(A1:A9)", "@cmd", "+1+1", "-2+3", '=HYPERLINK("http://x","y")', "\t=1+1"])
    assert.match(csvFormulaCheck(`a,b\nx,${bad.includes(",") ? `"${bad.replace(/"/g, '""')}"` : bad}\n`)!, /row 2, column 2/, bad);
  for (const fine of ["-12.5", "+3", "+44 20 7946 0958", "(555) 123-4567", "plain text", "a=b", "1,5"])
    assert.equal(csvFormulaCheck(`a\n"${fine}"\n`), null, fine);
  assert.match(err("x.csv", bytes("ok\n=1+1\n")), /formula/);
});

test("parseCsv handles quotes, commas and newlines inside fields, CRLF", () => {
  assert.deepEqual(parseCsv('a,"b, c","d ""q"""\r\n"line1\nline2",e\n'), [
    ["a", "b, c", 'd "q"'],
    ["line1\nline2", "e"],
  ]);
});

test("safeFileName", () => {
  assert.equal(safeFileName("../../etc/passwd"), "passwd");
  assert.equal(safeFileName("C:\\Users\\x\\plan.pdf"), "plan.pdf");
  assert.equal(safeFileName('re"port\u0007<>.pdf'), "report.pdf");
  assert.equal(safeFileName(".."), "file");
  const long = safeFileName(`${"a".repeat(300)}.xlsx`);
  assert.equal(long.length, 150);
  assert.ok(long.endsWith(".xlsx"));
});
