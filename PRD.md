# NotifyHub: Product Requirements Document

**Status:** Draft v0.1 · **Date:** 2026-10-07 · **Owner:** _TBD_

This document is technology-agnostic. It says what the product does, not how it is built.

---

## 1. Overview

NotifyHub is a **reminder and notification platform for organisations**. Members of a company create reminders, choose who should receive them and when, and the system delivers them on schedule over **email** and **Slack**. Recurring reminders repeat automatically.

Reminders can be **announcements** (inform only) or **tasks** that every recipient must mark as done. If a task isn't done by its due date, each assignee who hasn't finished gets a notification every day until they mark it done. In phase 2, a task will also be able to open a **Jira ticket** for each assignee.

The company is organised into **departments**, each with its own **managers**. A manager can send to their own department freely. Sending to anyone outside it needs **admin approval**. Each reminder has a discussion thread. Admins manage users, departments, roles and integrations for their company.

### 1.1 Goals
- Make it easy to schedule one-time or recurring reminders to individuals, teams, departments or the whole company.
- Deliver reliably and exactly once, over the channels people already use (email, Slack).
- Track accountability: who has completed a task, and who approved it.
- Keep every company's data completely isolated from every other company's.
- Give admins control over users, permissions and integrations without needing a developer.

### 1.2 Non-goals for v1 (candidates for later)
- SMS / WhatsApp delivery.
- Native mobile apps. A responsive web app is enough.
- A desktop app (see 1.3).
- Billing, plans and subscriptions. Out of scope for now.
- Jira integration. **Phase 2** (see 7.3).

### 1.3 Product type and platform
- **A multi-tenant SaaS product sold to other companies.** Each customer company is a tenant.
- **A responsive web app**, used in the browser on desktop and mobile.
- **Installable as a PWA**, so it gets an app icon and **browser push notifications**.
- **No desktop app.** Reminders reach people through email and Slack, so a desktop install would add IT approval, per-OS builds and update work without adding value.
- Revisit native mobile only if customers have many users who work mainly from their phones.

---

## 2. Users and roles

| Persona | Description |
|---|---|
| **Platform owner (super admin)** | Runs the whole platform. Creates and manages companies; can see across tenants. |
| **Company admin** | Created during onboarding with **full access** to the company. Creates departments, assigns their managers, manages users, roles, integrations and settings. Can send to anyone in the company. Approves managers' out-of-department reminders. Sees all of the company's reminders. A company can have several admins. |
| **Department manager** | Assigned by an admin to one or more departments. **Adds and removes members of their own department only.** Sends reminders and tasks to their department without approval. Anything addressed outside their department needs admin approval. Sees all reminders sent to or created in their department. |
| **Member** | Receives reminders, completes tasks, comments. Can send reminders and tasks to members of their own department, including its manager(s). Anything wider needs admin approval. |
| **External recipient** | An email address outside the company. Only receives emails; has no account. |

### 2.1 Permissions (role-based access control)
- Access is controlled by **roles**, and each role is a set of **permissions**. A user can hold several roles.
- **System roles** are provided by the platform. **Company admins can create custom roles** for their company.
- Permission areas:

  | Area | Permissions |
  |---|---|
  | Reminders | create, view, edit, delete, send now, view all in company, approve |
  | Users | create, view, edit, delete, activate/deactivate, manage roles |
  | Departments and groups | create, view, edit, delete |
  | Company | view and edit settings, manage domains, manage integrations |
  | Reports | view, export |
  | Settings | manage permissions and roles |

- Suggested default roles:

  | Role | Includes |
  |---|---|
  | Company Admin | everything within the company, including approving out-of-scope sends |
  | Department Manager | manage members of their own department(s); send and create tasks for their department; request approval for wider sends |
  | Member | send to their own department, view reminders sent to them, complete tasks, comment |

  Admins can also create custom roles, such as an "Approver" who may approve but not manage users.
