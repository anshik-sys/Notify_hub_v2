# Progress

Daily log, newest first. Committed, not gitignored, so worktrees merge it.

## 2026-10-08 — reports (PRD 10)

- **What's in place:** Reports in the sidebar (`reports.view`; the CSV
  needs `reports.export`; Company Admin has both). Three tabs:
  - **Deliveries:** sent / failed per channel, success rates, and a table
    by hour (ranges of 7 days or less), day or month;
  - **Task completion:** by department, group (team) or person: assigned,
    done, on time, completion %, average time to complete;
  - **Overdue:** a count and the oldest due date per department, group or
    person, then the list of overdue tasks with days overdue.

  Filters are in the URL, and Export CSV uses the same table as the page.
- **No chart library:** bars are a CSS width in a table cell (a new `Bar` kit
  piece). PRD 8 asks for functional views, and the tables carry the
  numbers.
- **The definitions are written down** in README (which timestamp, what "on
  time" means, double-counting across departments), so the numbers can be
  explained.
- **Verified against `next start` + worker + fake Slack:**
  - an email+Slack reminder to 3 people (one without Slack) and a task to 2
    → Deliveries: email 5 sent; Slack 2 sent, 1 failed, 67%;
  - Task completion for Ops: 3 assigned, 1 done (alice), 33%;
  - Overdue: bob's seeded 3-day-old task;
  - the CSVs match the pages; a member gets 404 for both, with no sidebar
    link.

  113 tests pass (new: `reports.test.ts`: buckets, the Dubai midnight edge,
  months, per-department, group and person, overdue, CSV).
- **Not in this step:** scheduled report emails, reports scoped to managers
  (they don't have `reports.view`), charts beyond bars.

## 2026-10-08 — audit log (PRD 9.1)

- **What's in place:**
  - **Audit log** in the sidebar (new permission `audit.view`; Company
    Admin has it): when, who, created / changed / deleted, what (linked),
    and the field changes ("title: A → B");
  - filters: who, what, action, dates, search;
  - **Export CSV** with the same filters.
- **Triggers rather than calls in app code.** One generic `audit_row()`
  trigger on 16 tables, so the next feature can't forget to log. The actor
  travels in the transaction (`app.actor_id`), set by `withTenant` from
  the signed-in person.
- **Only people's actions.** The worker's sends, status flips and
  follow-ups have no actor and aren't logged (deliveries already have their
  own log). Slack "Mark done" is logged under the person who clicked.
- **Secrets never recorded:** they're excluded per table in the trigger
  arguments (the Slack token, the invitation token hash); the auth tables
  aren't audited at all. Tests check that a token-only update writes
  nothing, and that a mixed update records only the safe column.
- **Append-only:** the app role can only read `audit_log`; insert, update
  and delete → permission denied (tested in the unit tests and with psql).
- **Caught while verifying:** the first version carried the actor in a
  React `cache()` box. In the real server, server actions recorded nothing:
  `cache()` isn't request-scoped there. Only the Slack route (with an
  explicit actor) was logged. Now it's keyed on the request's `headers()`
  object, which Next keeps the same for a whole request. Re-verified.
- **CSV export:** quoted per RFC 4180. A cell starting with = + - @ tab or
  CR gets a leading `'`, so `=HYPERLINK("…")` in a title doesn't run as a
  formula in a spreadsheet (seen in the export).
- **Verified against `next start` + worker + fake Slack:**
  - the admin creating a department, adding bob, making him manager,
    deactivating and reactivating him, and making alice an admin all
    appear with diffs;
  - alice's reminder create, title edit and company share appear;
  - her "now" reminder sending produced no system rows;
  - a Slack "Mark done" was logged as alice (`done_at: null → …`);
  - filters: by actor+type → 3, delete → 1;
  - the CSV has an attachment header, nosniff, and the escaped formula;
  - bob (member) → 404 for the page and the export, with no sidebar link.

  108 tests pass (new: `audit.test.ts`, plus RLS).
- **Known noise:** editing a reminder re-creates its recipients and shares,
  so they show as delete + create pairs. Diffing them in the app would
  remove that if it bothers anyone.
