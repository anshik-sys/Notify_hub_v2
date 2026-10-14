import nodemailer from "nodemailer";
import { mailBody } from "./email-render";

if (!process.env.SMTP_URL) throw new Error("SMTP_URL is not set");
if (!process.env.MAIL_FROM) throw new Error("MAIL_FROM is not set");

// Dev: Mailpit (smtp://localhost:1025). Prod: the SES SMTP endpoint
// (smtps://<smtp-user>:<smtp-pass>@email-smtp.<region>.amazonaws.com:465).
// ponytail: SMTP only; add the SES API when per-company domain verification lands (PRD 7.1 tier 2)
const transport = nodemailer.createTransport(process.env.SMTP_URL);
const from = process.env.MAIL_FROM;
// The bare address inside MAIL_FROM ("Name <addr>" or "addr").
export const fromAddress = /<([^>]+)>/.exec(from)?.[1] ?? from;

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
  headers?: Record<string, string>;
  // Layout extras (see mailBody). The heading defaults to the subject.
  heading?: string;
  footer?: string;
  footerLinks?: Link[];
}) {
  const { text: body, html } = mailBody(m.text, m.links, { heading: m.heading ?? m.subject, footer: m.footer, footerLinks: m.footerLinks });
  const sender = m.fromName ? { name: m.fromName, address: fromAddress } : from;
  return transport.sendMail({
    from: sender,
    to: m.to,
    replyTo: m.replyTo,
    subject: m.subject,
    text: body,
    html,
    attachments: m.attachments,
    headers: m.headers,
  });
}
