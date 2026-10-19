# Expected behaviour: v1 gap items #4, #5, #7, #8

What each feature should do, written from the PRD and the product owner's
decisions, **not** from the code. Behaviour tests are written from this file,
one test per case id (test names start with the id, e.g. `D3: …`), so a
failing test means either the code or this file is wrong, and we decide which.

Status column: results of the spec tests, 2026-10-19. The tests are
`src/lib/spec-delete-snapshot.test.ts`, `src/lib/spec-people.test.ts`,
`src/lib/spec-only-next.test.ts` and `src/worker/spec-escalation.test.ts`,
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

## Open questions found while testing

- ~~**T7a/T7c:** when the copy needs approval, the series still skips that date
  straight away.~~ Decided 2026-10-19, option (b): the series skips that date
  only once the copy is approved (T11–T14).

## Not covered here

- Screens: layout, buttons hiding when not allowed. Checked in the browser.
- The rest of the app (reminders, approvals, Slack, digests, …) has its own
  tests from earlier steps but no spec file yet.