- **Permissions are scoped.** A department manager's permissions apply only to the departments they manage. An admin's permissions apply to the whole company.

- **Every permission must be enforced on the server.** The UI only hides what the user cannot do; it is never the security boundary.

---

## 3. Accounts and authentication

### 3.1 Sign-in methods
- **Google sign-in.** First sign-in creates the account. Only verified emails are accepted.
- **Email/username + password.**
- **Two-factor authentication (TOTP authenticator app):**
  - set up with a QR code and confirm with a code;
  - **backup/recovery codes**;
  - an admin can reset 2FA for a user;
  - a company can require 2FA for all its members.
- **SAML single sign-on**, configured per company:
  - the company admin enters the IdP entity ID, sign-on URL and certificate;
  - the platform shows the service-provider metadata to give to the IdP;
  - the user's email domain must match the company's domain;
  - users are created automatically on their first SSO login;
  - single logout is supported.
- **Company onboarding** (self-signup with a captcha, or set up by the platform owner):
  1. Create the company: name, domain and time zone.
  2. The person onboarding becomes the first **company admin**, with full access.
  3. A guided setup follows:
     - create departments;
     - invite members and assign them to departments;
     - choose a manager for each department;
     - optionally connect Slack and SSO (Jira in phase 2).

### 3.2 Account lifecycle
- **Forgot / reset password.** The emailed link is single-use and expires after 1 hour. The response is the same whether or not the account exists. A reset signs the user out of every session.
- **Invite users by email.** The admin invites; the user sets their own password, or signs in with Google or SSO.
- **Deactivating a user ends all of their sessions immediately and blocks every sign-in method.**
- Deleting a user is a soft delete: their history stays intact.
- Sessions survive a page refresh and refresh themselves silently. The user is not logged out after a short fixed time.
- Logout ends the session on the server.

### 3.3 Profile
- Users can edit their first name, last name and profile picture (image only, size-limited).
- Changing email requires verifying the new address.
- Users can see their departments, their department managers, groups and roles.
- Users can set their own **time zone** and notification preferences (see 7.5).

---

## 4. Organisation structure

- **Company (tenant):** name, contact email, address, website, tax ID, primary domain, time zone, and logo/branding.
- **Departments:**
  - created, renamed and deleted by **admins only**;
  - each department has **one or more managers**, assigned by an admin;
  - a user can belong to several departments, and a manager can manage several;
  - **members are added and removed** by admins (any department) or by that department's managers (their own department only);
  - departments are used both as recipients and for sharing (visibility).
- **Groups:**
  - custom distribution lists, e.g. "On-call engineers";
  - each has a name (unique within the company) and members;
  - **who may edit a group:** its creator and admins;
  - a manager's group may contain only members of the departments they manage; otherwise sending to it needs approval (5.9).
- **Directory:** a searchable list of company members showing avatar, name, email, departments and status.

---

## 5. Reminders (core)

### 5.1 Content
| Field | Rules |
|---|---|
| Title | Required; also the email subject. |
| Description | Plain text with line breaks; shown safely, never rendered as HTML. |
| Links | Up to 10 `{label, url}` pairs. http/https only; the label defaults to the domain. |
| Attachments | Multiple files; see 5.7. |
| Tags | Free-form labels for filtering. |
| Sender display name | e.g. "HR \| Acme". Default `Alerts \| <Company>`. |
| Public short ID | A short, human-friendly reference shown in the UI and in messages. |

### 5.2 Recipients: who receives it
- Recipients can be any mix of:
  - **typed email addresses**, internal or external;
  - **groups** (every active member);
  - **departments** (every active member);
  - **the whole company**;
  - **Slack channels**;
  - **specific people on Slack**.