- **Not in this step:** retention (the PRD's data-retention setting), sign-in
  and sign-out events, a platform-wide view.

## 2026-10-08 — visibility sharing (PRD 5.4)

- **Decided with the user:**
  - Reminders, search and the calendar show everything you can see, with a
    "Show" filter: All I can see / Mine and my teams' / Created by me /
    Shared with me / Sent to me.
  - Dashboard numbers stay about what you created or oversee.
- **What's in place:**
  - **The reminder form** has "Who can see it": my departments, departments,
    groups, everyone in the company.
  - **The reminder page** (for owners) says who it's shared with, or that
    it's private.
  - **Shared viewers** can open it, download attachments, comment and be
    mentioned. They don't see the delivery log, recipients or owner actions.
- **Two levels, two SQL twins.** `reminderAccess` gained "viewer" (sent to
  you **or** shared with you; it used to be "recipient"), and lists use the
  matching `canViewWhere`. The dashboard keeps the narrower `overseeWhere`
  (was `visibleWhere`). Its card links now carry `show=oversee`, so each
  number still matches the list it opens.
- **Sharing never needs approval.** It doesn't send anything to anyone.
- **"My departments" is saved as explicit department ids,** so what's shared
  doesn't silently change when the creator moves departments.
- **Verified against `next start` + worker:**
  - shared with Sales → carol (Sales) opens it, sees no delivery log or edit
    button, and her comment is saved; bob (Eng) and dave get 404;
  - edited to the "Night shift" group → carol 404, dave 200; the edit form
    pre-fills the ticks;
  - edited to everyone → bob 200, and it stays Scheduled (no approval);
    bob's "Shared with me" lists it, "Created by me" doesn't; it's on his
    calendar;
  - a reminder alice sent to bob (out of scope → approved by the admin) → in
    bob's "Sent to me", and he can open it; his dashboard numbers stay 0.

  105 tests pass (sharing in reminders, views and comments, plus RLS).
- **Not in this step:** sharing with individual people, notifications when
  something is shared with you.

## 2026-10-08 — settings: profile, password reset, 2FA, sessions (PRD 3, 8, 9.1)

- **Decided with the user:** the full scope (profile, password change and
  reset, 2FA with QR and backup codes, sessions, admin 2FA reset, require
  2FA), and adding the `qrcode` package. Profile picture, email change and
  SSO come later.
- **What's in place:**
  - **Settings → Profile:** name and your own time zone; your departments
    (with their managers), groups and roles; appearance; sign out.
    Groups, roles, appearance and sign out moved off Home. "Your
    departments" stays on Home, since you asked for it there.
  - **Settings → Security:**
    - two-factor: set up with the QR or the key, 10 backup codes, confirm
      with a code; new backup codes, turn off (password needed for each);
    - change password (signs you out elsewhere);
    - where you're signed in, with Sign out per device and "everywhere
      else".
  - **Sign-in:** a second step for 2FA (code or backup code, "trust this
    browser for 30 days"), and "Forgot your password?" with the reset pages.
  - **Admins:**
    - "Reset two-factor" on a person's page: turns it off and signs them
      out; it has the same "not above yourself" guard as deactivation;
    - Company → "Require two-factor": refused until you have it yourself, so
      you can't lock yourself out.
  - **The sidebar:** personal Settings for everyone; the old admin
    Settings is now "Company".
- **Why `two_factor` is auth-role only:** it holds the secrets, like
  `session`/`account`. Migration 0022 revokes it from the app role, since
  the default privileges would otherwise grant it; there's an RLS test for
  that.
- **Security note:** Better Auth's 2FA only challenges password sign-ins.
  Google sign-in skips it and relies on Google's 2-step. With "require
  2FA" on, Google users still have to set up TOTP before using the app.
- **A personal time zone changes display only,** never when things send.
- **Verified against `next start` + Mailpit** (TOTP codes generated in the
  script, RFC 6238):
  - profile: the name and time zone saved; a bogus zone was refused;
  - 2FA setup: QR SVG, 52-character key, 10 backup codes, still off until
    confirmed; a wrong code was refused; the right one turned it on; the
    setup cookie was deleted;
  - sign-in with 2FA → `/sign-in/two-factor`, with no session yet; a wrong
    code was refused; the right one got in; a backup code worked once, and
    the second time → "Invalid backup code";
  - sessions: two devices → "Sign out everywhere else" → the other was
    bounced;
  - change password: a mismatch and a wrong current password were refused;
    a success ended the other session; the old password → 401;
  - forgot password: an unknown email got the same notice and no email; the
    known one got 1 email → the link → reset → the old session ended; the
    link again → "expired or already used"; the new password works;
  - require 2FA: refused for an admin without it; saved once they had it;
    bob → redirected to security on pages and on a direct server-action POST
    (no group created); the admin can't turn theirs off while it's required;
  - admin reset of alice: her flag and row cleared, her sessions ended; she
    signs in without a code and is sent to set it up again.

  102 tests pass (new: `account.test.ts`; 2FA reset, the gate, and an RLS
  check on `two_factor`).
- **Script lessons:**
  - zsh globs an unquoted `?` in a URL argument (quote paths with queries);
  - turning on 2FA re-issues the session, so the old cookie jar is signed
    out.
- **Not in this step:** profile picture, email change, SAML SSO, an admin
  view of everyone's sessions, the audit log.

## 2026-10-07 — groups and the Team directory (PRD 4, PRD 8 "Team")

- **Decided with the user:** everyone can create groups. The new permission
  `groups.create` was added to the Member role (migration 0021), and admins can
  take it away per role. `groups.manage` lets admins edit anyone's groups.
- **What's in place:**
  - **Groups** (sidebar → Groups): create, rename, add people (the same
    picker as reminders), remove, delete. Everyone who can see the directory
    can see who's in a group, since you need to know who it reaches before
    you send to it.
  - **A group is a recipient:** a "Groups" list in the reminder form. It's
    resolved at send time, gets Slack DMs like a department, and shows as
    "X (group)". The reminder search matches group names too.
  - **Team** (was People): search by name, email or department; initials
    avatars, departments (manager marked), status. Roles only show to people
    who can assign them.
  - **Home** lists "Your groups".
- **The approval loophole, closed:** the scope check runs on resolved
  recipients, so sending to a group of teammates needs no approval. Without
  a re-check, a member could then add anyone to the group. Adding members
  now re-checks every upcoming reminder to that group. If the creator
  couldn't reach a newly added person, it goes back to "Needs approval", the
  approvers are notified, and the editor sees how many were affected.
  Adding a teammate changes nothing.
- **Delete is blocked while an upcoming reminder uses the group**, so a
  schedule never silently loses its recipients.
- **Verified against `next start` + worker + Mailpit:**
  - alice made "Ops crew" with bob; a "now" reminder to it reached bob,
    and a later one stayed Scheduled;
  - adding carol (Sales) → "1 upcoming reminder … now needs approval", the
    reminder went pending, and the admin got an in-app notice plus an email;
    the reason reads "the Ops crew group (has people outside your
    departments), carol@…";
  - bob's direct rename/remove POSTs → refused; the admin's rename → OK; a
    duplicate name (different case) → refused;
  - delete while in use → "Used by 1 upcoming reminder", and after
    cancelling it, deleted;
  - Team search "ops" → alice and bob; no Roles column for bob, shown for
    the admin.

  98 tests pass (new: `groups.test.ts`, plus directory, validation and RLS
  cases).
- **Not in this step:** sharing a reminder's visibility with groups (PRD 5.4
  sharing isn't built yet), avatar uploads, nested groups, Slack user-group
  sync.

## 2026-10-07 — dashboard, All reminders, My tasks, calendar, tags (PRD 8, phase A)

- **Scope, decided with the user:** the views first, with tags (PRD 5.1)
  because search and filters need them. Next come Team plus groups, then
  Settings (profile, 2FA, sessions), which PRD 8 also lists but which need
  features that don't exist yet.
- **What's in place:**
  - **Home is a dashboard:** stat cards (needs approval, active, due in 7
    days, completed, failed in the last 30 days), approvals waiting, my open
    tasks, upcoming, and recent activity (my notifications). Departments,
    roles, appearance and sign out stay below until the Profile step.
  - **Reminders:**
    - search across title, description, ID, tags and recipients (people,
      departments, emails, channels);
    - filters: status, channel, repeat, type, creator, tag, date range;
    - sort, and pages of 25.
  - **My tasks:** Open and Done tabs, Mark done / Undo in place.
  - **Calendar:** a month grid in the company time zone; series expanded,
    skipped days left out; more than 3 on a day expands in place.
  - **Tags** on the form (comma separated, lowercased, ≤10, 1–30
    characters), shown as chips that link to the filtered list.
- **Fixed on the way:** the list only showed your own reminders unless you
  had `view_all`, while the detail page also let approvers and managers in.
  Now one rule (`visibleWhere`, matching `canSeeReminder`) drives every list.
- **Filters are a GET form**, so every view is a URL (deep links, the back
  button), with no client JS. Junk parameters are ignored, not errors.
- **Each stat card links to the exact filter it counts.** In E2E, all five
  cards matched their lists, for a member and for an admin.
- **Verified against `next start` + worker:**
  - visibility: alice 6, carol (her manager) 6, bob 1 (his own), admin 34;
  - tags via the form were saved lowercased and de-duplicated ("Finance, Q3
    ,finance" → finance, q3), chips link to `?tag=`, the edit form is
    pre-filled, `<b>` is refused;
  - searching "bob" found a reminder sent to bob;
  - paging: 27 results → page 1 of 2, page 2 keeps the filters;
  - My tasks: done → back on /tasks, it's in Done; undo → open again;
    `next=//evil.test` → redirected to / (safeNext);
  - calendar: 22 daily-standup entries this month, as expected (one skipped
    day missing), 30 next month; bob's private reminder not shown to alice;
    a bad month → 404.

  93 tests pass (new: `views.test.ts`; tag, task and dashboard cases).
- **Script lessons:**
  - a shell function run in `$( )` can't advance a counter (use random ids);
  - React puts `<!-- -->` between text parts, so strip it before grepping;
  - `curl -F "x=<b>"` reads a file (use `--form-string`).
- **Not in this step:** groups and the Team page, profile, 2FA and
  sessions, a week view, saved filters, full-text ranking.

## 2026-10-07 — notification centre and preferences (PRD 7.5)

- **What's in place:**
  - "Notifications" in the sidebar with an unread count;
  - a list of what's new for me: reminders and tasks sent to me, approvals
    waiting on me, mentions, comments on my reminders, my reminder
    approved/rejected, everyone done on my task, deliveries that failed;
  - "Mark all read", and "Show older" past 50;
  - Notifications → Preferences: email/Slack on or off for approvals,
    decisions and mentions.
- **Decided with the user:** preferences cover NotifyHub's own messages
  only. Reminders and tasks arrive the way the sender chose; nobody can mute
  company comms. In-app is always on.
- **Written at event time, not derived on read.** Reading "what's new" from
  six tables per page load would be slow and hard to mark read. Each writer
  inserts in the event's own transaction:
  - dispatch writes one per person per occurrence (not per channel), so it's
    exactly-once along with the deliveries;
  - "failed" and "all done" are once per occurrence via a dedupe key;
  - "all done" locks the occurrence, so two people finishing at the same
    moment don't both miss it.
- **Deliberately not per-person "done":** a 100-person task would bury
  everything else. The creator hears once, when the last one is done.
- **Opening a notification is a small GET route** that marks it read and
  redirects. Marking it read inside the reminder page wouldn't do: the layout
  (which shows the count) renders alongside the page, so the count would be
  stale on arrival. The list uses a plain link, because a prefetching `<Link>`
  could mark things read just by showing them. Arriving from an email link
  still marks it read on the reminder page; the count catches up on the next
  click.
- **Verified against `next start` + worker + Mailpit:**
  - a reminder to Ops → bob "1 unread"; clicking it → the reminder, and the
    badge gone; alice opening bob's notification → 404;
  - a task to bob and carol → carol has "task"; alice's "all done" stays 0
    after bob, then 1 after carol;
  - an out-of-scope reminder → the admin gets an in-app approval plus
    1 email; the admin turns emails off → the next one is in-app only (2 in
    the app, still 1 email); the reject → alice sees "Rejected: Wrong team";
  - carol mentioning bob → bob gets "mention" (it links to the comment)
    plus an email; alice (the creator) gets "comment";
  - alice's "Mark all read" → no badge; bob's unread untouched.

  86 tests pass (new: `notifications.test.ts`, plus cases in delivery,
  reminders, comments, tasks and `rls.test.ts`).
- **Not in this step:**
  - live push: the count updates as you move around, with no polling (add
    it if people ask);
  - per-item "mark unread";
  - cleanup of old rows;
  - Slack for approvals and decisions;
  - the person's own time zone (times show in the company's).

## 2026-10-07 — preview, send now, send a test (PRD 5.12)

- **What's in place:**
  - the reminder form has a live **Preview**: the email (From, Subject, body
    in a sandboxed iframe) and, with Slack ticked, the Slack message;
  - a reminder's page has **Send me a test** (anyone with full access, so an
    approver can see what they're approving) and **Send now** (the creator,
    or `reminders.send_now`), with a required "send it to all recipients"
    tick instead of a confirm dialog.
