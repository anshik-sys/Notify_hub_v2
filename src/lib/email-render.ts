// Email content, shared by real sends (worker), "Send me a test" and the live
// preview on the reminder form, so what you preview is what's sent. Pure: no
// Node or env imports (the browser imports this too).

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

type Link = { label: string; url: string };

// Plain-text and HTML bodies for a message with trailing links.
export function mailBody(text: string, links: Link[] = []) {
  return {
    text: [text, ...links.map((l) => `${l.label}: ${l.url}`)].join("\n\n"),
    html:
      `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>` +
      links.map((l) => `<p><a href="${escapeHtml(l.url)}">${escapeHtml(l.label)}</a></p>`).join(""),
  };
}

export function renderReminderEmail(r: {
  title: string;
  description: string;
  links: Link[];
  senderName: string;
  appUrl: string; // the reminder's page
  due?: string; // tasks: formatted due time
  tooBig?: string[]; // attachments left out of the email
  test?: boolean;
}) {
  const subject = `${r.test ? "[Test] " : ""}${r.due ? "Task: " : ""}${r.title}`;
  let text = r.description || r.title;
  if (r.tooBig?.length) text += `\n\nNot attached (too large for email): ${r.tooBig.join(", ")}. Download in NotifyHub.`;
  if (r.due) text += `\n\nDue ${r.due}.`;
  if (r.test) text = `This is a test, sent only to you.\n\n${text}`;
  const links = [...r.links, { label: r.due ? "Mark it done in NotifyHub" : "Open in NotifyHub", url: r.appUrl }];
  return { subject, text, links, fromName: `${r.senderName} via NotifyHub`, html: mailBody(text, links).html };
}