- **Send scope (who can send to whom without approval):**

  | Sender | Can send without approval | Needs admin approval |
  |---|---|---|
  | Company admin | anyone: one person, one or more departments, the whole company | nothing |
  | Department manager | people, groups and channels inside the department(s) they manage, and the whole department | the whole company, other departments, people outside their department(s), external emails |
  | Member | members of their own department(s), including the department's manager(s) | the whole company, other departments, people outside their department(s), external emails |

  - The check runs on the **resolved recipients**. A group or channel that contains anyone outside the sender's scope counts as out of scope.
  - While the reminder is being created, the UI shows clearly that it will need approval before it is sent.
- Rules:
  - Recipients are resolved **at send time**, so the current membership applies.
  - Only active users of the same company are included.
  - Duplicates are removed.
- **Each email recipient gets their own message.** Recipients never see each other's addresses.

### 5.3 Channels
- Delivery channels are **Email** and/or **Slack**. At least one is required.
- Validation:
  - Email requires at least one email-capable recipient.
  - Slack requires a channel, Slack users, a group or a department.
  - Company-wide on Slack must go to a channel. The whole company is never sent individual messages.

### 5.4 Visibility: who can see it (separate from who receives it)
- The following people can always see a reminder:
  - its creator;
  - the managers of the creator's department(s);
  - company admins;
  - everyone it is sent to.
- The creator can additionally share it with:
  - their own department(s);
  - chosen departments;
  - chosen groups;
  - the whole company.
- A reminder that is not shared is private to the people listed above.
- Visibility applies everywhere: lists, details, search, dashboard counts, comments and the activity feed.

### 5.5 Schedule and recurrence
- **Send at:** date **and time**, in the creator's or the company's time zone.
- **Repeat options:**
  - does not repeat;
  - daily;
  - every weekday (Mon–Fri);
  - weekly;
  - monthly;
  - annually;
  - custom.
- **Custom repeat** (like Google Calendar):
  - Every **N** days, weeks, months or years.
  - Weekly: choose the weekdays.
  - Monthly: choose either **day D of the month** or **the Nth weekday**, such as "3rd Tuesday" or "last Friday".
  - Ends: never, on a date, or after N occurrences.
  - A plain-language summary is shown, e.g. "Every 2 weeks on Mon and Wed, until 31 Dec".
- **Recurrence rules:**
  - **No date drift.** A reminder on the 31st falls on the last day of shorter months and goes back to the 31st afterwards. 29 Feb falls on 28 Feb in non-leap years.
  - Calculations happen in local time, so weekdays and DST are correct.
  - If the system was down, missed occurrences are caught up without duplicates.
- **Pause / resume** a reminder, which also pauses its future occurrences.
- When the end date has passed, the reminder becomes inactive automatically.

### 5.6 Editing
- Every field can be edited after creation: content, recipients, channels, schedule, visibility, attachments, links, tags and the formal flag.
- A recurring reminder is edited for **this occurrence** or **this and all future occurrences**.
- Who may edit or delete: the creator, admins, and holders of the edit/delete permission.
- Delete is a soft delete with an audit trail.

### 5.7 Attachments
- Size limit of 10 MB per file.
- Allowed types: PDF, Office documents, CSV/TXT, common images and ZIP.
- Files are checked by their actual content, not only their extension.
- **CSV formula injection is blocked.** Cells starting with `= + - @` are rejected unless they are plain numbers or phone numbers.
- Files are stored privately. Downloading needs a signed-in user from the same company.
- **Email:** files are attached up to a total budget of about 20 MB. Files over the budget are listed by name in the message instead.
- **Slack:** files are uploaded with the message.

