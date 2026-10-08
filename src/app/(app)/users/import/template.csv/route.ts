// A starting point for the people import (PRD 9.1).
export function GET() {
  const csv = "email,departments,roles\r\nana@example.com,Operations,\r\nbo@example.com,Operations;Sales,Department Manager\r\n";
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="people-import-template.csv"',
      "X-Content-Type-Options": "nosniff",
    },
  });
}
