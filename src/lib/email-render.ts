// Email content, shared by real sends (worker), "Send me a test" and the live
// preview on the reminder form, so what you preview is what's sent. Pure: no
// Node or env imports (the browser imports this too).

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

type Link = { label: string; url: string };

// Email clients don't do CSS variables or <style> reliably (Gmail strips
// most of it), so the palette is repeated here as plain values and everything
// is inline, in tables. Keep it in step with the light theme in globals.css.
const C = {
  canvas: "#f3eeea",
  card: "#ffffff",
  border: "#ebe4df",
  text: "#2b1510",
  muted: "#6c605a",
  accent: "#c4553a",
  button: "#2b1510",
  buttonText: "#f4ede9",
};
const FONT = "'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const paragraphs = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 16px">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");

const a = (l: Link, style: string) => `<a href="${escapeHtml(l.url)}" style="${style}">${escapeHtml(l.label)}</a>`;

// Plain-text and HTML bodies. The last link is the email's main action and
// becomes the button (every email puts its action last); earlier ones are a
// list. footerLinks (e.g. Unsubscribe) sit small under the card.
export function mailBody(
  text: string,
  links: Link[] = [],
  extra: { heading?: string; footer?: string; footerLinks?: Link[] } = {},
) {
  const { heading, footer = "Sent by NotifyHub.", footerLinks = [] } = extra;
  const main = links.at(-1);
  const others = links.slice(0, -1);
  const html = `<div style="margin:0;padding:0;background:${C.canvas}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.canvas};font-family:${FONT}">
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="padding:0 4px 16px;font-size:15px;font-weight:700;color:${C.text};letter-spacing:-0.01em">NotifyHub</td></tr>
<tr><td style="background:${C.card};border:1px solid ${C.border};border-radius:16px;padding:32px;color:${C.text};font-size:15px;line-height:1.6">
${heading ? `<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;font-weight:700;color:${C.text}">${escapeHtml(heading)}</h1>` : ""}
${paragraphs(text)}
${others.length ? `<ul style="margin:0 0 16px;padding:0 0 0 20px">${others.map((l) => `<li style="margin:0 0 6px">${a(l, `color:${C.accent};text-decoration:underline`)}</li>`).join("")}</ul>` : ""}
${main ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 0"><tr><td style="background:${C.button};border-radius:999px">${a(main, `display:inline-block;padding:12px 22px;color:${C.buttonText};font-weight:600;font-size:15px;text-decoration:none;border-radius:999px`)}</td></tr></table>` : ""}
</td></tr>
<tr><td style="padding:16px 4px 0;font-size:12px;line-height:1.5;color:${C.muted}">${escapeHtml(footer)}${footerLinks.map((l) => ` ${a(l, `color:${C.muted};text-decoration:underline`)}`).join("")}</td></tr>
</table>
</td></tr>
</table>
</div>`;
  return {
    text: [text, ...links.map((l) => `${l.label}: ${l.url}`), [footer, ...footerLinks.map((l) => `${l.label}: ${l.url}`)].join("\n")].join("\n\n"),
    html,
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
  unsubscribeUrl?: string; // outside recipients only (PRD 7.1)
}) {
  const subject = `${r.test ? "[Test] " : ""}${r.due ? "Task: " : ""}${r.title}`;
  let text = r.description || r.title;
  if (r.tooBig?.length) text += `\n\nNot attached (too large for email): ${r.tooBig.join(", ")}. Download in NotifyHub.`;
  if (r.due) text += `\n\nDue ${r.due}.`;
  if (r.test) text = `This is a test, sent only to you.\n\n${text}`;
  const links = [...r.links, { label: r.due ? "Mark it done in NotifyHub" : "Open in NotifyHub", url: r.appUrl }];
  const extra = {
    heading: r.title,
    footer: `Sent by ${r.senderName} through NotifyHub.`,
    footerLinks: r.unsubscribeUrl ? [{ label: "Unsubscribe", url: r.unsubscribeUrl }] : [],
  };
  return { subject, text, links, ...extra, fromName: `${r.senderName} via NotifyHub`, html: mailBody(text, links, extra).html };
}