- **One email builder for preview, test and real sends** (`email-render.ts`).
  The worker used to assemble its own; with three callers they would drift.
  It's pure, so the client preview imports the same code.
- **Send now on a recurring reminder sends an extra occurrence** and leaves
  the schedule alone (PRD: "the next occurrence stays on its normal
  schedule"). The web sets `send_now_at`; the worker's `dispatchManual`
  claims it with `SKIP LOCKED` and reuses the occurrence creation from normal
  dispatch (extracted into `createOccurrence`), so tasks, Slack and
  attachments behave the same. A one-time reminder just moves `send_at` to
  now.
- **Tests aren't deliveries:** sent synchronously from the web action, to
  you only, with nothing written, so the notice can say what actually went
  out.
- **Verified against `next start` + worker + Mailpit + fake Slack:**
  - Send me a test → one "[Test] Daily standup" email and one DM to alice;
    bob got nothing; 0 deliveries and 0 occurrences recorded;
  - Send now on a daily reminder due tomorrow → bob's email and Slack
    within seconds, 1 occurrence, `send_at` unchanged, page still "Next: 8 Oct";
  - Send now on a one-time reminder for next week → Sent, 2 deliveries;
  - bob (not the creator) calling Send now directly → "Reminder not found.";
    on a pending reminder → "waiting for approval".

  81 tests pass.
- **Not verified by me:** the preview's live updating is client JS, so it
  only renders after the page loads (the server HTML has the section, not
  the iframe). Check it in the browser.
- **Not in this step:** a preview of the Slack file uploads, scheduled
  tests, "Send again" for an already-sent one-time reminder.

## 2026-10-07 — comments with @mentions (PRD 5.11)

- **What's in place:**
  - a Discussion section on each reminder: post, reply (one level), edit
    your own ("(edited)"), delete your own or any as an admin ("Comment
    deleted" keeps replies);
  - `@` opens a people list in the composer (a client component);
  - mentioned people get an email, plus a Slack DM if connected.
- **Mentions are explicit ids, not parsed text.** Parsing "@Name" from free
  text is ambiguous (duplicate names, names with spaces). The composer
  records ids. The server keeps an id only if it's a company member and its
  `@Name` is still in the body. The body is stored as plain text, so there's
  no markup to sanitise.
- **No leaks through mentions:** each mentioned person is checked with
  `reminderAccess`. Anyone who can't see the reminder gets nothing, and the
  commenter sees "X can't see this reminder, so wasn't notified".
  - Caught before shipping: the first draft passed an empty `createdBy` to
    that check, which would have treated the reminder's own creator as unable
    to see it. Fixed and covered by a test.
- **Moderation:** a new permission, `comments.delete_any` (Company Admin has
  it automatically).
- The mention list is the company directory, so it's only offered to people
  with `users.view`.
- **Verified against `next start` + worker + Mailpit + fake Slack:**
  - alice mentioned bob → an email and a Slack DM;
  - a reply to a reply landed in the same thread;
  - mentioning carol (another department) → no email, and the notice shown;
  - bob editing or deleting alice's comment → refused;
  - alice's edit → "(edited)", with no duplicate mention email;
  - the admin deleted bob's reply → "Comment deleted";
  - carol posting directly → refused, nothing written.

  76 tests pass.
- **Script lessons:** `curl -F "body=@Bob…"` uploads a file named "Bob…";
  use `--form-string` for text that starts with `@`.
- **Not in this step:** the in-app notification centre (mentions will also
  land there), and notifying creators of every comment.

## 2026-10-07 — attachments (PRD 5.7)

- **What's in place:**
  - up to 5 files per save (10 MB each, 20 per reminder) on the reminder
    form; on edit, "tick to remove";
  - an Attachments list on the reminder page; downloads via
    `/api/attachments/[id]`;
  - email attaches up to 20 MB and names the rest;
  - Slack uploads the files into the message's thread.
- **Storage: Postgres, by the user's choice** (bytea in `attachment_blobs`,
  metadata in `attachments`), behind `src/lib/storage.ts`. That gives RLS and
  backups for free, with no new service. The ceiling is database size; the S3
  move is one file.
- **Validation is by content:**
  - magic bytes for PDF, PNG, JPEG, GIF, WEBP, ZIP, OOXML (zip plus
    `[Content_Types].xml` and `word/`, `xl/` or `ppt/`), legacy Office (OLE);
  - strict UTF-8 with no NULs for TXT/CSV;
  - the extension must agree, and the served type is the sniffed one;
  - CSV formula injection: an RFC 4180 parse, rejecting cells starting
    `= + - @` / tab / CR unless they're a number or a `+…` phone number. The
    error names the row and column;
  - all files are checked before anything is written, so one bad file → an
    error and nothing saved.
- **Downloads:** same company (RLS) **plus** reminder visibility; always
  `attachment`, with `nosniff` and `no-store`.
- **Bug found by E2E:** files from one save shared `created_at` (`now()` is
  per transaction), so "upload order" for email was arbitrary. Now
  `clock_timestamp()`.
- **Slack:** needs the new scope `files:write`. Old connections get
  `missing_scope`, so the delivery is still sent, with a "reconnect Slack to
  allow file uploads" note, and Integrations shows a reconnect hint (scopes
  are now stored at install). Upload failures never re-post the message.
