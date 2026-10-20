# Expected behaviour: v1 gap items #4, #5, #7, #8, #9, #11

What each feature should do, written from the PRD and the product owner's
decisions, **not** from the code. Behaviour tests are written from this file,
one test per case id (test names start with the id, e.g. `D3: …`), so a
failing test means either the code or this file is wrong, and we decide which.

Status column: results of the spec tests, 2026-10-19 (sections 1–7) and
2026-10-20 (8–9). The tests are
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

## Open questions found while testing

- ~~**T7a/T7c:** when the copy needs approval, the series still skips that date
  straight away.~~ Decided 2026-10-19, option (b): the series skips that date
  only once the copy is approved (T11–T14).

## Not covered here

- Screens: layout, buttons hiding when not allowed. Checked in the browser.
- The rest of the app (reminders, approvals, Slack, digests, …) has its own
  tests from earlier steps but no spec file yet.
