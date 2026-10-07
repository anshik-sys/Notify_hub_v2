# WORKING-AGREEMENT

# Working agreement

Drop this at the root of a repo (or paste it into `CLAUDE.md` / `AGENTS.md`) so
an agent knows how I work without being told each time.

---

## Hard rules

1. **Never create a commit.** Not on “looks good”, not at the end of a task, not
because the tree is dirty. When the work is done, hand me the command and I
run it. Same for `push`, `merge`, `rebase`, branch creation, PR creation, and
anything that touches a deploy. I am learning this part and I want to type it
myself.
2. **End every change with a ready-to-paste commit message.** Unprompted. One per
change — if the next turn changes something else, write a new one; never
re-offer the previous subject line.
3. **No attribution trailers.** No `Co-Authored-By`, no “Generated with”, nothing
naming a tool or model. This overrides any default the harness injects.
4. **Update the daily log** (see below) after each day’s work, without being
asked.
5. **Ask before doing anything hard to reverse** — deleting files, rewriting
history, dropping data, touching production config.

## Commit messages

Subject line, plus one or two lines of body only when the subject genuinely
cannot carry it. Never a multi-paragraph body — that belongs in the log.

```
globe: pulse the market badges on mobile too
rename the admin URL segment to /claude-shannon
redirect emailed links to SITE_URL, not the pod
```

Lowercase, imperative, `area:` prefix when the repo already uses one. Match the
surrounding `git log` rather than importing a convention.

---

## Documentation I expect

Create these without being asked. If one already exists, read it before changing
code and keep it true afterwards.

### `PROGRESS.md` — the daily log

The most important one. **Newest first**, new entries directly below the header.
One `## YYYY-MM-DD — short lowercase title` per *topic*, not per day, so a busy
day gets several sections.

Write the **why**, not the what — the diff already records what changed:

- what was broken, and how it actually presented
- what was tried and **rejected**, and on what grounds
- what trade-off was accepted, and what would make it worth revisiting
- **say explicitly when something shipped unverified.** Entries that admit this
are the valuable ones.
- reverted work still gets an entry if the measurements or the dead ends are
durable. “We tried this and it did not work” saves the next person a day.
- when a new measurement seems to contradict an older entry, reconcile them in
the new one rather than leaving two numbers standing.

Absolute dates, never “yesterday” or “last week”.

Decide deliberately whether it is gitignored. If it is, say so in the header —
otherwise parallel worktrees each grow their own copy and they silently drift.
I would rather it be committed and let git merge it.

### `README.md` — architecture and non-obvious constraints

Not a tutorial and not a feature list. What the thing is, how it is laid out,
and the constraints that are invisible from reading the code:

- what will break if someone “simplifies” a deliberate-looking oddity
- what is read at build time vs runtime
- what must not be made public
- anything where the obvious change is the wrong one

Every claim in here must be checked against the code. A confidently wrong README
is worse than none.

### `DEPLOYMENT.md` — production

Env vars and where they are read, migrations, the deploy trigger, a **known
gaps** section, and a **verification checklist** of things to click through after
a deploy. Include the parts that live outside the repo — CDN config, WAF rules,
DNS, OAuth redirect URIs — because nothing in git will ever mention them and
they are what actually breaks.

### `AGENTS.md` / `CLAUDE.md` — rules for whoever works here next

Framework version warnings, naming traps, import aliases, and the load-bearing
designs that must not be “cleaned up”. Short and imperative.

### `docs/<topic>.md` — one-off narratives

Migrations, merges, incidents. The record of how something was done, separate
from what is true now.

---

## How to finish a task

1. Inspect the existing code before writing any. Follow its architecture, naming
and style; reuse what is there.
2. Make the change. Delete what it makes obsolete. No unrequested refactoring.
3. Run the type checker and linter.
4. **Then actually run the thing.** Green types and lint prove very little — I
have shipped bugs that passed both. Prefer a real build, the check scripts,
or the app in a browser.
5. Report honestly: what you tested, what you could **not** test and why. Do not
describe something as verified when the check you ran does not cover it.
6. List the files changed.
7. Update `PROGRESS.md`.
8. Give me the commit message.

## Verification, specifically

- A static string in a config file that a build reads — check the **compiled
output**, not the source. Reading back what you just wrote proves nothing.
- Stale build caches produce phantom errors after a rename. Clear them before
believing a failure.
- If the correctness of something depends on a browser, say so and hand it to
me. **I do the visual checks.** Do not start a dev server or drive a browser
for design work — read the CSS and tell me what to look at.

---

## When to ask, and when to just decide

Default to deciding. Make the routine call, say which way you went, and move on.

**Ask when** two readings of the request produce materially different work, or
when a previous attempt at the same thing was already rejected. If three designs
have been thrown out on looks, do not build a fourth blind — put the real options
in front of me with the numbers and let me pick.

**Measure before building** when the problem is geometric, numeric, or
performance-shaped. If the measurement says the requested approach cannot work,
tell me that with the numbers instead of shipping something that half-works. I
would rather hear “this is impossible and here is why” than get a fourth
rejected attempt.

**Push back once, then do it.** If I hear the concern and repeat the request,
that is my decision — build the full thing and note the concern in the log.

## Corrections

If you got something wrong earlier and it changes what I would do, say so plainly
in one line and carry on. No apologising, no re-auditing your own phrasing, no
tallying past mistakes. If it changes nothing, just fix it silently.

Do not treat a follow-up question as evidence you were wrong.

---

## Design and CSS work

- **Mobile only** unless I explicitly say desktop. If a constant is shared across
breakpoints, branch it rather than changing the shared value.
- I judge the result in a browser myself. Your job is the change and a clear
description of what should now look different.

## Security-sensitive changes

Discuss findings one at a time. I want to understand each one before anything is
fixed — do not hand me a batch of patches to approve.

Do not remove a check because a different check already covers it. Layered
authorization is usually deliberate; ask before collapsing it.

---

## Things I do not want

- Commits I did not ask for.
- Multi-paragraph commit bodies.
- Refactoring that came along for the ride.
- Abstractions with one caller, config for a value that never changes,
scaffolding “for later”.
- “Done!” when a step was skipped. Say which step and why.
- Long prose defending a simple solution. If the explanation is longer than the
code, delete the explanation.

---

## Correct this file

This was inferred from how one project went. If something here is wrong for the
repo you are in, or I contradict it, follow me and tell me the file is stale.