- **Verified against `next start` + worker + fake Slack + Mailpit:**
  - a fake `.pdf` and a `=HYPERLINK` CSV were refused, and nothing was saved;
  - PDF + PNG + CSV saved with the sniffed types, and all three download
    **byte-identical**, with attachment/nosniff/no-store headers;
  - a recipient gets 200; another department gets 404; signed out → sign-in;
    a bad id → 404;
  - the email carried all 3; each Slack DM got the 3 files in its thread;
  - three 9 MB PDFs (a 27 MB upload) → 2 attached, the third named;
  - the reconnect hint appears only without `files:write`.

  72 tests pass.
- **An earlier hash mismatch was a script bug,** not the app: zsh doesn't
  word-split `$IDS`, so curl fetched one bad URL and hashed an empty body.
- **The user's own fake-connected company** has no stored scopes, so it will
  show "Reconnect Slack" until they reconnect.
- **Gap:** no virus scanning (not in the PRD; noted in DEPLOYMENT).

## 2026-10-07 — Slack phase C: daily digest

- **What's in place:** a "Daily digest" section on Integrations: enabled,
  time (company zone), channels, people. Once a day the worker posts to each
  channel and DMs each person:
  - "Overdue tasks": occurrences past due with at least one assignee not
    done, shown as "N of M not done";
  - "Coming up in the next 24 hours": scheduled reminders.

  Each section is capped at 20 lines, with "+K more"; mrkdwn is escaped. An
  empty digest still posts "Nothing overdue…", so admins can see it running.
- **Claim:** the same single-UPDATE, company-local-date pattern as task
  follow-ups (`last_digest_on`). The job has no retries, so at most one a day.
  Each destination is independent: a deleted channel doesn't stop the DMs.
- **Content is company-wide** (titles of all reminders due soon), so it only
  goes where an admin points it. A per-person digest is out of scope.
- **Validation:** time `HH:MM`; channels must exist in Slack; people must be in
  the company (RLS); enabled needs at least one destination.
- **Verified against `next start` + `pnpm worker` + fake Slack:**
  - a member gets 404 on settings;
  - "enabled with nobody" is refused;
  - saved for `#general` + alice at the current minute → one post and one DM,
    with the overdue task and the reminder 2h out, times in IST;
  - the next tick → nothing more;
  - disabling makes it unclaimable.

  The fake Slack ran as a separate workspace (`FAKE_SLACK_TEAM`) so the
  user's own fake connection wasn't touched. 65 tests pass.
- **Slack (PRD 7.2) is now complete** apart from testing against a real
  workspace.

## 2026-10-07 — Slack phase B: Mark done / Snooze buttons, Slack follow-ups

- **What's in place:**
  - task messages carry Mark done (DMs and channel posts) plus Snooze 1 hour
    / Snooze until tomorrow 09:00 (DMs only; it's personal);
  - `/api/slack/interactions` verifies Slack's signature, then marks done or
    snoozes;
  - in a DM the buttons turn into "✅ Done …" / "⏰ Snoozed until …"; in a
    channel the clicker gets an ephemeral reply;
  - follow-ups go out as Slack DMs as well as email (a Slack-only task got
    none before);
  - snoozed DMs are re-sent once when due.
- **The trust model:** the button carries the occurrence, not a person. The
  clicker is resolved through `users.info` → email → user, and must hold an
  assignment, so a click in `#general` can't mark someone else done.
  - Unsigned or tampered requests → 401 (tested in unit and E2E).
  - A stale timestamp → rejected (replay).
- **Data:** migration 0014 adds `task_assignments.snoozed_until`, and lets
  `notifyhub_auth` read `slack_installations`, because a click only names a
  workspace (`team_id`). That's the same pattern as invite acceptance.
- **Delivery semantics:**
  - snooze is claimed by clearing the field in one UPDATE, and the job has
    `retryLimit: 0`: at most one re-send;
  - follow-ups send email first (retryable), then Slack (errors only logged),
    so a Slack outage never causes a second email.
- **Done clears a pending snooze**, and a repeat Mark done is a no-op.
- **E2E found this:** the user had connected their own company to the fake
  Slack, so my test company couldn't claim the same fake workspace (the
  `team_id` uniqueness working as intended). I ran the fake as another
  workspace (`FAKE_SLACK_TEAM`) instead of touching the user's data.
- **Verified against `next start` + `pnpm worker` + fake Slack:**
  - DMs carry the buttons;
  - an unsigned or tampered click → 401;
  - bob's signed Mark done → done in the app ("1 of 2") and his DM updated;
  - a non-assignee → "This task isn't assigned to you.", nothing changed;
  - alice's snooze → set, and the DM updated;
  - forced due → exactly one "Snoozed reminder" DM;
  - forced follow-up → an "Overdue" DM with buttons for alice, none for
    bob (done).

  60 tests pass.
- **Not checked:** a real Slack workspace (the buttons' look, real
  `users.info` behaviour).

## 2026-10-07 — Slack phase A: connect a workspace, send to channels and DMs

- **Built against a fake Slack, by the user's choice** (no Slack app yet).
  `scripts/fake-slack.ts` implements the OAuth authorize page and the
  methods we call, with a "noslack" directory rule and `/_messages`. Unit
  tests inject an in-process fake fetch. **Shipped unverified against real
  Slack;** the setup steps are in DEPLOYMENT.md.
- **What's in place:**
  - Integrations page: Add to Slack, Disconnect, fallback channel;
  - reminder form: Channels (Email / Slack) and Slack channel picks;
  - PRD 5.3 rules: at least one channel, email needs email recipients,
    Slack needs a channel or people, and the whole company on Slack must
    pick a channel;
  - the worker sends Slack DMs (users looked up by email at send time) and
    channel posts; no Slack account → fallback channel with a note, or
    failed if there's no fallback;
  - the delivery table has a Channel column.
