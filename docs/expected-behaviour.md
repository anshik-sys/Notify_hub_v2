# Expected behaviour: v1 gap items #4, #5, #7, #8, #9, #11; v2 calendar and events

What each feature should do, written from the PRD and the product owner's
decisions, **not** from the code. Behaviour tests are written from this file,
one test per case id (test names start with the id, e.g. `D3: …`), so a
failing test means either the code or this file is wrong, and we decide which.

Status column: results of the spec tests, 2026-10-19 (sections 1–7) and
2026-10-20 (8–10; section 10's are in `src/lib/spec-calendar.test.ts`). The tests are
`src/lib/spec-delete-snapshot.test.ts`, `src/lib/spec-people.test.ts`,
`src/lib/spec-only-next.test.ts`, `src/worker/spec-escalation.test.ts`,
`src/worker/spec-volume.test.ts`, `src/lib/spec-photos.test.ts` and
`src/lib/spec-preferences.test.ts`,
written from this file by testers who didn't read the implementation.

Who's who in the cases:

- **Creator**: made the reminder.
- **Admin**: has the Company Admin role (every permission).
- **Editor**: a custom role with `reminders.edit` (and sometimes
  `reminders.view_all`), but not `reminders.approve`.
- **Member**: the plain Member role.
- **Recipient**: a member it was sent to.
- **Manager**: `is_manager` in a department.

"Refused" means the function returns an error message and nothing changes.

---

## 1. Delete a reminder (#5, PRD 5.6)

Decided 2026-10-19: deleted = **hidden everywhere**, no restore.

| Function | What it does |
|---|---|
| `deleteReminder(actor, companyId, id)` (`src/lib/reminders.ts`) | Soft-deletes the reminder: hides it everywhere and stops anything further being sent. Returns an error or `null`. |

| ID | Scenario | Expected | Source | Status |
|---|---|---|---|---|
| D1 | Creator deletes their own reminder; try each status: scheduled, paused, sent, cancelled, rejected, pending approval | Allowed in every one | PRD 5.6 | PASS |
| D2a | An editor who can see it in full (has `reminders.view_all`) deletes someone else's | Allowed | PRD 5.6 "holders of the edit/delete permission" | PASS |
| D2b | A member who isn't the creator; a recipient; an editor who can't see it | Refused ("not found") | Visibility rule (PRD 5.4) | PASS |
| D3 | After delete: open it, list it, search it, calendar, dashboard "upcoming" | Not found / not listed, for the creator, an admin, a recipient, someone it was shared with | Decision 2026-10-19 | PASS |
| D4 | After delete: read or post comments, Send me a test, Send now, edit, cancel | All refused | Hidden everywhere | PASS |
| D5 | A deleted scheduled reminder reaches its send time; a deleted repeating one reaches its next date | Nothing is sent | Hidden everywhere | PASS |
| D6 | A sent task is overdue, then deleted | Daily follow-ups stop | Hidden everywhere | PASS |
| D7 | The task's assignee opens My tasks (open and done tabs) | It's not listed | Hidden everywhere | PASS |
| D8 | Someone had a notification about it | Gone from the notification list, and the unread count drops | Hidden everywhere | PASS |
| D9 | Some of its deliveries are queued or sending | Refused ("being sent"); allowed once they're sent or failed | Nothing goes out after a delete | PASS |
| D10 | Delete it again | Refused ("not found") | | PASS |
| D11 | Audit log after a delete | A row for the reminder, attributed to the person who deleted it | PRD 5.6 "with an audit trail" | Browser (Chrome 2026-10-19: logged as Maya). Lib test skipped: the actor comes from the signed-in request |
| D12 | Task reports (completion, overdue) | The deleted task isn't counted | Hidden everywhere | PASS |
| D13 | Retention period passes | It's purged with other finished reminders | PRD 11.5 "soft delete with a retention period" | PASS |

## 2. What each send actually said (#5, PRD 6)

| Function | What it does |
|---|---|
| Worker `createOccurrence` (in `dispatchDue` / `dispatchManual`) | Records the title, description, links and sender when an occurrence is created. |
| Worker `deliverOne(deliveryId, send?)` | Sends one delivery using that recorded copy. |
| `deliveryLog(companyId, reminderId)` | The latest occurrence (with its recorded copy) plus the last 10. |

| ID | Scenario | Expected | Source | Status |
|---|---|---|---|---|
| S1 | An occurrence is sent | Its log shows the title, description, links and sender as they were at that moment | PRD 6 delivery log "snapshot" | PASS |
| S2 | The reminder is edited after that | That occurrence's log still shows the old content | Snapshot | PASS |
| S3 | A delivery failed, the reminder is edited, then the delivery is retried | The retry sends the original subject | Same occurrence = same message | PASS |
| S4 | A repeating reminder is edited between two sends | The second send has the new content; the first keeps the old | Snapshot | PASS |
| S5 | Missed or skipped occurrences | No recorded copy (nothing was sent) | | PASS |

## 3. Admin manages a person (#4, PRD 9.1)

Decided 2026-10-19: no separate "create user"; Invite covers it.

| Function | What it does |
|---|---|
| `renamePerson(actor, companyId, userId, name)` | Changes a person's name. |
| `personSessions(actor, companyId, userId)` | Lists where they're signed in, or `null` if you may not manage them. |
| `signOutPerson(actor, companyId, userId)` | Ends all of their sessions. |
| Profile → Email (`changeEmailAction`) | Sends a link to the new address; the email changes when it's clicked. |

The `users.edit` permission itself is checked in the server action; these
functions enforce "not someone above you" and company boundaries.

| ID | Scenario | Expected | Source | Status |
|---|---|---|---|---|
| P1 | An editor of people renames a member to "  Robert " | Saved as "Robert"; shows in Team and on their page | PRD 9.1 "edit" | PASS |
| P2 | Name is empty, only spaces, or over 100 characters | Refused; name unchanged | Same rule as Profile | PASS |
| P3 | Someone with only `users.edit` renames a Company Admin | Refused ("can't manage"). An admin can rename anyone | Same rule as deactivate | PASS |
| P4 | Rename someone from another company | Refused; their row unchanged | Tenancy | PASS |
| P5 | Rename an erased person | Refused | PRD 11.5 | PASS |
| P6 | List someone's sessions | Device, IP, signed in, last active; never the session token. `null` for someone above you | PRD 9.1 "active sessions: see them" | PASS |
| P7 | Sign someone out everywhere | All of their sessions end and nobody else's do. Refused for yourself and for someone above you (their sessions survive) | PRD 9.1 "revoke them" | PASS |
| P8 | Change your own email | Wrong password refused; a link to the new address; email changes only after the click; an address already in use gets the same answer and no email; the public `/api/auth/change-email` route returns 404 | PRD 3.3 | Browser only (checked 2026-10-19) |

## 4. Change only the next occurrence (#7, PRD 5.6)

| Function | What it does |
|---|---|
| `detachOccurrence(actor, companyId, seriesId, input, files?, removeAttachmentIds?)` | Turns the series' next occurrence into a separate one-time reminder (the edited version); the series skips that date. Returns `{ id }` of the new reminder or `{ error }`. |

| ID | Scenario | Expected | Source | Status |
|---|---|---|---|---|
| T1 | "Only the next one" on a scheduled series, made by an admin | A new one-time reminder with the edited fields at the chosen time, scheduled; its creator is the series' original creator | PRD 5.6 | PASS |
| T2 | The series afterwards | That date is recorded as skipped; next date = the following occurrence; its own content unchanged | | PASS |
| T3 | The worker runs past that date | The series sends nothing for it; the copy sends once | | PASS |
| T4 | Attachments | Files not removed are copied to the new one; removed ones aren't copied but stay on the series; newly uploaded files go on the new one only | | PASS |
| T5 | Series is paused, pending approval, cancelled, deleted, or a one-time reminder | Refused | Decision: scheduled series only | PASS |
| T6 | A member who can't change the series tries | Refused ("not found") | PRD 5.6 | PASS |
| T7a | Copy has recipients outside the creator's scope | Needs approval; approvers notified; the series does **not** skip that date yet | PRD 5.9; decision 2026-10-19 (b) | PASS |
| T7b | Series was approved for those same recipients | Copy is scheduled, no new approval | PRD 5.9 "approval covers the series" | PASS |
| T7c | Copy adds a NEW out-of-scope recipient | Needs approval | PRD 5.9 | PASS |
| T8 | An editor without approve sends an admin's series' copy to the whole company | Needs approval | Same rule as editing | PASS |
| T9 | The next occurrence was the series' last | The series ends after the copy is made | | PASS |
| T10 | The input has a repeat rule | Refused | It's one occurrence | PASS |
| T11 | Copy needs approval and is approved before that date | On the date the series sends nothing; the copy sends once | Decision 2026-10-19 (b) | PASS |
| T12 | Copy is still waiting for approval when the date arrives | The series sends as usual; the copy doesn't | Decision 2026-10-19 (b) | PASS |
| T13 | Copy is rejected, cancelled or deleted before the date | The series sends as usual on that date | Decision 2026-10-19 (b) | PASS |
| T14 | Copy is approved after the series already sent that date | The copy is sent on approval too (its send time has passed, PRD 5.9); the series' send isn't undone | Consequence of (b) | PASS |
## 5. Overdue escalation (#8, PRD 5.8)

Decided 2026-10-19: N is a company setting; managers are told, or the creator
if the person has no manager; once per person per occurrence.

| Function | What it does |
|---|---|
| `setEscalateAfterDays(companyId, raw)` (`src/lib/company.ts`) | Saves N; blank = off. |
| Worker `escalateOverdue(now?, onlyCompany?, send?)` | Finds assignees still not done N days after due, tells their managers (in the app and by email), and stamps each one so it happens once. |

| ID | Scenario | Expected | Source | Status |
|---|---|---|---|---|
| E1 | Setting: blank / 1 / 60 / 0 / 61 / 2.5 / "abc" | blank = off; 1 and 60 saved; the rest refused, value unchanged | Decision | PASS |
| E2 | Assignee not done, N days past due | Each active manager of their department gets 1 notification and 1 email naming the person and task | PRD 5.8 | PASS |
| E3 | Assignee in two departments with different managers | Both managers told | PRD 5.8 | PASS |
| E4 | The assignee is a manager themselves | They aren't told about themselves; if they're the only manager, the creator is told | Decision | PASS |
| E5 | Assignee in no department | The creator is told. If the creator is the assignee, nobody is | Decision | PASS |
| E6 | Assignee already done | Nobody told | PRD 5.8 | PASS |
| E7 | Only N−1 days past due; exactly N days | Not yet; then told | PRD 5.8 | PASS |
| E8 | The worker runs again (every minute) | Not told again | Decision: once | PASS |
| E9 | Setting off; company suspended; task cancelled or deleted; assignee deactivated; manager deactivated | No escalation (a deactivated manager isn't told; the others are) | | PASS |
| E10 | A manager muted "late on a task" by email | In-app notification only, no email | PRD 7.5 | PASS |
| E11 | Manager opens the task after being told | Can open it as a viewer (sees the task, not the delivery log) and finds it in their reminder list; before being told, they can't | Decision: managers can open it | PASS |
| E12 | Threshold crossed more than 7 days ago (setting just turned on) | Not escalated | No flood on switch-on | PASS |
| E13 | Another company's overdue tasks | Untouched | Tenancy | PASS |

## 6. One "done" when nobody is assigned (#8, PRD 5.8)

| Function | What it does |
|---|---|
| `setOccurrenceDone(actor, companyId, occurrenceId, done)` | Marks a sent occurrence done (or undoes it) when nobody in the company is assigned. |

| ID | Scenario | Expected | Source | Status |
|---|---|---|---|---|
| SD1 | Task sent only to outside addresses, sent | Creator can Mark done and Undo; an editor who can see it can; a member who can't edit it is refused | PRD 5.8 "single shared done" | PASS |
| SD2 | Plain reminder (not a task), sent | Creator can Mark complete / Undo | PRD 5.8 "mark complete toggle for the creator" | PASS |
| SD3 | Task with assignees in the company | Refused ("each assignee marks it themselves") | PRD 5.8 | PASS |
| SD4 | Occurrence not sent yet (skipped, missed) | Refused | | PASS |
| SD5 | Repeating: the next occurrence | Starts not done | PRD 5.8 "each occurrence starts fresh" | PASS |
| SD6 | The reminder was deleted | Refused | Hidden everywhere | PASS |

---

## 7. Volume alert looks ahead (#9, PRD 6)

PRD 6: "the platform owner is warned when any upcoming day has more than a set
number of scheduled emails". The threshold is the existing platform setting
(Platform → Settings, "daily volume alert"); blank = no alerts.

Rules marked **(proposed)** are mine; confirm or change them before building.

| Function | What it does |
|---|---|
| Worker `upcomingVolumeAlerts(now?, onlyCompany?, send?)` (new, runs hourly with the existing alert) | For each company, estimates the emails each of the next 7 days will send and emails the platform owners about days over the threshold. |
| Worker `volumeAlerts` (exists) | Keeps warning about the last 24 hours (a "Send now" flood that was never scheduled ahead). **(proposed: keep both)** |

How "emails on a day" is estimated:

- Every scheduled reminder that sends by email, counting each occurrence that
  day (repeating ones by their rule, one-time ones by their send time).
- Each occurrence counts **one email per recipient as of now**: people in the
  departments, groups and company it targets (active ones only), plus typed
  outside addresses that haven't unsubscribed.
- "A day" is the company's own calendar day, in its time zone. **(proposed)**
- Slack is not counted (it isn't email). Paused, waiting for approval,
  cancelled, deleted and already-sent reminders are not counted.

| ID | Scenario | Expected | Source | Status |
|---|---|---|---|---|
| V1 | Threshold blank | No look-ahead alerts at all | Existing setting | PASS |
| V2 | A company has a one-time reminder in 3 days to more people than the threshold | Platform owners get one email naming the company, the day and the estimated count | PRD 6 | PASS |
| V3 | Several reminders on the same day add up to more than the threshold, though none does alone | Alerted (it's the day's total) | PRD 6 "a day has more than" | PASS |
| V4 | A daily repeating reminder whose single send is under the threshold, but two send on the same day (e.g. daily plus a one-time) | Counted per occurrence per day, so the total decides | | PASS |
| V5 | Exactly the threshold | Not alerted (must be more than) | PRD 6 | PASS |
| V6 | The busy day is 8 or more days away | Not alerted yet; it is once it comes within 7 days **(proposed window: 7 days)** | | PASS |
| V7 | The alert runs again the next hour, or the next day, for the same busy day | Not repeated: one alert per company per busy day **(proposed)** | No spam | PASS |
| V8 | A second busy day for the same company | Its own alert (it's a different day) | | PASS |
| V9 | Only Slack, or paused / waiting for approval / deleted reminders | Not counted | | PASS |
| V10 | Recipients: deactivated people and unsubscribed outside addresses | Not counted | Same rule as sending | PASS |
| V11 | Company suspended | Not counted (it sends nothing) | PRD 9.2 | PASS |
| V12 | Another company's volume | Never added to this company's count; each company alerted separately | Tenancy | PASS |
| V13 | The email | Lists each busy day with its estimate and the top 3 reminders by volume that day (title, recipients), with a link to the platform console | Actionable alert **(proposed)** | PASS |
| V14 | The past-24-hours alert | Still works as before | Keep both | PASS |

---

## 8. Profile photos (#11, PRD 3.3, 4)

PRD 3.3: "Users can edit their … profile picture (image only,
size-limited)". PRD 4: the directory shows an avatar. Today everyone gets
initials.

Rules marked **(proposed)** are mine; confirm or change them before building.

| Function | What it does |
|---|---|
| `setPhoto(actor, companyId, fileName, bytes)` (`src/lib/users.ts`) | Saves or replaces the signed-in person's own photo after checking it. Returns an error or `null`. |
| `removePhoto(actor, companyId, userId)` (`src/lib/users.ts`) | Removes a photo: your own, or someone else's if you may manage them (see A8; the `users.edit` check is in the server action). |
| `photoFile(companyId, userId)` / `photoUrls(companyId)` | The stored photo (same company only), and each person's photo URL. |
| `GET /api/avatar/<user id>` | Serves the photo to signed-in members of the same company. |
| `Avatar` (`src/components/avatar.tsx`) | Shows the photo when there is one, otherwise the initials as today. |

Storage follows the logo: one row per person in a new table, bytes only
through `src/lib/storage.ts`, checked with `checkFile`, audited without the
bytes, tenant RLS.

| ID | Scenario | Expected | Source | Status |
|---|---|---|---|---|
| A1 | Upload a PNG, JPEG, GIF or WebP up to 1 MB on Profile | Saved; shown on Profile, in the sidebar card and the top bar | PRD 3.3. **(proposed: 1 MB)**  PASS |
| A2 | A file over 1 MB; a PDF; an SVG; a text file renamed `.png` | Refused with a clear message; the old photo (or initials) stays | PRD 3.3 "image only, size-limited"; SVG can carry scripts  PASS |
| A3 | Upload a second photo | Replaces the first; one photo per person; the new one shows at once (no stale cache) |  PASS |
| A4 | Remove your photo | Initials again everywhere |  PASS |
| A5 | Where it shows | Everywhere initials show today: Team, a group's members, Discussion, the sidebar card, the top bar | PRD 4  Browser (Chrome 2026-10-20: sidebar, top bar and Team show it; Discussion and a group not looked at) |
| A6 | Someone from another company, or signed out, requests a photo URL | 404 / sign-in; never the image | Tenancy. **(proposed: not public, unlike the logo; emails don't show photos)**  Lib PASS (no cross-company photo); route in Chrome 2026-10-20: signed in 200 `image/png`, private cache; signed out → sign-in |
| A7 | A malformed or unknown user id in the URL | 404 |  Lib PASS (bad ids return nothing); route 404 not checked |
| A8 | Someone with `users.edit` removes a member's photo (e.g. an unsuitable picture) | Allowed; they can't upload one for them. Refused for someone above them | **(proposed)**, same "not above you" rule as rename  PASS |
| A9 | A plain member tries to remove someone else's photo | Refused |  Lib PASS (a member is refused for an admin); the `users.edit` check is in the action, not run |
| A10 | Deactivated person | Photo still shows (in Team, old comments) | Like their name  PASS |
| A11 | Erased person | Photo deleted, back to "Deleted person" initials; nothing left in storage | PRD 11.5  PASS |
| A12 | "Download my data" / admin export | Includes the photo (type, size, uploaded at, and the image as base64) | PRD 11.5. **(proposed: include the image itself)**  PASS |
| A13 | More than 30 uploads in an hour | Refused ("too many"), like other uploads | Rate limits (uploads)  Not tested (rate limit is in the server action) |
| A14 | Audit log | "Photo changed/removed" row for the person, with no image bytes in it | PRD 9.1, secrets/noise kept out  Browser (2026-10-20: create and delete rows as Maya Patel, no bytes; the label reads "image/png") |

## 9. More notification preferences (#11, PRD 7.5)

PRD 7.5: "Per-user preferences: which channels to use for which events."
Today only four events can be turned off (approvals, rejections,
mentions, escalations). Some others only show in Notifications, and one
sends email that can't be turned off.

Decided earlier (2026-10-07), unchanged: reminders and tasks sent to you
always arrive the way the sender chose, and in-app is always on.

| Function | What it does |
|---|---|
| `MUTABLE` (`src/lib/notifications.ts`) | The list of events and channels the preferences page offers. |
| `setMutes` / `getMutes` | Save and read a person's choices (no row = on). |
| `mutedFor(tx, userIds, event)` | Checked before every email or Slack DM for a listed event. |
| `planTell(tx, companyId, userIds, event, message)` / `sendTell(plan, send?, fetch?)` | Who gets the email and Slack DM for an event (active people of this company, by their choices); then sends them after the event's transaction. |

Proposed list (**new** marks what changes):

| Event | Who gets it | Email | Slack DM | Today |
|---|---|---|---|---|
| A reminder needs my approval | approvers | on | on | same |
| My reminder was approved | creator | **new, off** | **new, off** | in-app only |
| My reminder was rejected | creator | on | **new, on** | email only |
| Someone mentioned me | mentioned person | on | on | same |
| Someone commented on my reminder | creator | **new, off** | **new, off** | in-app only |
| Everyone finished my task | creator | **new, off** | **new, off** | in-app only |
| Some deliveries failed | creator, admins | **new, on** | **new, off** | in-app only |
| Daily email limit reached | admins | on (**now mutable**) | — | email, can't be turned off |
| Someone in my department is late on a task | managers | on | **new, on** | email only |
| A guest answered my event (added 2026-10-21 with events, 11 RS7) | organiser | **new, off** | **new, off** | — |

"off" means a new message nobody gets until they tick it, so turning
this on doesn't start emailing everyone. **(proposed defaults)** That needs
opt-in rows as well as today's opt-out ones.

| ID | Scenario | Expected | Source | Status |
|---|---|---|---|---|
| N1 | Preferences page | Lists every event above with its channels; ticks show the current choice, including the defaults | PRD 7.5  PASS (the list and defaults; the page ticks seen in Chrome match) |
| N2 | A person who never opened Preferences | Gets exactly what the defaults column says (no new email or DM from an event marked off) | No surprise emails  PASS |
| N3 | Tick "Someone commented on my reminder" by email; someone else comments | The creator gets one email linking to the comment; no email for their own comments | PRD 7.5  PASS |
| N4 | Same, Slack DM ticked, Slack connected | One DM; Slack not connected or no Slack account → no DM, nothing fails |  PASS |
| N5 | Untick "Some deliveries failed" by email | In-app only; the admins who left it on still get the email | PRD 7.5  PASS |
| N6 | Untick "Daily email limit reached" | That admin gets no email; still sees it in Notifications |  PASS |
| N7 | Any event, any choice | Always written to Notifications (in-app can't be turned off) | Decision 2026-10-07  PASS |
| N8 | Reminders and tasks sent to you, task follow-ups | Never on this page, never muted | Decision 2026-10-07  PASS |
| N9 | Saving the page with a made-up `event:channel` value | Ignored; the rest saves |  PASS |
| N10 | One person's choices | Never change anyone else's (same company or another) | Tenancy  PASS |
| N11 | "Everyone finished my task" ticked; the last assignee marks done, then undoes and redoes | One email, not two (same once-per-occurrence rule as the in-app one) |  PASS |
| N12 | "My reminder was approved" ticked | The creator gets the email when it's approved, by an approver's button or by an approver's edit |  PASS |

## #11 decisions

Approved as proposed on 2026-10-20 ("spec is fine"): 1 MB, photos private to
the company, admins may remove (not upload), the export includes the image,
and the defaults in the section 9 table. N12's "approver's edit" means an
edit that makes the reminder sendable without approval; an approver editing
it while it still needs approval changes nothing (tester's reading, matches
the code).

## 10. Calendar: views and working on entries (v2 step 1, PRD 14.1, 14.2)

Today: a month grid of **scheduled** sends in the viewer's time zone, series
expanded from their rule, only what the viewer can open (`canViewWhere`), up
to 500 reminders, read-only (an entry links to the reminder). Events (14.3),
and with them all-day and multi-day entries, come in step 2.

Rules marked **(proposed)** are mine; confirm or change them before building.
Everything works the same way it already does elsewhere unless a case says
otherwise: who may change a reminder (`mayChange`), approval (PRD 5.9),
deleted = hidden everywhere.

| Function | What it does |
|---|---|
| `calendarRange(companyId, viewer, timeZone, { from, to, layers, person? })` (replaces `calendarMonth`) | Entries between two local dates: each with reminder id, occurrence time, title, kind (reminder / task), state (scheduled / needs approval / sent), colour, and whether the viewer may change it. |
| `quickCreate(actor, companyId, { title, at, kind })` | A reminder or task to yourself at that time, by email. |
| `moveEntry(actor, companyId, reminderId, occursAt, newAt, scope)` | Drag to reschedule. `scope`: `one` / `following` / `all` (series only). |
| `deleteEntry(actor, companyId, reminderId, occursAt, scope)` | Delete from the calendar, with the same scopes. |
| `editOccurrence(…)` (generalises `detachOccurrence`) | "This one" for **any** future occurrence, not only the next. |
| `duplicateReminder(actor, companyId, reminderId, at)` | A copy at a new date and time. |
| `colour` (new reminder field) | One of the palette names, or none (the type's default). |

### Views and navigation (14.1)

| ID | Scenario | Expected | Source | Status |
|---|---|---|---|---|
| C1 | Open Calendar | Month view of the current month, as today. The view and date are in the URL (`?view=week&date=2026-10-20`), so reload, back and deep links work | PRD 14.1, 8  PASS (lib: view and date from the URL); Browser (reload, back, deep links) |
| C2 | Week, Day and "4 days" views | Columns per day over 24 hour rows labelled 12-hour ("9 AM"); each entry is a 30-minute block at its exact minute ("Daily standup 9:30 AM"), blocks at the same time side by side; a line marks now on today. Weeks start on Monday | PRD 14.1; Google layout, user's choice 2026-10-20. **(proposed: custom = 2–7 days)**  PASS (lib: ranges, 2–7 days); Browser (Chrome 2026-10-20: hour grid, blocks, now line) |
| C3 | Toolbar: Today, ‹ ›, search, and a view menu (Day / Week / Month / 4 days) | ‹ › move by one unit of the current view; Today goes to the current one; the menu switches view and closes | PRD 14.1  PASS (lib: steps); Browser (Chrome: toolbar, view menu) |
| C4 | Click a week's row in Month; click a day number | Opens that week in Week view; that day in Day view | PRD 14.1 drill down  PASS (lib); Browser (Chrome: week link and day numbers) |
| C5 | Left panel in every view: Create, mini month, "Meet with…" (a colleague), "My calendars" (the layers) | A mini-month date opens in the current view and is marked in the grid too (a shaded, ringed day, today included; on opening, today is the picked date); its arrows change only the mini month. Picking a colleague or ticking a layer applies at once (no Apply). The app sidebar is an icon rail on this page | PRD 14.1; Google layout, user's choice 2026-10-20  PASS (lib: today is the picked date); Browser (Chrome: mini month, colleague, layers apply at once) |
| C6 | What shows | Scheduled sends (series expanded, skipped ones left out), **sent** ones in the past (from what was actually sent, faded), and reminders **waiting for approval** (marked "Needs approval"). Not paused, cancelled, rejected or deleted ones | **(proposed: past sends and waiting ones are new)**  PASS |
| C7 | Times and days | In the viewer's time zone, as today; a reminder in another zone shows at the viewer's local time | Existing rule  PASS |
| C8 | Layers on/off: Created by me · Tasks assigned to me · My departments · Company-wide · Everything else I can see | Each hides or shows its entries; an entry in two layers shows once and hides only when all its layers are off. All on by default; the choice is in the URL. "Everything else" holds what fits no other layer (sent to you directly, or seen through "view all"), so every entry can be hidden. **Except** a colleague picked under "Meet with…": their entries stay visible whatever the ticks (decided 2026-10-20); clear the colleague to hide them | PRD 14.1. **(proposed: "Events I'm invited to" arrives in step 2.) "Everything else" added while building, 2026-10-20**  PASS |
| C9 | Search by title, tag or a person's name (creator or recipient) | Lists matching entries the viewer can see, next first; picking one opens its date in the current view | PRD 14.1  PASS (after the test used the calendar's soonest-first order) |
| C10 | A colleague's calendar: pick a person | Their entries (created by them or sent to them) are added, outlined, but **only those the viewer could already open**; a colleague's private reminder never shows | PRD 14.1, 5.4  PASS |
| C11 | More than fit in a day cell (Month) | "+N more" opens the rest in place, as today | Existing  Browser ("+N more") |
| C12 | A company with more than 500 scheduled reminders | The first 500 are shown with the existing note | Existing limit  PASS |
| C13 | A member without `reminders.create` or `view_all` | 404, as today | Existing  Browser (the page guard) |

### Quick create (14.2)

| ID | Scenario | Expected | Source | Status |
|---|---|---|---|---|
| Q1 | Click an empty time slot (Week/Day) or a day (Month) | A small box beside the slot: title (focused), date and time (prefilled from the slot: the lower half of an hour picks :30; Month uses 09:00), type Reminder / Task. The slots are for the mouse; the keyboard path is "+ Create" | PRD 14.2. **(proposed: 09:00 for a day click)**  Browser (Chrome 2026-10-20: slot click, :30, focus) |
| Q2 | Save | A one-time reminder to **yourself**, by email, scheduled (no approval: you're always in your own scope); it appears at once | PRD 14.2  PASS |
| Q3 | Type Task | Also a task assigned to you, due **1 hour after** it's sent | **(proposed: 1 hour)**  PASS |
| Q4 | Empty title; a time in the past; title over the usual limit | Refused with the form's usual messages; nothing created | Existing rules  PASS |
| Q5 | "More options" | Opens the full New reminder form with title, time and type filled in | PRD 14.2  Browser (Chrome: More options carried title, time, task, due) |
| Q6 | Esc or clicking outside | Closes the box; nothing created |  Browser (Chrome: Esc closes) |

### Peek card (14.2)

| ID | Scenario | Expected | Source | Status |
|---|---|---|---|---|
| K1 | Click an entry | A card with title, time, repeat summary, recipients (as the reminder page shows them to this viewer: a viewer without full access sees no recipient list), and Open | PRD 14.2, 5.4  PASS |
| K2 | Buttons on the card | Only what the viewer may do: Edit, Delete, Duplicate, Move to… (who may change it); Mark done / Undo (an assignee of a sent task occurrence) | Existing permissions  PASS |
| K3 | A sent (past) entry | On the card: Open, Duplicate, Mark done if it's yours; no Edit, Move or Delete of that occurrence (deleting the whole reminder from its own page still follows D1) | It already went out; clarified 2026-10-20  PASS (card rule; deleting the reminder itself still follows D1) |
| K4 | Keyboard | Entries are focusable; Enter opens the card; Esc closes it and focus returns to the entry | PRD 11.4  Browser (Chrome: Enter opens, Esc returns focus) |

### Move, edit and delete, including repeating entries (14.2)

| ID | Scenario | Expected | Source | Status |
|---|---|---|---|---|
| M1 | Drag a one-time scheduled reminder to another slot | It sends at the new time; recipients and approval unchanged | PRD 14.2  PASS |
| M2 | Drop on a past time | Refused, nothing changes |  PASS |
| M3 | Someone who may not change it drags it | Can't be dragged; a direct call is refused ("not found") | Existing `mayChange`  PASS |
| M4 | "Move to…" on the card (no mouse) | Same as dragging: pick date and time | PRD 11.4  PASS |
| M5 | Drag one occurrence of a series | Asks **This one / This and following / All**; Esc cancels and nothing moves | PRD 14.2  Browser (Chrome: drag, the which-dates question, Esc) |
| M6 | This one | That occurrence becomes its own one-time reminder at the new time (as "only the next one" works today); the series skips that date. A move never changes recipients, so the copy keeps the series' status and approval, whoever moves it (editing through the form still follows T8) | PRD 14.2, existing #7; decided 2026-10-20  PASS (after the fix: a move keeps the series' status) |
| M7 | This and following | The series ends before that occurrence; a new series starts from it at the new time with the same rule, content, recipients, files and sharing, and everyone's own colour for it. Its approval carries over (same recipients) | PRD 14.2  PASS (after the fix: everyone's colour carries) |
| M8 | All | The whole series shifts by the same amount (e.g. every Monday 09:00 → every Tuesday 10:00); occurrences already sent stay as they were | PRD 14.2. **(proposed: weekday and day-of-month rules shift with it)**  PASS |
| M9 | This one / following / all on an occurrence that isn't the next one | Works for any future occurrence (today only the next) | PRD 14.2  PASS |
| M10 | Waiting for approval | Can be moved (one-time) or moved as All (series); still waiting. "This one" and "following" aren't offered until it's approved | Nothing to split yet (as T5)  PASS |
| M11 | Edit from the card on a series | Same three choices; This one / following open the full form for that part | PRD 14.2  Not tested in the browser (lib paths tested) |
| M12 | Delete from the card on a series | This one = skip that date; This and following = the series ends before it; All = delete the reminder (hidden everywhere, as #5) | PRD 14.2, 5.6  PASS |
| M13 | Moving or editing so that recipients widen | Not possible from a drag (recipients don't change); from the form, the usual approval rule | PRD 5.9  PASS |
| M14 | Audit log | Each move, split or delete is logged as the person who did it | PRD 9.1  Browser (Chrome 2026-10-20: a move logged as Maya Patel with old and new send time) |

### Duplicate (14.2)

| ID | Scenario | Expected | Source | Status |
|---|---|---|---|---|
| U1 | Duplicate an entry to a date and time | A new one-time reminder: same title, description, links, tags, recipients, channels, files, sharing, task settings (not anyone's colour: colours are personal) | PRD 14.2. **(proposed: always one-time; repeat can be set in the full form)**  PASS |
| U2 | Who it belongs to | The person who duplicated it; approval is checked as them, so copying an admin's company-wide reminder as a member needs approval | Scope rules (PRD 5.2)  PASS |
| U3 | Comments, delivery history, task completion | Not copied |  PASS |
| U4 | Duplicate something you can only view | Allowed if you can create reminders (you saw its content anyway) | **(proposed)**  PASS |

### Colours (14.2)

| ID | Scenario | Expected | Source | Status |
|---|---|---|---|---|
| L1 | The palette | 11 named colours, each readable in light and dark themes (text ≥ 4.5:1 on its fill, checked) | PRD 14.2  PASS (lib: names); contrast checked by script, worst 6.06:1 |
| L2 | Pick a colour on the peek card | Saved **for me only** (like Google Calendar); every occurrence shows it on my calendar; nobody else's view changes; "Reset" goes back to the default | PRD 14.2; user's decision 2026-10-20 (personal colours)  PASS |
| L3 | No colour picked | Reminders and tasks each have a default colour | PRD 14.2  PASS |
| L4 | Who may pick it | Anyone who can open the reminder, for themselves; someone who can't open it is refused | User's decision 2026-10-20  PASS |
| L5 | Other screens | Only calendar entries are coloured; day cells, lists and emails stay as they are | PRD 14.2  Browser (only calendar entries are coloured) |

### Notes from building (2026-10-20)

- **M7:** the new series from "this and following" has its own id. Comments
  and history stay on the original, as with M6's copy.
- **M6–M8:** skips already recorded, and dates waiting copies replace, move
  with the series. Otherwise a date moved with "this one" would also send
  from the series.
- **M11:** "Edit → This and following" splits at that date first (nothing
  moves), then opens the new part's form. Leaving the form without saving
  keeps the split, which sends the same as before.
- **M3/M4:** the slots to drop on exist only for people who can create
  reminders. Someone who can only edit uses "Move to…".

### Not in this step

Events, RSVP and the all-day strip (step 2), the calendar feed (14.4),
remind-before and sub-tasks (step 3). Drag and the popovers need client
JavaScript, a first for a whole page here; every action also works without
a mouse (K4, M4).

### Found while building

- **Upcoming tasks assigned to me don't show** (C8): a recipient can open a
  reminder only once it has been sent to them (PRD 5.4 as built: "sent to
  you" means a delivery exists). So "Tasks assigned to me" holds tasks
  already sent, and ones you created or can see for another reason.
  Showing upcoming ones means letting recipients open a reminder before
  it's sent (content visible early, even while waiting for approval).
  **Open question for the user.**

### Open questions for the calendar (answered: "spec is fine", 2026-10-20)

1. **C6:** show past sends and reminders waiting for approval, or only
   what's scheduled (as today)?
2. **Q3:** a quick task is due 1 hour after it's sent?
3. **M8:** dragging a series as "All" to another day shifts its weekdays
   (every Monday → every Tuesday)? Or allow "All" to change only the time?
4. **U1/U4:** duplicates are one-time, and anyone who can create reminders
   may duplicate what they can see?
5. **C2:** custom range of 2–7 days enough?

## 11. Events: meetings with an end time and replies (v2 step 2, PRD 14.3)

Decided 2026-10-20: an event is a **third kind** next to reminder and task,
on the same reminders model (recipients, approval, calendar, colours, drag,
comments, files, edit and delete all apply). What a reminder is for: telling
people something at a moment. A task: asking them to do something. An
**event: asking them to be somewhere** for a length of time.

Rules marked **(proposed)** are mine; confirm or change them before building.
Anything not mentioned works as it does for reminders.

| Function | What it does |
|---|---|
| Reminder input, kind `event` | Adds start and end (or all-day / several days), location, meeting link, and "notify before" times. |
| `respond(viewer, companyId, eventId, answer)` | A guest's Yes / No / Maybe; can be changed any time before the event ends. |
| `eventResponses(companyId, eventId)` | Who said what, and who hasn't answered, for the organiser. |
| Worker: invites, "starts soon", update and cancel notices | Sent through `deliveries` like reminder emails: exactly once, with retries. |
| `.ics` for an event | A calendar file (method REQUEST, or CANCEL), attached to invites and updates. |

### The event itself

| ID | Scenario | Expected | Source | Status |
|---|---|---|---|---|
| EV1 | Create an event: title, start and end, guests | Saved; shows as "Event" | PRD 14.3 | |
| EV2 | End before or at the start; start in the past | Refused | | |
| EV3 | All-day, one day or several days (12–14 Nov) | Saved as dates, no times; shown for the whole day(s) | PRD 14.3 | |
| EV4 | Location (free text) and a meeting link | The link must be http(s); any service (Meet, Zoom, Teams…); shown as "Join" | PRD 14.3: pasted, not generated | |
| EV5 | Repeating event (every Monday 10:00–10:30) | Same repeat rules as reminders (5.5); each date keeps the same length | PRD 14.3 | |
| EV6 | Guests | Picked like recipients: people, groups, departments, the whole company. **Members only**: no typed outside emails, no Slack channels as guests | PRD 14.3 "Company members only" | |
| EV7 | Guests outside the organiser's scope | Needs approval first, as for reminders (5.9); nothing is sent until approved | PRD 14.3, 5.9 | |
| EV8 | The organiser | The creator; counts as "Yes" and gets no invite (but does get the "starts soon" notices, SN1) | **(proposed)** | |
| EV9 | An event can't also be a task | The form offers Reminder / Task / Event, one of them | **(proposed)** | |
| EV10 | Files and description | As for reminders; files go with the invite | PRD 14.3 | |

### Invites

| ID | Scenario | Expected | Source | Status |
|---|---|---|---|---|
| IN1 | An event is scheduled (created in scope, or approved) | Each guest gets an invite **at once**, not at the start time: email with title, when, where, the Join link, Yes / No / Maybe links and an `.ics` file; and/or a Slack DM with Yes / No / Maybe buttons, following the event's channels | PRD 14.3 | PASS |
| IN2 | Each guest | One invite each, exactly once (even with retries), addressed only to them | PRD 6, 7.1 | PASS |
| IN3 | The `.ics` | Opens in Google Calendar, Outlook and Apple Calendar with the right time (UTC inside), title, place and link | PRD 14.3 | PASS in code (UTC times, title, place, link); importing into Google, Outlook and Apple is a browser check |
| IN4 | A repeating event | One invite for the series (the `.ics` repeats), not one per date | **(proposed)** | PASS |
| IN5 | Waiting for approval, or rejected | No invites | PRD 5.9 | PASS |
| IN6 | Someone joins a guest department or group later | They get an invite when they join, if the event is still to come | PRD 5.2 (current membership). **(proposed)** | PASS |

### Replies (RSVP)

| ID | Scenario | Expected | Source | Status |
|---|---|---|---|---|
| RS1 | A guest answers Yes / No / Maybe (email link, Slack button, the event's page or the calendar card) | Saved; they can change it until the event ends | PRD 14.3 | PASS |
| RS2 | The email links | Signed per guest and event (like unsubscribe links), so they work without signing in but can't be used for someone else; a click asks to confirm (mail scanners open links) | **(proposed)** | PASS |
| RS3 | Someone who isn't a guest tries to answer | Refused | | PASS |
| RS4 | The organiser opens the event | Counts and names: Yes, No, Maybe, no answer yet | PRD 14.3 | PASS |
| RS5 | A guest opens the event | Sees their own answer and the totals, not who said what | **(proposed)** | PASS at access level; how the page looks to a guest is a browser check |
| RS6 | Repeating event | One answer for the whole series | **(proposed: answering one date only comes later)** | PASS |
| RS7 | The organiser hears about answers | In the app, one notification per answer (mutable by email), not per date | PRD 7.5. **(proposed)** | PASS (a changed answer is a new notification; email and Slack start off) |

### "Starts soon" notices

| ID | Scenario | Expected | Source | Status |
|---|---|---|---|---|
| SN1 | 10 minutes before the start, by default | Each guest who hasn't said No, **and the organiser** (decided 2026-10-21), gets "Starts in 10 minutes" with the Join link, over the event's channels | PRD 14.3 | PASS (the form ticks 10 minutes by default: a browser check) |
| SN2 | The organiser changes it or adds more (e.g. 1 day and 10 minutes) | Each one sent once per date, in time order | PRD 14.3 | PASS |
| SN3 | "None" | No notices before | **(proposed)** | PASS |
| SN4 | Repeating event | Before every date | PRD 14.3 | PASS |
| SN5 | An all-day event | The notice goes at 09:00 company time that day, minus the chosen time **(proposed)** | | PASS |
| SN6 | The event was skipped, cancelled or deleted, or the guest said No | Nothing | | PASS after a fix: a notice already queued is checked again before it goes (first run FAIL, decided a product bug 2026-10-21) |

### Changes and cancelling

| ID | Scenario | Expected | Source | Status |
|---|---|---|---|---|
| UP1 | Time, place or link changes (form, drag or "Move to…") | Every guest gets "Updated" with what changed and a new `.ics` (same event, next version); answers stay | PRD 14.3 | PASS (the .ics content; Google / Outlook / Apple applying it is a manual check) |
| UP2 | Only the description, files or colour change | No update notice | **(proposed)** | PASS |
| UP3 | A guest is added | They get the invite | | PASS |
| UP4 | A guest is removed | They get "You're no longer invited" with a cancelling `.ics` | **(proposed)** | PASS |
| UP5 | Cancelled or deleted | Every guest gets "Cancelled" with a cancelling `.ics`; it leaves calendars (ours and, via the `.ics`, theirs) | PRD 14.3 | PASS |
| UP6 | One date of a repeating event moved or deleted (this one / following / all) | Guests are told about that date (or the rest); the `.ics` update covers it | PRD 14.2, 14.3 | PASS |
| UP7 | A change that widens the guests beyond what was approved | Needs approval again. Until it's approved nothing is sent (no update, cancel or invite), so guests' own calendars keep the old event; inside NotifyHub they see the change marked "Needs approval" (reworded 2026-10-21 after the spec test: the user chose this over keeping a pending revision) | PRD 5.9 | PASS after rewording (first run FAIL: the NotifyHub calendar showed the pending change; decided the spec was wrong) |

### Calendar and visibility

| ID | Scenario | Expected | Source | Status |
|---|---|---|---|---|
| CL1 | Week / Day view | An event is a block from start to end (not 30 minutes); several at once sit side by side | PRD 14.1 | |
| CL2 | All-day and several-day events | In a strip above the hours (Week / Day); across the days in Month view | PRD 14.1 | |
| CL3 | Layer "Events I'm invited to" | Shows events where I'm a guest; the organiser's own are in "Created by me" | PRD 14.1 | |
| CL4 | Peek card | Adds where, Join, my answer with Yes / No / Maybe buttons (guests), totals (organiser) | PRD 14.2 | |
| CL5 | Quick create, type Event | One hour long by default, guest: just me (I can add people in More options) | **(proposed)** | |
| CL6 | Drag an event | Moves it and keeps its length (no resizing by dragging) | **(proposed)** | |
| VS1 | A guest can open the event | As soon as it's scheduled (not while waiting for approval), before anything is sent; also in search and their calendar | Decided 2026-10-20 (guests must see it to answer) | |
| VS2 | Upcoming tasks for their assignees | The same rule: an assignee can open a scheduled task before it's sent, so "Tasks assigned to me" shows upcoming ones | Follows from VS1. **(proposed)** | |
| VS3 | Someone who isn't a guest, creator, admin or manager of the organiser | Can't open it (unless shared, as today) | PRD 5.4 | |

### Rules carried over

| ID | Scenario | Expected | Source | Status |
|---|---|---|---|---|
| RC1 | Invites, updates and "starts soon" | Never mutable (like reminders); answers to the organiser are | Decided 2026-10-07 | |
| RC2 | Daily email limit, suspended company | Invites and notices count and wait like reminder emails | PRD 7.1, 9.2 | PASS (notices) |
| RC3 | Erase / export a person | Their answers are in the export and removed on erase | PRD 11.5 | PASS (answers) |
| RC4 | Audit log | Creating, changing and answering are logged | PRD 9.1 | PASS (answers) |

### Not in this step

The calendar feed (14.4), answering one date of a repeating event, resizing
by dragging, rooms or resource booking, and outside (non-member) guests.

### Open questions for events

1. **EV8:** the organiser counts as "Yes" and gets no invite?
2. **IN4 / RS6:** one invite and one answer for a whole repeating event?
3. **RS2:** reply links in the email work without signing in (signed, with a
   confirm click)?
4. **UP2 / UP4:** no notice for description-only changes; removed guests get
   a cancellation?
5. **VS2:** upcoming tasks visible to their assignees too, by the same rule?
6. **SN5:** "starts soon" for an all-day event counts back from 09:00?

## 12. Finding events: an Events page (v2, PRD 14.3)

Decided 2026-10-21: events get their own sidebar item. Today a guest finds an
event only through the invite, the calendar layer or the event's page; a
member without `reminders.create` doesn't even see Calendar or Reminders.

| Function | What it does |
|---|---|
| `myEvents(companyId, viewer, { past, page })` | Events I organise or am invited to: upcoming (and running) or past, with my answer and the Yes / Maybe / No totals. |
| Invite notification | An in-app notification when an invite is created for me. |

### The Events page

| ID | Scenario | Expected | Source | Status |
|---|---|---|---|---|
| EP1 | The sidebar | "Events" for every signed-in member (like Tasks), whatever their permissions | Decided 2026-10-21 | PASS in code (a member with no permissions gets their invitations); the sidebar item seen in Chrome |
| EP2 | Upcoming tab (default) | Events I **organise** or am a **guest** of that haven't ended, soonest first. A series is one row showing its next date and how it repeats | **(proposed)** | PASS |
| EP3 | Past tab | Ended events, latest first, 25 per page | **(proposed)** | PASS |
| EP4 | A row | Title (opens the event), when, where, organiser, my answer, and the Going totals (organiser counted as Yes) | Decided 2026-10-21 | PASS in code; the row layout seen in Chrome |
| EP5 | My answer, as a guest of an upcoming event | Yes / Maybe / No buttons in the row, the current one filled; same rules as RS1 / RS3; the page stays on the same tab | Decided 2026-10-21 | PASS in code; buttons in the row seen in Chrome |
| EP6 | My answer, as the organiser | "Organiser" instead of buttons | EV8 | PASS in code; "Organiser" seen in Chrome |
| EP7 | My own event waiting for approval or rejected | Listed for me with a "Needs approval" / "Not approved" badge; guests don't see it (VS1) | **(proposed)** | PASS in code; badge wording is a browser check |
| EP8 | Cancelled or deleted | Not listed | | PASS |
| EP9 | Admins and managers | See only their own and their invitations here, not every event they could open (that's Reminders and Calendar) | **(proposed)** | PASS |

### Elsewhere

| ID | Scenario | Expected | Source | Status |
|---|---|---|---|---|
| EN1 | An invite is created for me (IN1, IN6) | An in-app notification "Olga invited you to Planning", once per event, linking to it; always on (in-app isn't mutable) | Decided 2026-10-21 | PASS |
| EN2 | Home | "Upcoming events": my next 5 (organiser or guest), with my answer; "All events" goes to the Events page | Decided 2026-10-21 | PASS in code; the Home section seen in Chrome |
| EN3 | Reminders list, Type filter | Gains "Event"; "Reminder" no longer includes events | Decided 2026-10-21 | PASS |
| EN4 | The event's page | Its buttons say "Edit event", "Cancel event", "Delete event" (and "series" for a repeating one) | Decided 2026-10-21 | "Edit event" and "Cancel event" checked in the rendered page; "Delete event" is a browser check |

### Not in this step

Change and cancel notices (slice 4), and a "who's coming" export.

### Open questions for the Events page

1. **EP2:** "upcoming" includes an event that has started but not ended (shown as "Now")?
2. **EP7:** your own waiting or rejected events listed here, with a badge?
3. **EP9:** admins see only their own and their invitations, not everyone's events?

## 13. Connect Google Calendar (v2, replaces the PRD 14.4 link feed)

Decided 2026-10-21: instead of a calendar link to paste, each person clicks
**Connect Google Calendar** once. NotifyHub then keeps a calendar called
"NotifyHub" in their Google account up to date: their reminders, tasks and
events, changed within a minute of a change in NotifyHub. One way only:
NotifyHub never reads their other Google calendars or events, and edits made
in Google aren't brought back. (Two-way sync and Outlook / Apple are not in
this step.)

| Function | What it does |
|---|---|
| Profile → Connect Google Calendar | Google's consent screen for one narrow permission (`calendar.app.created`: make its own calendars and manage only their events); offline access, so it keeps working when signed out. |
| `syncGoogle` (worker) | After a change, writes the person's affected entries into their "NotifyHub" calendar: create, update or delete, by a stable id per entry. |
| Disconnect | Stops syncing, deletes the "NotifyHub" calendar from their Google account, and forgets the tokens. |
| Company setting "Google Calendar" | Admins (company.edit) allow or block connecting for the company. |

### Connecting

| ID | Scenario | Expected | Source | Status |
|---|---|---|---|---|
| GC1 | Profile → Connect Google Calendar | Google's consent screen asks only for "make secondary calendars and manage their events"; on Allow, back on Profile with "Connected as name@gmail.com" and a "NotifyHub" calendar appears in Google | Decided 2026-10-21 | PASS (code); Browser (2026-10-22, real Google: consent screen, Connected as, NotifyHub calendar) |
| GC2 | Any Google account | It needn't match the NotifyHub email or the sign-in method (password, or Google sign-in) | **(proposed)** | PASS |
| GC3 | Deny on Google's screen, or it fails | Back on Profile with a message; nothing stored | | PASS in code; the Deny screen and message are a browser check |
| GC4 | The tokens | Stored encrypted (like the Slack token); never logged or shown | AGENTS (integration secrets) | PASS |
| GC5 | Disconnect | Syncing stops, the "NotifyHub" calendar is deleted from Google, the tokens are deleted | **(proposed: delete the calendar)** | PASS |
| GC6 | Access revoked from Google's side (or the password changed) | Syncing stops; Profile says "Reconnect"; one in-app notification | **(proposed)** | PASS (code); Browser (2026-10-22, real Google: access removed, Reconnect shown) |
| GC7 | Admin blocks it for the company | Connect is hidden; existing connections stop syncing and their calendars are deleted | **(proposed)** | PASS (code); Browser (2026-10-22, real Google: calendar removed, Connect hidden) |
| GC8 | Deactivated or erased person | Syncing stops; erasing deletes the tokens and (best effort) the calendar | PRD 11.5 | PASS |

### What's synced

| ID | Scenario | Expected | Source | Status |
|---|---|---|---|---|
| GC9 | Which entries | Reminders, tasks and events **I created or that are addressed to me**: not everything an admin could open. As in the app, a plain reminder addressed to me appears **once it's sent** (tasks and events addressed to me appear ahead) (reworded 2026-10-22 after the spec test) | PRD 14.4 "they receive or created" | PASS after rewording (first run FAIL: plain reminders to me appear once sent; decided the spec was wrong) |
| GC10 | Which states | Scheduled (and paused series) and sent; not waiting for approval, rejected, cancelled or deleted | **(proposed)** | PASS |
| GC11 | How far | From 30 days ago to a year ahead; the first sync fills that range | **(proposed)** | PASS |
| GC12 | A reminder or task | At its send time, 30 minutes long (as on the NotifyHub calendar); title, description and a link back; no recipient list | **(proposed)** | PASS |
| GC13 | An event | Its real start and end (or all day), place and meeting link | Decided 2026-10-21 | PASS |
| GC14 | A repeating one | One recurring entry with its repeat rule, minus skipped and moved dates | | PASS |
| GC15 | An event I said No to | Removed from my Google calendar; back if I change my answer | **(proposed)** | PASS |
| GC16 | A change in NotifyHub (edit, drag, cancel, delete, a new reminder to me, joining a department) | My Google calendar reflects it within about a minute; once per change, with retries if Google is down | Decided 2026-10-21 | PASS |
| GC17 | I edit or delete the entry in Google | Not brought back; the next change in NotifyHub overwrites it (a note in the event's description says so) | **(proposed)** | PASS |
| GC18 | Event invites | Still sent as now; someone connected may see an event both from the invite (in their main calendar) and in "NotifyHub" | **(proposed: accept the duplicate)** | PASS |

### Before it can go to customers

Google must verify the app for this permission (if Google lists it as
sensitive), which can take weeks. Until then up to 100 test users added in
Google Cloud Console can connect: enough for HR. DEPLOYMENT.md gets the steps.

### Open questions for Google Calendar

1. **GC2:** connect any Google account, not only one matching the NotifyHub email?
2. **GC5 / GC7:** disconnecting (or an admin blocking it) deletes the "NotifyHub" calendar from Google?
3. **GC10 / GC15:** leave out what's waiting for approval, and events I said No to?
4. **GC11:** 30 days back, a year ahead?
5. **GC18:** accept that an invited, connected person may see an event twice (invite + NotifyHub calendar)? The alternative is to stop sending `.ics` files to connected people, which changes slice 2.

## 14. Tasks: remind before due, sub-tasks, chains, cover image (v2, PRD 14.5)

Four additions to tasks (the fifth in PRD 14.5, "Follow-up" wording, was dropped 2026-10-22: follow-ups keep saying "Overdue"). Today a task has a due time (`due_after_minutes`
after it's sent), each assignee marks it done, and anyone not done gets a
daily follow-up from the company's follow-up time ("Overdue: …") until they
are. All of that stays; these build on it.

Rules marked **(proposed)** are mine; confirm or change them before building.
Anything not mentioned works as it does for tasks today.

Build order, smallest first: remind before due, cover image, sub-tasks,
chains. Open questions answered 2026-10-22 (see the end of the section).

| Function | What it does |
|---|---|
| Task input: "Remind before due" | One or more times before the due time, picked from a list. |
| Worker: "due soon" reminders | Sent through `deliveries` (exactly once, with retries) to each assignee not done yet. |
| Task input: cover image | One image per task or sub-task, checked like attachments, shown as a banner on its page. |
| Task input: sub-tasks | Child tasks inside a task, each with its own title, assignees, due time and cover image. |
| Reminder / task input: "Start when … is done" | Holds this reminder or task until another task is done, then sends it. |

### Remind before due

| ID | Scenario | Expected | Source | Status |
|---|---|---|---|---|
| RB1 | Pick one or more: 1 hour, 1 day, 2 days, 1 week before due, or **Custom** (a number of minutes, hours or days) | Saved with the task; the task page lists them. **1 day is ticked by default** when the due time is more than a day after sending; otherwise none | PRD 14.5; user's decision 2026-10-22 (customisable, default 1 day) | PASS (form: presets, Custom, none); the default tick and the task page's list are a browser check |
| RB2 | The time comes | Each assignee who hasn't marked it done gets "Due in 1 day: <title>" with the due time and Mark done, over the task's channels (email, Slack DM with Mark done) and in the app | PRD 14.5 | PASS after fixes (first run FAIL: the Slack text repeated the due time, and the email link said "Open the task", not Mark done; both fixed as product bugs) |
| RB3 | Someone already marked it done, or the task was cancelled, deleted or skipped | Nothing for them (checked again just before sending, as for "starts soon") | PRD 14.5 | PASS |
| RB4 | Several picked (1 week and 1 day) | Each sent once per assignee per date, in time order; a late worker sends only the nearest one still due, never "1 week" a day before | PRD 14.5; as SN2 | PASS after a fix (first run FAIL: the 1-week reminder said "Due in 7 days") |
| RB5 | A "before" time that falls at or before sending (due 2 hours after sending, "1 day before"), a custom time of 0, or more than 5 times | Refused in the form: "Remind before due must be less than the time between sending and due". **Except** "1 day" ticked alone (the default) on a task due within a day: dropped silently, so the default never blocks a save | User's decision 2026-10-23 (drop the default, option a) | PASS (first run FAIL; decided the spec was wrong) |
| RB6 | Repeating task | Before the due time of every date | PRD 14.5 | PASS |
| RB7 | Editing a repeating task (this one / following / all) | The remind-before list carries over unless changed | PRD 14.5 "they survive recurring edits" | PASS; the edit form pre-filling the times is a browser check |
| RB8 | A task sent only to outside email addresses | They get it too, until the creator marks the date done (the single "done", section 6) | **(proposed)** | PASS |
| RB9 | Mute in Preferences | Can't be muted, like the task itself | AGENTS (tasks are never mutable) | PASS |

### Cover image

| ID | Scenario | Expected | Source | Status |
|---|---|---|---|---|
| CV1 | Add a cover image to a task or sub-task | PNG, JPEG, GIF or WebP up to 5 MB, content-checked like attachments (not by name or browser type); anything else refused | PRD 14.5 "same checks as 5.7"; 5 MB: user's decision 2026-10-23 || PASS (tasks; sub-tasks not built yet) |
| CV2 | Its page | Shown as a banner across the top | PRD 14.5 || PASS (URL); the banner itself is a browser check |
| CV3 | Who sees it | Whoever can open the task; the image's link checks that too (no public URL) | PRD 5.7 || PASS (access rule and company isolation); the route signed in as another member is a browser check |
| CV4 | Replace or remove it | The old file is deleted | || PASS |
| CV5 | Emails, Slack, calendar, Google | No image: only the task page shows it | User's decision 2026-10-22 || PASS (email, Slack, in-app calendar, notifications, Google) |
| CV6 | Only on tasks and sub-tasks | Reminders and events have no cover option | PRD 14.5 || PASS; saving a task as a reminder or event drops its cover (decided while building); the form showing the field only for tasks is a browser check |

### Sub-tasks

| ID | Scenario | Expected | Source | Status |
|---|---|---|---|---|
| ST1 | Add sub-tasks to a task (e.g. Onboarding → "Laptop", "Accounts", "Intro call") | Each has its own title, assignees, due time and optional cover image; they're created, edited and saved with the parent. A sub-task with no assignees picked goes to the task's own recipients. Clearing a sub-task's title in the edit form removes it. A sub-task can't be edited, moved, cancelled, deleted, sent now or approved on its own: only through its task | PRD 14.5; defaults, removal and "only through its task" decided while building 2026-10-23 || PASS |
| ST2 | Sending | Each sub-task goes out at the parent's send time (also after a move or Send now of the parent), to its own assignees, as a task ("Task: Laptop (Onboarding)"). Each has its **own due time** (ST3). The parent itself sends nothing to anyone. A sub-task that should only start after another is done uses a chain (CH12) | User's decision 2026-10-22; "parent sends nothing" decided while building 2026-10-23 || PASS |
| ST3 | Sub-task due time | Its own; must be after the parent is sent and no later than the parent's due time | User's decision 2026-10-22 || PASS |
| ST4 | Done | A sub-task is done when all its assignees mark it done (as tasks today), or, sent only outside, when the creator marks it done. The parent has no Mark done of its own: it's done only when every sub-task is done, and stops being done if someone un-marks one | PRD 14.5; confirmed 2026-10-22 || PASS |
| ST5 | The parent's page | Lists its sub-tasks with "2 of 3 done" and each one's people; a sub-task's page links back to the parent | Confirmed 2026-10-23 || PASS (library); the page wording and the link back are a browser check |
| ST6 | Follow-ups and remind before due | Per sub-task, to its own assignees who aren't done. Each sub-task uses the task's remind-before times that fall after it's sent (a 2-hour sub-task drops "1 day") | Confirmed 2026-10-23; the times decided while building || PASS |
| ST7 | The creator is told | Once, when the last sub-task is done ("Everyone has marked it done"), not per sub-task | Confirmed 2026-10-23; as tasks today || PASS |
| ST8 | Approval | Parent and sub-tasks are approved together: if any sub-task's assignees are out of the creator's scope, the whole task needs approval and nothing is sent until it's approved | PRD 5.9 || PASS |
| ST9 | Who sees what | Each assignee sees their sub-task and the parent's title and progress ("2 of 3 sub-tasks done"); the creator and those who oversee it see all. Someone who can only view the parent (its own recipients) sees the count, not the list | Confirmed 2026-10-23 || PASS (access rules); what each page shows is a browser check |
| ST10 | Only one level, only one-time tasks | A sub-task can't have sub-tasks; a repeating task can't have sub-tasks | User's decision 2026-10-22 || PASS |
| ST11 | Cancel or delete the parent | Its sub-tasks go with it (no more follow-ups) | || PASS (cancel before sending, delete after); a sent task can't be cancelled, only deleted, as today |
| ST12 | Calendar, Tasks page, Google | Sub-tasks show like tasks, titled "Laptop (Onboarding)"; the parent shows once | Confirmed 2026-10-23 || PASS |

### Chains: start when a task is done

| ID | Scenario | Expected | Source | Status |
|---|---|---|---|---|
| CH1 | Create a reminder or task B with "Start when <task A> is done" instead of a send time | Saved as "Waiting"; nothing is sent. It can't repeat or be an event, and a waiting task can't have sub-tasks. A task's due time is given as "due N hours/days after it starts". Send now sends it at once without waiting | PRD 14.5; the limits and Send now decided while building 2026-10-23 || PASS |
| CH2 | A is done | B is sent at once (B's due time counts from then, e.g. "due 2 days after it starts") | PRD 14.5 || PASS |
| CH3 | A has several assignees | B starts when **all** of them are done (A is done) | PRD 14.5; user's decision 2026-10-22 || PASS |
| CH4 | A was sent only outside (no assignees) | B starts when the creator marks A done (the single "done") | || PASS |
| CH5 | Someone un-marks A after B started | B stays sent | Proposed; built as written on the user's "continue" 2026-10-23 || PASS |
| CH6 | Steps in a row: A → B → C | Each starts when the one before is done | PRD 14.5 "step-by-step workflows" || PASS |
| CH7 | Which tasks A can be | Only one-time tasks I can see, not yet done, not cancelled or rejected; B can't start itself or form a loop | Proposed; built as written on the user's "continue" 2026-10-23 || PASS |
| CH8 | A is cancelled or deleted | B is cancelled too, and B's creator is told in the app | User's decision 2026-10-22 || PASS |
| CH9 | Approval | B is approved (if it needs it) when it's created, not when it starts. If B is still waiting for approval when A is done, it's sent once approved | PRD 5.9 || PASS |
| CH10 | B's page and the list | "Starts when <A> is done" with a link to A; A's page says "Then: <B>" (only what the viewer can open) and has "Add a next step", which opens a new task already waiting for A | Proposed; built as written on the user's "continue" 2026-10-23 || PASS (library); the page and list wording, the link to A and "Add a next step" are a browser check |
| CH11 | B in the calendar and Google before it starts | Not shown (it has no date yet) | Proposed; built as written on the user's "continue" 2026-10-23 || PASS after a fix (first run FAIL: the calendar still showed B on the placeholder date in 9999; product bug, fixed) |
| CH12 | A sub-task as A | Allowed: B starts when that sub-task is done | Proposed; built as written on the user's "continue" 2026-10-23 || PASS |

### Not in this step

Templates for chains (an "onboarding" workflow to reuse), repeating chains,
sub-tasks of sub-tasks, a chain that waits for several tasks, and cover
images on reminders or events.

### Open questions for tasks (answered 2026-10-22)

1. Follow-up wording: **keep "Overdue"** everywhere; the PRD 14.5 wording change is dropped.
2. **RB1:** presets plus Custom; 1 day ticked by default when it fits.
3. **CV5:** the cover image only on the task's page. CV1: 5 MB, confirmed 2026-10-23.
4. **ST3 / ST10:** as proposed.
5. **ST2 / ST4:** each sub-task has its own due time and is sent with the parent; the parent is done only when all sub-tasks are.
6. **CH3:** B starts when everyone has done A.
7. **CH8:** cancelling A cancels B.

## Open questions found while testing

- ~~**T7a/T7c:** when the copy needs approval, the series still skips that date
  straight away.~~ Decided 2026-10-19, option (b): the series skips that date
  only once the copy is approved (T11–T14).

## Not covered here

- Screens: layout, buttons hiding when not allowed. Checked in the browser.
- The rest of the app (reminders, approvals, Slack, digests, …) has its own
  tests from earlier steps but no spec file yet.
