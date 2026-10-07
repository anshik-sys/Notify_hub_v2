import nodemailer from "nodemailer";

if (!process.env.SMTP_URL) throw new Error("SMTP_URL is not set");
if (!process.env.MAIL_FROM) throw new Error("MAIL_FROM is not set");

// Dev: Mailpit (smtp://localhost:1025). Prod: the SES SMTP endpoint
// (smtps://<smtp-user>:<smtp-pass>@email-smtp.<region>.amazonaws.com:465).
// ponytail: SMTP only; add the SES API when per-company domain verification lands (PRD 7.1 tier 2)
const transport = nodemailer.createTransport(process.env.SMTP_URL);
const from = process.env.MAIL_FROM;

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// One recipient per message, always (PRD 5.2): never pass a list here.
export async function sendMail(to: string, subject: string, text: string, link?: { label: string; url: string }) {
  const body = link ? `${text}\n\n${link.label}: ${link.url}` : text;
  const html = `<p>${escape(text).replace(/\n/g, "<br>")}</p>${
    link ? `<p><a href="${escape(link.url)}">${escape(link.label)}</a></p>` : ""
  }`;
  await transport.sendMail({ from, to, subject, text: body, html });
}