- **Data model changes, and why:**
  - deliveries are now unique per (occurrence, channel, address), since one
    person can get email and Slack for the same occurrence;
  - so task completion moved to `task_assignments` (one row per occurrence
    and person), backfilled; all task tests pass unchanged in meaning;
  - `deliveries.email` → `address` was done in its own migration, because
    drizzle-kit asks interactively on renames and would otherwise risk a
    drop + add. The prompt was answered with `expect`, and the generated SQL
    is a true `RENAME COLUMN`.
- **Security:**
  - the token is AES-256-GCM encrypted (`ENCRYPTION_KEY`; processes refuse
    to start without it, which is tested);
  - the OAuth state is a random value in an httpOnly cookie bound to company
    and user, checked on return;
  - a forged callback is refused; one workspace can't be claimed by two
    companies (`team_id` unique).
- **Scope:** for non-approvers any Slack channel counts as out of scope,
  because the channel's audience isn't known. Marked `ponytail:`, with the
  member-based upgrade path.
- **Verified against `next start` + `pnpm worker` + fake Slack + Mailpit:**
  - members get 404 on integrations and install;
  - Add to Slack completes and the stored token is encrypted;
  - the fallback channel saves;
  - an Ops reminder on email + Slack + `#ops` → pending (the channel) →
    approved → 3 emails, 2 DMs, 1 `#ops` post, and carol (no Slack) in
    `#random` with a note; `<` and `&` escaped;
  - the whole company on Slack without a channel → refused;
  - a second company can't connect the same workspace;
  - Disconnect removes the connection and the Slack option.

  54 tests pass.
- **Note:** the E2E run stopped the background worker. Run `pnpm worker`
  (and `pnpm fake-slack` for Slack in dev).

## 2026-10-07 — desktop-first layout (sidebar, tables)

- **What went wrong:** earlier the user wrote "your design is for website
  not for mweb". I read it as "make it for mobile web" and built a
  mobile-first shell with a bottom tab bar and phone-sized controls. The user
  checks everything on a laptop. They asked why I kept saying "check on a
  phone", and when asked, chose desktop-first.
- **Now:**
  - a left sidebar shell (232px; a top bar with a scrolling nav row below
    768px), with Approvals and Settings added for those allowed;
  - pages up to 1040px, with the main action top right (`Page actions`);
  - `Table` for data lists: reminders, people, pending invites, departments,
    department members (with row actions), roles, approvals, the delivery
    log, task progress, occurrence history;
  - 40px controls; buttons size to their label; forms at most 640px;
  - link rows on the reminder form sit side by side;
  - `List` stays for short lists.
- **New `--success-*` tokens** (Done / Sent badges) in all three theme blocks.
- **Rules:** `AGENTS.md`'s mobile-first rule is replaced with desktop-first,
  and the "say in the browser, never on a phone" note is in memory as well.
- **Verified against `next start`:**
  - all 14 signed-in pages return 200 for an admin; member permissions are
    unchanged;
  - sidebar link sets per role; table headers on 5 pages; the header action
    is rendered;
  - the compiled CSS has the 232px grid, the 767px breakpoint, 1040/640px
    widths, and full-width buttons only inside centred auth pages.

  **Not checked visually.** That's for the user in the browser.

## 2026-10-07 — tasks with due dates and daily follow-ups

- **What's in place:**
  - "This is a task" plus a due date and time on the reminder form;
  - emails titled "Task: …" with the due time;
  - each assignee marks done or undoes on the reminder page;
  - owners see "N of M done" with per-person status (Done / Not done /
    Overdue) and follow-up counts;
  - "Your open tasks" on Home;
  - daily "Overdue: …" emails at the company's follow-up time
    (`/settings/company`, admins).
- **Completion on the delivery row,** not a separate table. One row per
  person per occurrence already exists, so a repeating task starts fresh by
  construction, and "only your own" is just `user_id = me` (plus RLS).
- **The due time is stored as an offset** from the send, so a repeating task
  stays due "the same time after it's sent" every time. One form field: the
  due time, entered as a date and time.
- **Follow-ups:**
  - one SQL UPDATE per tick claims each overdue, undone assignee once per
    company-local day (`last_followup_on`), with the slot computed in the
    company zone in SQL. A second tick or worker that day matches nothing;
  - the job re-checks "done" before sending, so marking done just after the
    claim still stops the email;
  - a follow-up is only sent if the task was overdue at the slot time: due at
    10:00 with a 09:00 slot means the first follow-up is the next morning.
- **Test isolation:** `claimFollowUps` takes the same test-only scope as
  `dispatchDue`. Without it, a test run at 2042 dates would stamp real dev
  deliveries' `last_followup_on` and silence their real follow-ups until 2042.
- **Deferred:**
  - manager escalation after N days (PRD: optional);
  - in-app and Slack follow-ups;
  - the shared done toggle for external-only tasks;
  - "mark complete" on non-task reminders;
  - a `/tasks` page.
- **Verified against `next start` + `pnpm worker` + Mailpit:**
  - "Task:" emails; the owner sees 0 of 2; the assignee sees only their own
    status;
  - carol marking bob's task → refused, nothing written;
  - bob done → 1 of 2, and it leaves his open tasks;
  - forced follow-up time: carol got exactly one "Overdue:" and bob (done) none;
  - the next tick that day sent nothing;
  - company settings: admin only, and an invalid time is refused.

  43 tests pass, including the follow-up slot in Asia/Kolkata, once a day,
  stopping on done, and skipping deactivated users.
- **Not checked:** the task section and buttons on a phone.

## 2026-10-07 — theme switch (system / light / dark)

- **Why:** the user asked for a light theme. The light colours already
  existed, but the app only followed the device setting, so on a dark-mode
  device light was unreachable. PRD 8 wants a remembered choice that follows
  the system by default.
- **How:** a `theme` cookie (1 year, per device), read in the root layout,
  which sets `<html data-theme>`. The CSS dark tokens apply under
  `prefers-color-scheme: dark` unless the theme is `light`, and always under
  `data-theme="dark"`. `color-scheme` is set, so date pickers and selects
  match.
- **Rejected:** localStorage with a client script. It flashes the wrong theme
  before hydration and needs an inline blocking script. The cookie costs
  nothing, since every page is already server-rendered per request.
- **The switch** is a segmented control (System / Light / Dark, 44px buttons,
  `aria-pressed`) on Home under "Appearance". It's a plain form posting to a
  server action, with no client JS.
- **Verified against `next start`:**
  - with no cookie there's no attribute (the device decides);
  - Light, Dark and System each set or clear the attribute on Home,
    Reminders and the sign-in page, and the pressed button matches;
  - a bogus value is ignored;
  - the compiled CSS contains `:root:not([data-theme=light])` inside the
    dark media query, and `:root[data-theme=dark]`.

  **Not checked:** how it looks. That's for the user, in the browser.

## 2026-10-07 — recurring reminders

- **What's in place:**
  - presets: daily / weekdays / weekly / monthly / annually;
  - custom: every N days, weeks, months or years; weekdays; monthly by date,
    by Nth weekday, or by last weekday; ends never / on a date / after N;
  - pause / resume / skip next;
  - a plain-language summary and "Next: …";
  - occurrence history (sent / missed / skipped).
- **Decided with the user:**
  - catch-up sends only the latest missed occurrence; the rest are recorded
    "missed";
  - edits apply to the whole series. "Change just one occurrence" is deferred.