### 5.8 Formal reminders (tasks)
- A reminder can be marked **formal**, meaning it is a task to complete.
- **Assignees** are the internal users it was sent to: group, department and company members, plus typed emails that match company users.
- Each assignee marks **done** or **undo** for themselves. The task is complete only when **all** assignees are done.
- Progress is shown as "3 of 5 done".
- Creators, department managers and admins can see the per-person list with completion times. Assignees see only their own status.
- Each new occurrence of a recurring task starts with fresh completion.
- A formal reminder with only external recipients is completed with a single shared "done" toggle.
- Non-formal reminders have a single "mark complete" toggle for the creator.
- **Due date and daily follow-up (always on for tasks):**
  - every task has a **due date and time**;
  - if an assignee has not marked it done by then, they get a notification **every day** until they do, over the task's channels and in the app;
  - follow-ups go only to assignees who are not done; each person stops receiving them the moment they mark it done;
  - the company sets the time of day for follow-ups;
  - optional: escalate to the department manager after N days overdue.
- Tasks can be one-off, or **periodic** using the recurrence rules in 5.5. Each period creates a new task for the assignees.

### 5.9 Approval (out-of-scope sends)
- A reminder whose recipients fall outside the sender's scope (5.2) is held as **Pending approval**. **Nothing is sent until it is approved.**
- Admins, or named approvers if the company has configured them, are notified in the app, by email and on Slack.
- **Approve:**
  - the reminder is scheduled as normal;
  - if its send time has already passed, it is sent immediately.
- **Reject:**
  - the approver must give a reason;
  - the creator is notified and can edit and resubmit.
- If an approved reminder is edited so that its recipients widen beyond what was approved, it needs approval again.
- **Approval covers the whole series.** One approval applies to every future occurrence of a recurring reminder.
- An **approvals queue** shows pending requests. For each one: sender, recipients (highlighting who is out of scope), content, schedule and attachments.
- Every approval and rejection is recorded: who, when and why.

### 5.10 Announcements
- A reminder can be an **announcement**: information only, with no completion and no assignees.
- Can be one-off or periodic (5.5), e.g. a monthly policy reminder to the whole company.
- The same send scope and approval rules apply.

### 5.11 Comments
- Threaded discussion on each reminder: comment and reply.
- **@mentions** notify the mentioned person.
- Authors can edit and delete their own comments. Admins can delete any comment.
- Anyone who can see the reminder can comment.

### 5.12 Preview and send-now
- Before saving, the creator sees a **preview** of the email and the Slack message.
- **Send now:** sends a reminder immediately. For a recurring reminder, the next occurrence stays on its normal schedule.
- **Send a test** to yourself.

---

## 6. Delivery engine

- A background scheduler checks every minute for reminders that are due.
- **Exactly once:** a reminder occurrence is never sent twice, even with overlapping runs or retries.
- **Retries:**
  - failed sends retry with backoff, up to a maximum number of attempts;
  - after that the occurrence is marked **Failed** and shown to the creator and admins.
- **Partial success:**
  - if some recipients fail, only the failed ones are retried;
  - recipients who already got the message do not get it twice.
- **Delivery log** per occurrence:
  - per-channel and per-recipient status: sent, failed or bounced;
  - the time it was sent;
  - a snapshot of the subject, recipients and sender.
- **Retention:** sent occurrences older than a configurable period (default 90 days) are archived.
- **Volume alert:** the platform owner is warned when any upcoming day has more than a set number of scheduled emails.

---

## 7. Channels and integrations

### 7.1 Email
- An HTML message plus a plain-text version, with company branding, the description, links and attachments.
- Messages include a link back to the reminder in the app.
- **Sending is provided by NotifyHub.** Customers do not need an email server or provider. There are three tiers:

  | Tier | From address | Customer setup | Availability |
  |---|---|---|---|
  | **1. Default** | `"Acme HR via NotifyHub" <notifications@notifyhub.app>` | None; works from day one | v1 |
  | **2. Verified company domain** | `"Acme HR" <no-reply@acme.com>` (the local part is configurable) | Add the DNS records we show (SPF/DKIM, plus DMARC guidance); verified automatically | v1 |
  | **3. Bring your own SMTP** | Anything their own server allows | SMTP host, port, user and password; stored encrypted; with a test-send | Phase 2, on request |

  - On the default tier, **Reply-To is set to the reminder's creator** so that replies reach a person.
