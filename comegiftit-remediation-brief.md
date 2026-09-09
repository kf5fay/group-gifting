# ComeGiftIt — Remediation Brief

A work plan for hardening ComeGiftIt ahead of a public launch. Written to be handed to Claude Code and worked through in phases.

---

## 1. Context

**What it is:** A no-account gift-exchange coordinator. A creator makes a group, shares a link, members add wishlists, other members claim gifts to buy. The core promise is that a recipient never sees who claimed their own items.

**Stack:**
- `server.js` — Express 4, `pg`, `helmet`, `express-rate-limit`, `validator`
- `index.html` — single-file frontend, ~2,350 lines, vanilla JS, no build step
- `admin.html` — single-file admin dashboard
- PostgreSQL: `groups` table storing the entire group as a JSONB blob, plus `contact_submissions`
- Deployed on Railway at https://comegiftit.com

**Hard constraints:**
- **The app is live with real users. Existing groups must keep working.** Every change needs a migration path.
- **No passwords or accounts as a user-visible concept.** This is the product's main selling point. Identity tokens introduced below must be invisible to users in the normal flow.
- **No build step.** Keep the frontend as plain HTML/CSS/JS. Do not introduce React, a bundler, or a framework.
- **Do not restructure `index.html` into modules.** It is large and awkward, but a rewrite is out of scope and would make review impossible. Edit in place.

---

## 2. Root cause behind the major bugs

Three of the most serious problems share one cause: **the server has no idea who is making a request.**

Every endpoint treats "holds the group ID" as fully authorized, and a member's identity is just a string their browser types in. Consequently:

- The server cannot filter claim data, because it does not know whose wishlist to hide.
- "Creator only" actions (reset group, remove user, edit others' items) are enforced only by `if` statements in the browser.
- Two people named John collide, because a name is the only key.

Phase 2 introduces server-known identity. Phases 3 and 4 depend on it.

---

## 3. Decisions already made

These were settled in review. Do not re-litigate them; if something turns out to be unworkable, stop and flag it rather than substituting a different approach.

| Question | Decision |
|---|---|
| Identity model | Per-device member tokens. Multiple devices per member. No passwords in the normal flow. |
| Second device claiming an existing name | Approve-on-first-device, with an optional PIN as fallback |
| Anyone can join under a brand-new name and see all claims | **Accepted as a known limitation.** Do not build join gating. Fix the marketing copy instead. |
| Concurrency | Granular action endpoints (server merges), plus optimistic locking for remaining blob writes |
| Splitting a claimed gift | Request/accept only. Unilateral splitting is removed. |
| Backward compatibility | Existing groups must migrate cleanly and silently where possible |

---

## 4. Phase 1 — Standalone fixes

No design decisions and no dependencies. These can ship first, as one PR or several.

### 1.1 Group ID entropy

`index.html`, `generateId()`:

```js
return Math.random().toString(36).substring(2, 15);
```

The group ID is the only thing protecting a group. `Math.random()` is not cryptographically secure — V8's generator state can be recovered from a handful of observed outputs — and `substring(2, 15)` yields variable-length IDs that are occasionally short.

- Replace with `crypto.randomUUID()`.
- **Server-side validation must continue to accept legacy IDs.** The existing check in `server.js` is `/^[a-zA-Z0-9-_]+$/` with a 255-char cap, which already accepts UUIDs. Verify, do not tighten.

### 1.2 Stop destroying user input

`server.js`, `sanitizeString()`:

```js
sanitized = sanitized.replace(/[<>\"\']/g, '');
```

This silently corrupts ordinary text. "Levi's 501" becomes "Levis 501". `5'10"` becomes `510`. "O'Brien" becomes "OBrien".

It also buys no safety. The client already escapes at render time via `escapeHtml()`, and `linkifyText()` escapes before linkifying and sets `rel="noopener noreferrer"`. That is the correct defence and it is already in place.

- Remove the character-stripping and the `<[^>]*>` tag-stripping.
- Keep trimming, keep the length caps, keep type checks.
- Store raw text; continue escaping on output.
- **Audit every place the frontend injects stored strings into `innerHTML`** and confirm each one runs through `escapeHtml()` or `linkifyText()` first. This is now the only layer of defence, so it must be complete. Pay attention to `username` interpolation in `onclick` handlers — e.g. `showEditItemModal('${username}', ...)` — which needs proper escaping for a name containing an apostrophe.
- Already-mangled stored data is unrecoverable. Accept it.

### 1.3 Serve static files from a directory, not the project root

`server.js` does `app.use(express.static(__dirname))`, which publicly serves `server.js`, `package.json`, `env.template`, and `test-thank-you-logic.html`.

- Create `public/`, move `index.html` and `admin.html` into it, serve `public/` only.
- Update the `sendFile` path for `/admin`.
- Delete `test-thank-you-logic.html` — it is a scratch file with hardcoded 2025 dates.

### 1.4 `env.template`

Note: the repository is private, but `env.template` sits in the project root and is therefore served publicly by `express.static(__dirname)` — it is fetchable at `comegiftit.com/env.template` by anyone. Item 1.3 fixes the serving; this item fixes the contents. Do both.

- Remove the real personal email address (`anthonyismarketing@gmail.com`).
- Remove `EMAIL_USER` and `EMAIL_PASS` — `server.js` no longer uses them.
- Add `ADMIN_PASSWORD`, which the README documents as required but the template omits.

### 1.5 Git hygiene

- Two files exist, `gitignore` and `_gitignore`, neither with a leading dot. If those are what is committed, nothing is being ignored. Consolidate into one `.gitignore` and verify with `git check-ignore -v .env`.
- Both currently ignore `package-lock.json`. Remove that line and commit the lockfile — reproducible deploys, and dependency security alerts.

### 1.6 Social preview metadata

The live page has only `viewport` and `title`. The app's entire distribution model is people sharing links, so every share currently renders as a blank box.

Add to `<head>`:
- `<meta name="description">`
- `og:title`, `og:description`, `og:image`, `og:url`, `og:type`
- `twitter:card` (`summary_large_image`), `twitter:title`, `twitter:description`, `twitter:image`
- A favicon and an apple-touch-icon

The OG image should be 1200×630 and live in `public/`. If no image asset is available, generate a simple branded placeholder and note that it needs replacing.

### 1.7 Copy corrections

**Accuracy fixes (these are false as written):**
- `index.html` About modal: "no emails collected" — the contact form collects and stores name, email, and message in Postgres. Reword to describe what is actually collected.
- `index.html` FAQ, "Can the gift recipient see who claimed their items?": currently "No! That's the magic. When you claim someone's gift, they wont see anything at all. The surprise is safe!" Replace with wording that is true after Phase 3, e.g. *"ComeGiftIt never shows you who claimed your own gifts — your list looks exactly the same to you whether or not anything's been claimed."* Also fix the typo "wont".
- `index.html` FAQ, "What about security?": drop "enterprise-grade security" and "Your data is safe!". State the concrete facts instead — rate limiting, input validation, escaped output, HTTPS, no accounts, automatic deletion after two years.
- `README.md`: same "enterprise-grade" claim appears there.

**URL fixes:**
- `README.md` still documents `comegiftit.up.railway.app`. The live domain is `comegiftit.com`. Update everywhere and make it the first link in the README.

### 1.8 Surface save failures to the user

`index.html`, `saveData()` currently swallows every failure into `console.error`. A user whose write was rejected sees a UI that looks like it worked.

- Add a small non-blocking toast or inline banner for failed writes.
- Message should tell the user their change was not saved and to retry.
- This becomes more important in Phase 4, where 409 conflicts are a normal occurrence.

### 1.9 Remove the stray permission grant

The repository is private, so **no LICENSE file is needed — do not add one.**

However, `README.md` currently states "Free to use and modify for personal or commercial purposes!" That is an affirmative grant of rights that does not reflect intent.

- Delete that line.
- Do not replace it with a license.

### 1.10 Contact submission retention

`groups` rows are deleted after two years. `contact_submissions` has no retention rule and grows forever, holding names, emails, and message bodies.

- Extend the existing cleanup job to delete `contact_submissions` older than 12 months.
- Add it to the manual `/admin/api/cleanup` trigger as well.

### 1.11 Rate limiting for shared IP addresses

The current limits are per-IP. A family on one home network shares a public IP. At 100 GET/min with each client polling every 10 seconds (6/min), roughly 16 concurrent people on one network exhaust the read limit — a plausible Christmas-morning scenario. Writes are worse: 30/min shared across the whole household.

- Once Phase 2 lands, key rate limits on the member token where present, falling back to IP.
- Raise the write ceiling for token-identified users.

---

## 5. Phase 2 — Member identity

### 5.1 Model

- Each **member** belongs to a group and is identified by their display name within that group.
- Each member holds **one or more device tokens**. One row per device.
- Tokens are random 32-byte hex values, generated server-side, returned once, and stored **hashed** (SHA-256 is sufficient; these are high-entropy random values, not passwords).
- Tokens are sent on every authenticated request in an `X-Member-Token` header. **Never in a query string** — query strings end up in server logs and referrer headers.

### 5.2 Critical storage constraint

**Token hashes and PIN hashes must never enter the `groups.data` JSONB blob.**

The entire blob is serialized to every member on every poll. Anything stored there is public to the group. This is the same trap the existing `sanitizeInfoRequest()` comment in `server.js` correctly identifies for the anonymous info-request feature — apply the same reasoning here.

Use a new table:

```sql
CREATE TABLE group_members (
  id            SERIAL PRIMARY KEY,
  group_id      VARCHAR(255) NOT NULL REFERENCES groups(group_id) ON DELETE CASCADE,
  member_name   VARCHAR(100) NOT NULL,
  token_hash    CHAR(64) NOT NULL,
  pin_hash      TEXT,
  status        VARCHAR(20) NOT NULL DEFAULT 'active',  -- 'active' | 'pending'
  device_label  VARCHAR(100),
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_seen_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX ON group_members (token_hash);
CREATE INDEX ON group_members (group_id, member_name);
```

Notes:
- Multiple `active` rows per `(group_id, member_name)` = multiple devices for one person.
- A `pending` row is an unapproved device request.
- `pin_hash` is per member, not per device. Store the same hash on each of that member's rows, or normalise into a separate `group_member_pins` table — implementer's choice, but keep it out of the blob either way.
- `device_label` is for the approval prompt. Derive something human-readable from the User-Agent ("Chrome on Windows"). Do not store the raw UA string.
- `ON DELETE CASCADE` means the existing group-deletion and cleanup paths clean up members automatically. Verify this.
- The `groups` table needs a `version INTEGER NOT NULL DEFAULT 1` column for Phase 4. Add it in the same migration.

Follow the existing migration style in `server.js` — idempotent `CREATE TABLE IF NOT EXISTS` and guarded `ALTER TABLE` blocks that run at startup.

### 5.3 Join flow

`POST /api/groups/:groupId/join` with `{ name }`.

1. Reject if the name fails validation (non-empty, ≤100 chars after trim).
2. Look up `active` rows for `(group_id, name)`.
3. **No active rows** — the name is free. Create an `active` row, return `{ status: 'joined', token }`. If the group has no `createdBy`, set it to this member.
4. **Active rows exist** — the name is taken by another device. Create a `pending` row, return `{ status: 'pending_approval', pendingId }`. The new device polls for approval. Do not return a token.
5. If the group has a PIN set for that member and the client supplied a correct one, skip the pending state and issue a token immediately.

### 5.4 Device approval flow

The approving device already polls every 10 seconds. Reuse that.

- The **filtered group response** (Phase 3) includes, *for the requesting member only*, a `pendingDevices` array: `[{ pendingId, deviceLabel, requestedAt }]`. Because it is injected per-viewer, no other member ever sees it.
- The frontend shows a modal on the existing device: *"A new device wants to join as John. Was this you?"* with Approve and Deny.
- `POST /api/groups/:groupId/devices/:pendingId/approve` — requires an active token for that member. Flips the row to `active` and generates its token.
- `POST /api/groups/:groupId/devices/:pendingId/deny` — deletes the row.
- The waiting device polls `GET /api/groups/:groupId/devices/:pendingId` until it returns a token or a denial.
- Expire pending rows after 15 minutes.
- Rate-limit pending creation hard — 5 per group per hour — so this cannot be used to spam a member with modals.

### 5.5 PIN fallback

For when the original device is gone, wiped, or unreachable.

- Optional. Never required to join. Do not prompt for it during the normal join flow.
- Offer it in settings after joining: "Set a PIN so you can get back in from another device."
- 4–6 digits, hashed with bcrypt or scrypt (this one *is* a low-entropy secret and needs a slow hash).
- On the join screen, when a name is taken, offer "Use my PIN instead" alongside the approval wait.
- Rate-limit PIN attempts: 5 per 15 minutes per group+name.

### 5.6 Creator recovery code

The creator has nobody to approve them, so they need a self-service path.

- At group creation, generate a recovery code, display it once with a "save this" prompt, store only its hash.
- `POST /api/groups/:groupId/recover` with the code issues a fresh creator token.
- Rate-limit: 5 attempts per hour.

### 5.7 Creator releasing a member slot

For a member locked out with no PIN and no working device.

- `DELETE /api/groups/:groupId/members/:name/devices` — creator token required.
- Deletes all device rows for that member. Their wishlist data is untouched.
- The next browser to join under that name takes the slot fresh.
- Distinct from the existing "remove user" action, which deletes the member and their items.

### 5.8 Server-side authorization

Replace the browser-side `if (currentUser !== groupData.createdBy)` checks with real server checks. Keep the client-side ones for UX — they hide buttons — but the server is now the enforcer.

Creator-token-only operations:
- Reset group (`DELETE /api/groups/:groupId`)
- Remove a user
- Edit another member's item
- Release a member's devices
- Change group settings (name, holiday, event date)

Any authenticated member:
- Edit and delete their own items
- Claim, unclaim, request split, respond to split, mark purchased on *others'* items
- Request more info on others' items

### 5.9 Migration

Existing groups have members with no rows in `group_members`.

- Treat any member with zero `active` rows as **unclaimed**. The first device to join under that name claims it, no approval needed. This is exactly the Phase 2 join flow, so no special-case code is required.
- Returning users already hold `currentUsername` in localStorage. On load, if there is a stored username and no stored token, silently attempt a join with that name. For most returning users this succeeds invisibly and they notice nothing.
- If it comes back `pending_approval`, someone else has already claimed the name. Show the approval-wait screen with an explanation.
- **`createdBy` in legacy groups is just a string with no token behind it.** Until the creator's device claims their slot, no token can satisfy creator checks. Handle this: while a group has zero active member rows, allow the legacy client-side behaviour so the group is not bricked. Once any member has claimed a slot, enforce normally. Document this transitional window clearly in code comments.

### 5.10 Frontend storage

- Store the token in localStorage keyed per group: `memberToken_<groupId>`. A user may be in several groups with different tokens.
- Keep `currentUsername` for the migration path.
- On a 401, clear the stored token and return the user to the join screen with a clear message rather than failing silently.

---

## 6. Phase 3 — Server-side claim filtering

### 6.1 The bug

`GET /api/groups/:groupId` returns the whole blob, `claimedBy` / `purchased` / `splitWith` included, to everyone. `index.html` merely declines to render those fields for your own items. Any recipient can open `/api/groups/<id>` in a browser tab and read exactly who claimed what for them.

This is the app's headline feature and it is currently cosmetic.

### 6.2 The fix

Filter server-side, per viewer, using the Phase 2 token.

- Resolve the token to a member name.
- Deep-clone the blob before mutating. Do not modify the cached/queried object.
- For every item belonging to the **requesting member**, strip: `claimedBy`, `purchased`, `splitWith`, `splitRequests`, and `infoRequest` metadata beyond what the owner is meant to see (the owner *does* see that info was requested — that is the existing intended behaviour — but must never see who asked).
- Leave everything on other members' items intact.
- Inject viewer-specific data: `pendingDevices` (5.4) and any split requests awaiting this member's response (Phase 4).

### 6.3 Unauthenticated reads

Currently anyone with the link gets the full blob before joining. After this change:

- **No valid token → return metadata only:** group name, holiday, event date, and the list of member names. That is all the join screen needs.
- No wishlists, no items, no claim data.

This closes the "paste the API URL" leak completely for non-members, and it is a meaningful tightening on its own.

### 6.4 Admin observer mode

`loadGroupAsObserver()` currently calls the public `/api/groups/:groupId` endpoint. Once that endpoint filters, observer mode breaks.

- Point it at `/admin/api/groups/:groupId`, which already requires admin auth and returns unfiltered data.
- Admin sees everything, including claim data on every list. That is intended — it is a debugging tool.
- Verify the read-only banner and disabled controls still work.

### 6.5 What this does not fix

Anyone holding the link can still join under a brand-new name and see every claim, including on their own items. **This is an accepted limitation.** Do not build join gating. It is why the FAQ copy in 1.7 is being reworded.

A possible future mitigation, deliberately out of scope: let the creator enter a roster of allowed names at group creation, and reject joins outside it. Leave the data model open to this — do not build it.

---

## 7. Phase 4 — Granular endpoints and concurrency

### 7.1 The bug

Every action serializes the whole `groupData` object and POSTs it; clients replace local state every 10 seconds. Two people acting inside the same window means one change vanishes with no error.

The failure mode is two people buying the same gift — precisely what the product exists to prevent — and it becomes likely exactly when traffic arrives.

### 7.2 Replace blob writes with action endpoints

The server applies each change to the stored JSON inside a transaction rather than accepting a wholesale replacement.

```
POST   /api/groups/:groupId/items                       add an item to own list
PATCH  /api/groups/:groupId/items/:itemId               edit (own item, or creator)
DELETE /api/groups/:groupId/items/:itemId               delete (own item, or creator)
POST   /api/groups/:groupId/items/:itemId/claim
POST   /api/groups/:groupId/items/:itemId/unclaim
POST   /api/groups/:groupId/items/:itemId/purchase      toggle purchased
POST   /api/groups/:groupId/items/:itemId/info-request   anonymous, existing behaviour
POST   /api/groups/:groupId/items/:itemId/split-request
POST   /api/groups/:groupId/split-requests/:requestId/respond
PATCH  /api/groups/:groupId/settings                    creator only
DELETE /api/groups/:groupId/members/:name               creator only, remove user
```

Requirements:
- Every handler reads, modifies, and writes within a single transaction — `SELECT ... FOR UPDATE` on the group row, then `UPDATE`.
- Every handler increments `groups.version` and sets `updated_at`.
- Items are addressed by the stable `id` already generated in `sanitizeGroupData()`, **not by array index**. The current frontend passes indices (`deleteItem(${index})`, `showEditItemModal('${username}', ${index})`), which are unstable under concurrent edits. This needs updating throughout `index.html`.
- Enforce authorization per 5.8 in each handler.

**Claim conflict is now enforced server-side.** If an item is already claimed and the requester is not the claimer, return 409 with the current state. The client shows "Someone just claimed this — refresh to see." This is the single most valuable piece of the whole phase.

### 7.3 Optimistic locking for whatever remains

Some writes may stay blob-shaped during transition.

- Client sends the last-seen `version`.
- Mismatch → 409 with the current state.
- Client re-fetches, re-applies the user's intent if still coherent, retries once, then surfaces an error via 1.8.

### 7.4 Split request/accept

Unilateral splitting is removed. A member requests to join an existing claim, and the current claimer accepts or declines.

Data shape, stored on the item inside the blob:

```js
splitRequests: [
  {
    id: "…",
    from: "Bob",           // visible to the claimer, never to the gift owner
    to: "Mary",            // current claimer
    status: "pending",     // 'pending' | 'accepted' | 'declined'
    requestedAt: "…"
  }
]
```

Behaviour:
- `splitRequests` is stripped for the item's **owner** along with the rest of the claim data (Phase 3). Unlike the anonymous info-request, the claimer *does* see who is asking — Mary needs to know it is Bob.
- Mary sees a banner on her next poll: "Bob wants to split *[item]* with you." Model it on the existing info-request banner.
- On accept: add Bob to `claimedBy` and `splitWith`, mark the request `accepted`.
- On decline: mark `declined`. **Tell Bob** — a silent decline leaves him waiting indefinitely. Show him "Mary declined the split" once, then let him dismiss it.
- Bob may not have more than one pending request on the same item.
- Bob may re-request after a decline, but only once per item. Cap it there.
- Expire pending requests after 30 days, or when the item is unclaimed or purchased.
- Remove the existing unilateral "Split Gift" button and its handler.

### 7.5 Polling

Leave the 10-second interval as is. WebSockets are out of scope. With server-enforced claims the polling interval is no longer correctness-critical, only a freshness question.

---

## 8. Acceptance criteria

Phase 1:
- [ ] New group IDs are UUIDs; existing short IDs still resolve
- [ ] "Levi's 501" and `5'10"` round-trip through save and reload intact
- [ ] `curl https://comegiftit.com/server.js` returns 404
- [ ] `git check-ignore -v .env` reports a match
- [ ] Link shared to iMessage/Slack/Facebook renders a title, description, and image
- [ ] A rejected save produces a visible message

Phase 2:
- [ ] Join on device A, open the link on device B, approve on A, both devices work as the same member
- [ ] Deny on A, and B is refused
- [ ] Set a PIN on A, wipe A's storage, rejoin with the PIN, works without approval
- [ ] A non-creator token calling reset-group gets 403
- [ ] An existing pre-migration group opens and works for a returning user with no visible change
- [ ] No token hash or PIN hash appears anywhere in a `GET /api/groups/:id` response

Phase 3:
- [ ] `GET /api/groups/:id` with no token returns metadata only, no items
- [ ] `GET /api/groups/:id` as John contains no `claimedBy`, `purchased`, `splitWith`, or `splitRequests` anywhere under John's own items
- [ ] The same call as Mary shows full claim data on John's items
- [ ] Admin observer mode still shows everything

Phase 4:
- [ ] Two browsers claim the same item simultaneously; one succeeds, the other gets a clear 409 message
- [ ] Two people add items to different lists at the same time; both persist
- [ ] Bob requests a split, Mary accepts, both appear in `claimedBy`, John (the owner) sees nothing
- [ ] Mary declines and Bob is told
- [ ] No unilateral split path remains

---

## 9. Out of scope

Do not do these, even if they seem like obvious improvements:

- Rewriting or modularising `index.html`
- Introducing React, a bundler, TypeScript, or any build step
- WebSockets or server-sent events
- Real user accounts, email verification, or password login
- Join gating / allowed-name rosters (deliberately deferred)
- Email notifications
- Redesigning the landing page (tracked separately as marketing work)
- Any change to the theming, animation, or visual design

---

## 10. Suggested sequencing

1. **Phase 1** — ship independently, low risk, immediate value. The OG tags matter most for launch.
2. **Phase 2** — the foundation. Nothing else works without it. Test the migration path against a copy of production data before deploying.
3. **Phase 3** — small once Phase 2 exists, and it is the fix for the headline bug.
4. **Phase 4** — largest change, touches the most frontend code. Do it last, and consider splitting claim/unclaim (highest value) from the rest.
