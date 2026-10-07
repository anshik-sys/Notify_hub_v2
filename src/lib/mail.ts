import nodemailer from "nodemailer";

if (!process.env.SMTP_URL) throw new Error("SMTP_URL is not set");
if (!process.env.MAIL_FROM) throw new Error("MAIL_FROM is not set");

// Dev: Mailpit (smtp://localhost:1025). Prod: the SES SMTP endpoint
// (smtps://<smtp-user>:<smtp-pass>@email-smtp.<region>.amazonaws.com:465).
// ponytail: SMTP only; add the SES API when per-company domain verification lands (PRD 7.1 tier 2)
const transport = nodemailer.createTransport(process.env.SMTP_URL);
const from = process.env.MAIL_FROM;
// The bare address inside MAIL_FROM ("Name <addr>" or "addr").
export const fromAddress = /<([^>]+)>/.exec(from)?.[1] ?? from;

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

type Link = { label: string; url: string };

// One recipient per message, always (PRD 5.2): `to` is a single address.
// fromName replaces the display name of MAIL_FROM; the address never changes
// (only verified domains may be sent from, PRD 7.1).
export async function sendMail(m: {
  to: string;
  subject: string;
  text: string;
  links?: Link[];
  fromName?: string;
  replyTo?: string;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
}) {
  const links = m.links ?? [];
  const body = [m.text, ...links.map((l) => `${l.label}: ${l.url}`)].join("\n\n");
  const html =
    `<p>${escape(m.text).replace(/\n/g, "<br>")}</p>` +
    links.map((l) => `<p><a href="${escape(l.url)}">${escape(l.label)}</a></p>`).join("");
  const sender = m.fromName ? { name: m.fromName, address: fromAddress } : from;
  return transport.sendMail({
    from: sender,
    to: m.to,
    replyTo: m.replyTo,
    subject: m.subject,
    text: body,
    html,
    attachments: m.attachments,
  });
}
