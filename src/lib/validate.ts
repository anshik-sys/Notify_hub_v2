// Ids come from URLs and forms; Postgres throws on a malformed uuid, so check first.
export const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
// User ids are Better Auth text ids, not uuids: only bound their length.
export const isUserId = (s: string) => s.length > 0 && s.length <= 64;
// A form field as a string ("" when missing).
export const str = (fd: FormData, k: string) => String(fd.get(k) ?? "");