- **No drift:** every occurrence is computed from the anchor, never from the
  previous one. `src/lib/recurrence.ts` tests:
  - 31st → 28/29 Feb → 31 Mar → 30 Apr → 31 May;
  - 3rd Tuesday; last Friday in 4- and 5-Friday months;
  - 29 Feb → 28 Feb → 29 Feb;
  - 09:00 New York held across both 2026 DST changes; a 02:30 daily on the
    gap day moves to 03:30 for that day only.
- **Data:** `send_at` became "next occurrence", so the worker loop,
  `isDelayed` and the list needed no new concept. A new
  `reminder_occurrences` table (unique per reminder and time) and
  `deliveries.occurrence_id` change exactly-once to (occurrence, person).
  Migration 0009 was hand-edited to backfill; checked against the 3 real dev
  reminders and 5 deliveries.
- **Two bugs found while building:**
  - the edit form shows the next occurrence as the start, so saving any edit
    would have re-anchored "monthly on the 31st" to the 30th. An unchanged
    start now keeps the original anchor (tested);
  - resume after skip showed the skipped occurrence as "Next". The worker
    wouldn't have sent it, but the page was wrong. Resume now steps over
    recorded occurrences (tested + E2E).
- **Verified against `next start` + `pnpm worker` + Mailpit:**
  - a daily "Now" sent once, with next tomorrow;
  - a simulated 3-day outage → 3 missed + 1 sent, bob got exactly 1 email,
    and next is back in the future;
  - another user can't pause the series;
  - skip / pause / resume;
  - a paused, overdue reminder is not "Delayed";
  - the custom rule summary in the list; edit pre-fills the custom fields.

  39 tests pass.
- **Not checked:** the Repeat section's look on a phone (the select, the
  "Custom repeat" disclosure, the side-by-side "Every [n] [unit]" row). The
  custom fields are always visible inside the disclosure: no JS, so they don't
  hide when another preset is chosen.

## 2026-10-07 — "delivery is delayed" safeguard

- **What happened:** the user created a "Now" reminder and it stayed
  "Scheduled". The engine was fine: the worker wasn't running, because it
  was stopped after the last test and nothing in the UI said so.
- **Fix:** `isDelayed()` flags a reminder as Scheduled over 60s past due, or
  Sending with no update for 120s. The list badge reads "Delayed" and the
  detail page shows a warning saying it'll go out automatically, once.
  - We rejected a worker heartbeat table: more moving parts, and it can only
    say "no worker", while the derived check also catches a worker that's
    alive but stuck.
  - The 60s threshold: the worker normally sends within a second, and its
    minute tick is the backstop.
- **Tests no longer depend on whether a worker is running:**
  - a live worker broke the lifecycle test by sending its "now" reminder
    mid-test;
  - fixed with test send times an hour ahead, plus a test-only `now` argument
    to `dispatchDue`.
- **Verified against `next start`:**
  - worker stopped + a 2-minute-overdue reminder → "Delayed" badge and the
    warning;
  - worker started → sent, and the warning is gone.

  24 tests pass.

## 2026-10-07 — reminders send for real; edit fix; recipient picker

- **What the user reported:**
  - "Now" didn't send. Expected: delivery wasn't built yet;
  - edit needed checking. A real bug: the edit page always pre-picked "At a
    set time" with the original time, so a pending or rejected "Now" reminder
    couldn't be resubmitted ("Pick a time in the future");
  - recipients needed per-teammate ticking and a searchable people dropdown.
- **Delivery engine (0008 `deliveries`, `src/worker/delivery.ts`):**
  - dispatch: SKIP LOCKED + `unique(reminder_id, email)`;
  - the send claims its row; up to 5 attempts with pg-boss backoff, then
    `failed`;
  - the sweep fails stuck `sending` rows and **never resends them**. We
    rejected at-least-once: a retry after an SMTP timeout is exactly how a
    person gets the same reminder twice.
- **"Now" means now:** the web app runs `pg_notify('reminders_due')` in the
  scheduling transaction, and the worker LISTENs. Approving an overdue
  reminder fires it the same way.
  - First measurement: 3.8s for 2 people and **10.3s for 5**, because pg-boss
    polls every 2s and ran one job at a time.
  - Fixed with pg-boss queue `notify` and `localConcurrency: 10`: **0.2s for a
    5-person company-wide send.**
- **Recipients can open what they received** (`reminderAccess` →
  "recipient"). They see the reminder, but not the recipient list or the log.
  Owners get a delivery log ("5 sent · 0 failed · 0 pending" plus per-person
  rows).
- **Recipient picker:**
  - your departments show as open sections with "Everyone in X" plus each
    teammate as a tick;
  - other departments are whole-department choices marked "need approval";
  - people is a searchable combobox (`people-picker.tsx`, the second client
    component), with chips carrying hidden inputs and a `<noscript>`
    multi-select fallback;
  - teammates pre-fill as ticks, not chips, so edit doesn't show them twice.
- `resolveRecipients` moved to `src/lib/recipients.ts` (schema-only imports)
  so the worker doesn't load the web app's DB client.
- **Verified against `next start` + `pnpm worker` + Mailpit:**
  - ticked teammates both got "Now" within seconds, each To only themselves,
    From "… via NotifyHub", Reply-To the creator, with the link;
  - whole company → pending, no mail → approve → all 5 sent;
  - recipient 200 (no log); non-recipient 404;
  - a rejected "Now" edit reopens as "Now" and resubmits → approve → sent;
  - worker down → stays Scheduled → restart sends once;
  - **exact-subject Mailpit count: every reminder reached each person exactly
    once across two restarts.**

  23 tests pass, including parallel dispatch, a double claim, retries → failed,
  and the sweep.
- **Side effect in the dev DB:** the first worker start sent 2 "Now" reminders
  the user had created while testing phase 1. That's the intended catch-up
  behaviour.
- **Not checked:** the picker's look and feel on a phone (search, chips,
  department sections), and a real SES send.

## 2026-10-07 — reminders phase 1: create, scope, approval

- **What's in place:**
  - `reminders` and `reminder_targets` (0007);
  - `/reminders` list, new, detail, edit, cancel;
  - `/approvals` queue; approve or reject (a reason is required, and the
    creator is emailed); approvers are emailed on submit;
  - a Reminders tab, and "Approvals waiting (N)" on home.

  **Nothing sends yet.** The worker comes in phase 2.
- **Targets, not recipients, are stored.** They're resolved at use time
  (PRD 5.2). One `resolveRecipients()` serves both the scope check and (next)
  the worker, so the two can't disagree about who gets it.
- **Scope check** follows PRD 5.2. Department targets the sender isn't in are
  flagged by name, and resolved people by email. That's what the "needs
  approval" banner shows.
- **Approval-widening rule:** editing keeps an approval only if the new
  targets are a subset of the old ones. We rejected comparing resolved people,
  because membership changes between approval and edit would flip the result
  for reasons the editor can't see.
- **Time zones:** `src/lib/time.ts` uses only Intl. A DST gap moves forward and
  an overlap takes the earlier time (Temporal "compatible"); tested on New York
  2026 transitions. Inputs are in the company zone.