- **Rules for the company-domain tier:**
  - **A company can never send from a domain it hasn't verified.** Without verification, mail would be spoofed, rejected by DMARC, and would damage deliverability for every customer.
  - The setup screen shows each DNS record with a copy button and a live status (pending / verified / failed). It re-checks automatically and emails the admin when verification completes.
  - If verification later breaks (for example, the DNS records were removed), sending falls back to tier 1 and the admin is alerted.
  - A company can verify more than one domain, and choose the sending domain per department.
- **Protecting deliverability:**
  - each company's reputation is tracked separately;
  - per-company sending limits, raised on request;
  - bounces and complaints are tracked;
  - hard-bounced addresses are suppressed;
  - a company with a high bounce or complaint rate is paused and the platform owner is alerted.
- External (non-member) recipients get an **unsubscribe** link. Company members cannot unsubscribe from tasks.
- Bounce and complaint tracking feeds the delivery log.

### 7.2 Slack
- **Each company connects its own Slack workspace** through an in-app "Add to Slack" flow. Admins can see the connection status and disconnect.
- **Who is notified:**
  - the chosen channels;
  - the chosen users, by direct message;
  - group and department members, by direct message.
- **Matching people to Slack:** NotifyHub users are matched to Slack users by email automatically.
- **When a DM can't be delivered:** the message goes to an optional fallback channel.
- **Message contents:** title, description, links, attachments, and a link to the reminder.
- **Interactive buttons:**
  - **Mark done**, for formal reminders;
  - **Snooze**;
  - **Open in NotifyHub**.
- **Overdue follow-ups:** the daily task follow-ups (5.8) arrive as DMs, each with a **Mark done** button.
- **Daily digest (per company, configurable):**
  - lists overdue and upcoming items for the next 24 hours;
  - posted to the chosen channels and sent to the chosen people;
  - admins configure it in Settings.

### 7.3 Jira (phase 2, draft)
_Not in v1. This is a draft to discuss before phase 2._

- Per-company connection: site URL, account email, API token, default project.
- The token is stored encrypted and never shown again after it is saved.
- **Connection test.**
- **Automatic ticket creation:**
  - a task can have "Create Jira tickets" switched on;
  - the company can make this the default for tasks created by managers;
  - when the task is sent, **one Jira issue is created per assignee**, assigned to that person (matched by email) in the chosen project;
  - the issue carries the title, description, links, attachments, due date and a link back to the reminder;
  - periodic tasks create a new issue each period.
- **Two-way status:**
  - marking the task done in NotifyHub transitions the Jira issue to Done;
  - closing the Jira issue marks that assignee done in NotifyHub.
- Assignees who have no matching Jira account are listed as "no ticket" and still get email and Slack.
- The ticket key and its status are shown on the reminder.

### 7.4 Custom domain (optional, SaaS)
- A company can serve the app on its own subdomain, e.g. `notifyhub.acme.com`. It must prove ownership with a DNS record first.
- Guided setup: the system shows the DNS records to add, checks for them automatically, and emails each step as it completes.

### 7.5 In-app notifications and preferences
- A notification centre lists:
  - reminders sent to me;
  - tasks assigned to me;
  - approvals I need to give;
  - comments and mentions;
  - activity on my reminders.
- Read and unread states, and "mark all read".
- Per-user preferences: which channels to use for which events.

---

## 8. Views and screens (functional, not visual)

- **Dashboard:**
  - stat cards: pending, completed, due in the next 7 days, active, failed;
  - upcoming reminders;
  - my open tasks;
  - approvals waiting on me;
  - recent activity.
- **All reminders:**
  - search by title, description, recipient, ID or tags;
  - filters: status, channel, repeat type, creator, formal or not, date range, tags;
  - sorting and pagination.
