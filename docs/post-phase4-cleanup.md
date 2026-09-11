# Post-Phase 4 cleanup

Small copy and polish items. No architectural changes. Safe to do in one pass.

---

## 1. Copy that is now inaccurate

### 1.1 FAQ — "What if two people try to claim the same gift?"

Current text describes real-time updates and unilateral splitting. Both are wrong after Phase 4.

Replace the answer with:

> Only one person can claim a gift. If someone beats you to it, ComeGiftIt tells you straight away instead of letting you both buy it. Everyone else's changes show up within about ten seconds. Want to go in on something together? Ask whoever claimed it to split — they get your request and can say yes or no.

### 1.2 FAQ — "How does it work?"

Verify this still matches behaviour after Phase 3 filtering. The current wording is close, but check the parenthetical about the recipient not seeing claims reads naturally alongside the reworded answer in 1.1.

### 1.3 "Logged in as:"

Appears above the wishlist form. The product's pitch is that there are no accounts, so "logged in" works against it.

Replace with **"You're adding to:"** or just show the name without a label.

### 1.4 Footer — leave as is

"Making holiday coordination simple since 2025" is a founding-date claim and is correct. No change needed.

---

## 2. FAQ entries to add

Phases 2 and 4 introduced behaviour users will encounter with no explanation anywhere.

### 2.1 "Can I use this on my phone and my computer?"

> Yes. Open the link on your other device and enter the same name — ComeGiftIt will ask whether it's you or someone else with the same name. Pick "that's me" and both devices work on the same list.

### 2.2 "Two of us have the same name. What happens?"

> When you enter a name that's already in the group, ComeGiftIt shows you how many items that person has and asks whether it's you on another device or a different person. Choose "different person" and you'll get your own separate list.

### 2.3 "I reset the group by accident!"

> A reset can be undone for 30 days. Open the group and you'll see an option to restore everything. After 30 days it's permanent.

Match the existing FAQ voice — short, second person, no jargon.

---

## 3. Missing assets

- **Favicon and apple-touch-icon.** The OG tags are in place but there are no icon links in `<head>`. Add both, plus a `<link rel="icon">`.

---

## 4. README

`README.md` documents none of Phases 2–4 and is now misleading to anyone (including Claude Code) working from it. Update:

- **Member identity** — per-device tokens, the trust model from brief section 5.0, the disambiguation prompt. Explicitly note there are no PINs, approval flows, or recovery codes, and why.
- **Reset** — soft delete with 30-day undo and typed confirmation.
- **Splitting** — request and accept, not unilateral.
- **API endpoints** — the current list is entirely superseded by the Phase 4 granular endpoints. Rewrite it.
- **Database schema** — add `group_members`, and the `version` and `deleted_at` columns on `groups`.
- **Caching** — ETag / 304 behaviour and hidden-tab polling.
- **"Who Do I Thank?"** — never documented at all.
- **Rate limits** — now keyed on member token, not only IP.
- Remove anything still describing whole-blob writes.

---

## 5. Verification — confirm these landed

These are the items most likely to have been dropped between phases. Check each and report, rather than assuming.

- [ ] **Deferred creator checks from Phase 2.** Phase 2 gated only destructive operations. Settings changes and edits to another member's item were deferred to Phase 4's granular endpoints. Confirm they are now enforced.
- [ ] **401 self-heal.** On a 401, the client silently re-joins using the stored `currentUsername`, takes a token, and retries the write once. It falls through to the join screen only if that fails.
- [ ] **ETag includes viewer identity**, not just `groups.version`. A version-only ETag lets one member's cached response satisfy another's request, which inverts the Phase 3 filtering.
- [ ] **ID backfill ran and is marked**, so it does not re-scan every table at every boot.
- [ ] **Tier 3 endpoints.** Settings and remove-user were optional in Phase 4. If they are still blob-shaped, confirm optimistic locking covers them.
- [ ] **Split request expiry** — after 30 days, or when the item is unclaimed or purchased.
- [ ] **Soft delete vs two-year retention.** Both run against the same rows. Confirm the 30-day purge and the two-year cleanup do not conflict or resurrect each other's rows.
- [ ] **Contact submissions cleanup** at 12 months, in both the scheduled job and the manual admin trigger.
- [ ] **Static file serving.** `curl` for `/server.js` and `/env.template` on staging should both return 404.
- [ ] **Device cap** — a sixth device for one member evicts the least recently seen.

---

## 6. Out of scope

Do not touch the landing page, the "Join an Existing Group" panel, or any visual design. That is being handled separately.