- **`sendMail` takes an options object** (several links, `fromName`,
  `replyTo`). The from-*address* never changes, only its display name.
- **`requireMember()` also returns the company** (name, time zone). The layout
  already queried it, so it's still one query per request.
- **Known gap:** a validation error on the reminder form redirects back and
  loses what was typed. Accepted for now: no client JS, and `required` covers
  most cases. Fix with `useActionState` if it bites.
- **Verified against `next start` + Mailpit with curl:**
  - in-scope → Scheduled; out-of-scope → Needs approval, with the admin
    emailed and the banner naming Sales and carol;
  - 09:30 Asia/Kolkata is stored as 04:00 UTC;
  - `<b>` and `<script>` in title and description render escaped;
  - visibility: creator, manager and admin 200; another department's member 404;
  - **direct calls:** alice approving her own reminder → 404; carol cancelling
    or editing alice's → refused, nothing written;
  - reject without a reason is refused; with one, alice gets the email;
  - resubmit → pending; approve → scheduled with `decided_by`; cancelled →
    the edit page is 404.

  19 tests pass.
- **Script lesson:** the first run lost a test user to Better Auth's sign-up
  rate limit (more than 3 sign-ups in 10s from one IP). The rate limit working
  is correct; the script now spaces them.

## 2026-10-07 — mobile-web restyle, departments on home

- **Why:** the user pointed out that the screens were designed like a desktop
  website (a narrow centred column, small text-link actions), but the product is
  used as a mobile web app.

  There was no written rule, so I decided one and recorded it in `AGENTS.md`:
  mobile first, 48/56/44px touch targets, an app shell with a bottom tab bar,
  back links at the top, and screens built only from the kit.
- **Structure:**
  - signed-in pages moved into the `(app)` route group (URLs unchanged) so they
    share `layout.tsx`;
  - the UI kit moved to `src/components/` with an `@/` import, because the move
    broke the relative imports. That also prevents it happening again;
  - `FormPage` was renamed `Page`, and gained `back` and `center`;
  - new `Section`, `LinkButton`, and `List`/`ListRow`, which replace three copies
    of list CSS in the users, departments and roles pages.
- **First client component:** `nav-link.tsx`, needed only for `usePathname()`
  to mark the active tab. Everything else stays server-rendered.
- **`requireMember()` is now `cache()`d**, since the layout and the page both
  call it.
- **The home page** shows "Your departments" (with a Manager badge), your roles,
  and sign-out. Its old links moved to the tab bar.
- **Verified against `next start` with curl:**
  - every page returns 200 for the admin;
  - the manager gets 404 on invite and roles pages;
  - tab sets per role are right; the active tab is marked on sub-pages;
  - the manager's home shows Ops as Manager, and Ops shows them add/remove only;
  - the viewport meta carries `viewport-fit=cover`.

  12 tests pass. **Not checked visually.** That's the user's call on a phone: the
  tab bar over the iPhone home indicator, row actions wrapping, and dark mode.

## 2026-10-07 — departments, managers, members (phase B)

- **What's in place:**
  - `/departments` list and create;
  - `/departments/[id]` with members, add/remove, make/unmake manager, rename,
    and delete;
  - invites can place people in departments;
  - a person's page lists their departments.
- **Managers are chosen only by admins.** Make-manager checks
  `departments.edit` with no department argument, so manager permissions never
  apply to it. That guards against a future `MANAGER_PERMISSIONS` change letting
  managers promote themselves.
- **Invite acceptance adds memberships through `authDb`.** Migration 0006
  grants it SELECT on departments (scoped by the tenant setting accept already
  sets) and INSERT on `department_members`. Departments deleted between invite
  and accept are skipped, and an invitee never joins as a manager.
- `SelectField` now takes `{ value, label }` options as well as plain strings.
- **Verified against `next start` + Mailpit with curl:**
  - the admin creates departments; a duplicate name is refused;
  - an invite into Ops lands the new user in Ops;
  - the admin makes them manager of Ops;
  - **calling the actions directly as that manager:** add/remove in Ops goes
    through; adding to Sales, making anyone manager, rename, delete and create
    all get 404;
  - **as a plain Member:** every action gets 404, and a bad uuid gets 404;
  - the final DB state matches exactly, and the admin's delete works.

  12 tests pass.

  **Not checked:** the browser layout of the department pages and the
  department checkboxes on the invite form.
- **Dead end, script only:** the first E2E run got 500s everywhere because
  `eval` in the test script expanded `$ACTION_ID_…` field names into empty
  strings. It wasn't an app bug. Fixed with quoting, plus a 30-second cap on
  waiting for mail.

## 2026-10-07 — invites, people list, role assignment, deactivation (phase A)

- **Invites:**
  - the token is hashed at rest;
  - claiming it is single use and race-safe (conditional UPDATE);
  - expires after 7 days;
  - re-inviting replaces the pending invite (partial unique index).

  Accepting marks the email verified. The accept page handles three cases:
  new account, signed in as the invitee, and existing account signed out
  (→ `/sign-in?next=`, open-redirect-safe).
- **`sendOnSignUp` turned off**, and `/sign-up` sends explicitly. Without this,
  creating the invitee's account would send a pointless verification email.
  Re-checked: the sign-up page still sends it.
- **Deactivation has three layers** (session hook, session delete, check in
  `requireMember`). The app role can't touch `session`, so the guard and the
  update run in one app-role transaction, and the session delete runs right
  after on `authDb`. Not atomic. Accepted because `requireMember` refuses the
  user in that window.
- **Escalation rule:** you can only grant, remove, or act on people whose roles
  you could grant. Without it, a custom role with `users.manage_roles` could
  hand out Company Admin.
- **Last-admin guard** uses a per-company `FOR UPDATE` lock. Without the lock,
  two admins demoting each other at once would both pass the count.
- **Shared `CheckboxGroup`**: the roles form switched to it, and
  `role-form.module.css` was removed (its styles moved into
  `form.module.css`).
- **Verified against `next start` + Mailpit with curl:**
  - sign-up still emails;
  - an admin invites, the email arrives, the accept form creates the account,
    which lands in the company verified with Member, and the reused link is
    refused;
  - as a Member, direct calls to invite, grant self admin, and deactivate the
    admin each get 404 with no write;
  - the admin demoting themselves as the last admin is refused;
  - deactivating deletes sessions, bounces the open session, and sign-in says
    "deactivated"; reactivating restores sign-in;
  - `?next=//evil.com` falls back to `/`.

  11 tests pass (Mailpit must be running).

  **Not checked:** browser layout; the "existing account → sign in → accept"
  path end to end (its pieces are tested separately).

## 2026-10-07 — roles and permissions

- **What's in place:**
  - the permission catalogue in code;
  - `roles` (system roles have `company_id` NULL), `user_roles`, and
    `department_members.is_manager`;
  - `can()` / `loadAccess()` / `requireMember()`;
  - the onboarding creator becomes Company Admin; migration 0004 backfilled
    existing companies;
  - `/settings/roles` to create, edit and delete custom roles.
- **Company Admin is "everything" in code, not in its row.** We rejected storing
  the full list, because every new permission would then need a data migration,
  and forgetting one would silently lock admins out of a feature.