- **My tasks:** formal reminders assigned to me, with done/undo.
- **Reminder detail:**
  - everything about the reminder;
  - schedule summary and next occurrence;
  - recipients;
  - task progress;
  - approval;
  - comments;
  - delivery history;
  - attachments and links;
  - actions: edit, pause, send now, delete.
- **Calendar view** of upcoming occurrences.
- **Team:** the directory plus group management.
- **Settings:** profile, security (2FA, active sessions), notification preferences, integrations.
- **Admin:** see section 9.
- Every view has its own URL, so it can be deep-linked and works with the browser's back button.
- Light and dark themes; the choice is remembered and follows the system setting by default.
- Fully usable on mobile.

---

## 9. Administration

### 9.1 Company admin
- **Users:**
  - invite, create, edit, deactivate/reactivate, delete;
  - assign departments, department managers, groups and roles;
  - reset 2FA;
  - bulk import from CSV.
- **Departments and groups:** full management.
- **Roles:** create, edit and delete custom roles and attach permissions; assign roles to users.
- **Company settings:**
  - profile, domain, time zone and branding;
  - default sender name;
  - who approves out-of-scope sends (any admin, or named approvers);
  - whether 2FA is enforced;
  - data retention period.
- **Integrations:** Slack, SSO and custom domain (Jira in phase 2).
- **Audit log:**
  - every create, update and delete, showing actor, action, object and time;
  - filterable and exportable;
  - secrets never appear in it.
- **Active sessions:** see them and revoke them.
- **Reports** (section 10).

### 9.2 Platform owner
- Manage companies: create, edit, suspend, delete (only when the company is empty).
- Manage system roles and the permission catalogue.
- See every company's usage, and the health of the delivery queue (due, sent, failed).
- Configure the volume alert threshold.
- Admin access is restricted, for example by an IP allowlist.

---

## 10. Reports and analytics
- Delivery volume over time, by hour, day or month, per channel.
- Delivery success and failure rates.
- Task completion rate and average time to complete, per department or team.
- Overdue tasks by person, department or team.
- Export to CSV.

---

## 11. Non-functional requirements

### 11.1 Security
- **Tenant isolation:** strict, enforced on the server for every read and write, and covered by automated tests.
- **Rate limiting:**
  - applies to login, signup, 2FA, password reset, uploads and the API;
  - stays on even if its backing store is unavailable (fails closed).
- **Secrets:** integration tokens are encrypted at rest. The app refuses to start without its encryption keys.
- **Tokens:** never placed in URLs. Password-reset and 2FA challenge tokens are stored only as hashes.
- **Web hardening:** strict security headers (content security policy, HSTS, no framing); secure cookies.
- **Search engines:** the app is not indexed.
- **Uploads:** content is validated and files are stored privately.
- **Scheduled jobs:** their endpoints are authenticated.

### 11.2 Reliability
- Exactly-once delivery.
- Retries with a visible failed state.
- A health-check endpoint.
- Production refuses to start with insecure or missing configuration.

### 11.3 Performance
- Lists are paginated.
- The scheduler handles bursts, such as company-wide sends, without timing out.

### 11.4 Accessibility
- Keyboard navigable.
- Screen-reader labels.
- Sufficient colour contrast.

### 11.5 Privacy
- Each email recipient gets a separate message.
- Soft delete with a retention period.
- An admin can export a user's data and delete it permanently.

---

## 12. Open questions
1. ~~Internal tool or SaaS?~~ **Decided 2026-10-07:** SaaS sold to other companies, delivered as a web app (see 1.3).
2. ~~What can a member send without approval?~~ **Decided 2026-10-07:** members of their own department, including its manager(s).
3. Which sign-in methods are in v1?
4. Time zone at company level, user level, or both?
5. Jira (phase 2): one issue per assignee (current draft), or one issue per task with sub-tasks?
6. Are SMS / WhatsApp in scope, and when?
7. Does Slack get interactive buttons (mark done, snooze) in v1?
---

## 13. Additions

_Space for new features not covered above._

-