- **Manager permissions are a fixed list in code**, applied per managed
  department. We rejected a configurable department-scoped role: no customer
  has asked, and it doubles the `can()` logic. Marked `ponytail:`.
- **System roles are protected by RLS plus explicit checks.** The tenant WITH
  CHECK can't match NULL, so the app role can't edit, delete or create them
  (tested). The actions also scope writes by `company_id`. Both layers are kept
  deliberately.
- **Delete confirmation is a required checkbox**, not a JS `confirm()`, so the
  page stays free of client JS.
- **Verified against `next start` with curl:**
  - an admin sees the Roles link, the list, a read-only built-in role and the
    new-role form;
  - a malformed or unknown id gets 404;
  - after a downgrade to Member, the link is gone and every roles URL is 404;
  - signed out redirects to sign-in;
  - calling the create action directly: an admin creates a role, while a
    duplicate name, a built-in name and an unknown permission are each refused;
  - **as a Member, the direct action call gets 404 and writes nothing.**

  **Not checked:** the edit and delete actions by direct POST (covered by the
  same `requireRoleManager()` path, plus RLS), and the pages in a browser.
- **Not built yet:** assigning roles to users, picking managers, and last-admin
  protection. All of these wait for user management and invites.

## 2026-10-07 — tailwind replaced with css modules

- **Why:** with Tailwind, an element in devtools is a wall of utility classes,
  and you can't tell which component it belongs to. With CSS Modules, each
  component's styles live in one `.module.css` file beside it, and the inspector
  shows `form-module__<hash>__field`.
- **Rejected:** plain global CSS files. One namespace for the whole app means
  `.title` in two components collide, and rules leak between them. CSS Modules
  are built into Next.js and need no extra setup.
- Removed `tailwindcss`, `@tailwindcss/postcss` and `postcss.config.mjs`.
  Colours moved to CSS variables in `globals.css`, with dark-mode overrides.
- **Checked:** the compiled HTML from `next start` carries the module class names.
  Values were ported 1:1 from the Tailwind classes (zinc palette, 6px radius,
  16px input font), so pages should look the same. **Not checked visually**:
  that's for the user, in the browser.

## 2026-10-07 — email sending and email verification

- **Closes the domain-claim hole** from the auth entry below. Before this,
  anyone could sign up as `x@acme.com` and own the acme.com company. Now sign-in
  requires a verified email, and `createCompany` checks `emailVerified` again.
- **SMTP only, via nodemailer.** Mailpit in dev, SES's SMTP endpoint in prod.
  Same code path, and only the URL differs. We rejected the SES SDK for now
  because nothing needs the API yet. It will be needed for per-company domain
  verification (PRD 7.1 tier 2) and bounce handling. **SES itself is
  unverified:** there's no AWS account set up, so only Mailpit has been tested.
- **The verification send isn't awaited**, so sign-up timing doesn't reveal
  registered emails. Measured: 72 ms for an existing email vs 68 ms for a new one,
  identical response shape. Trade-off: a failed send is only logged. Signing in
  again resends (`sendOnSignIn`).
- **Deviation from PRD 11.1 ("tokens never in URLs"):** an email link has to
  carry a token. Better Auth's is a stateless JWT (1 hour), so it isn't
  single-use. Checked: reusing a link after verification redirects but creates
  no session. Revisit if we need early revocation.
- **Verified end-to-end against `next start` + Mailpit with curl:**
  - sign-up returns no session;
  - an unverified sign-in gets `EMAIL_NOT_VERIFIED` and a fresh email;
  - the user's name is HTML-escaped in the email;
  - the link verifies, signs the user in and lands on `/onboarding`;
  - a bad token ends on `/sign-in` with a readable error.

  **Not checked:** how the email looks in a real mail client, and the browser flow.

## 2026-10-07 — sign-up, sign-in and company onboarding

- **Better Auth 1.7, email/password and Google.** Google is wired, but
  **shipped unverified**: there are no OAuth credentials yet, so the button is
  hidden. Unverified Google emails are rejected in `mapProfileToUser`.
- **A third DB role, `notifyhub_auth`.** Sign-in looks a user up by email before
  any company is known, which RLS on `user` would block. Rejected alternatives:
  - leaving `user` without RLS: the directory would rely on every query
    remembering a `where company_id`;
  - giving Better Auth the owner URL: the web process would hold a key that
    bypasses everything;
  - `BYPASSRLS`: managed Postgres often refuses to grant it.

  Instead: a role-specific `auth_unscoped` policy, plus grants limited to auth
  tables and `companies`. `notifyhub_app` lost its grants on
  `session`/`account`/`verification` (tested).
- **Onboarding is one transaction on `authDb`:** insert the company, then attach
  the user only if they have no company yet. A duplicate domain or a second
  attempt rolls back with no stray company (tested). The domain comes from the
  email, and common free-mail domains are refused.
- **Server actions, not the client SDK.** Errors come back as `?error=` on the
  same page. Less JS; trade-off: no inline validation without a reload.
- **Verified against `next start` with curl:**
  - sign-up creates a session (7-day sliding expiry);
  - `/` sends an unonboarded user to `/onboarding`;
  - once a company is attached, `/` renders its name through the RLS role;
  - sign-out deletes the server-side session;
  - a wrong password is rejected;
  - a client-supplied `companyId` gets `FIELD_NOT_ALLOWED`;
  - a mismatched origin gets `INVALID_ORIGIN`.

  **Not driven through the browser:** the onboarding form's server action itself
  (its logic is covered by `onboarding.test.ts`) and the visual layout.
  Update, same day: the user checked the sign-in page in a browser and it works.
  The onboarding form still hasn't been confirmed in a browser.
- **Known hole, deliberately left for now:** no email verification, so the first
  person to sign up with a domain claims that company. It's blocked on email
  sending (SES). Listed in DEPLOYMENT known gaps.

## 2026-10-07 — repo setup and tenant isolation

- **Stack:** Next.js 16 + Postgres + Drizzle + pg-boss worker, all TypeScript.
  We considered Rust and rejected it for this product. The load is I/O-bound
  (Postgres, SES, Slack rate limits), so Rust's speed buys nothing. Its SAML and
  2FA libraries are thin, and learning the language while building an
  enterprise SaaS is slow and risky. The worker is already a separate process,
  so it could be rewritten later if it is ever measured as the bottleneck.
- **One package, not a monorepo.** Web and worker share the schema. Split when a
  second deployable needs different dependencies.
- **Tenant isolation is enforced in Postgres (RLS)**, behind app-level checks.
  Found during setup: after `set_config(..., true)` ends, the setting reads back
  as `''`, not NULL, so `::uuid` threw on unscoped queries. Fixed with
  `nullif` (migration 0002). Verified by `src/db/rls.test.ts`: an unscoped read
  returns 0 rows, a scoped read sees only its tenant, and a cross-tenant insert
  is rejected.
- **Worker verified locally:** starts and logs `tick` every minute (pg-boss
  cron). It does nothing else yet.
- **Not yet in the schema:** users, auth, reminders. Users come with Better
  Auth, which owns its own user/session tables. Building a users table first
  would have meant redoing it.
- **Shipped unverified:** nothing is deployed. `DEPLOYMENT.md` lists the gaps.
