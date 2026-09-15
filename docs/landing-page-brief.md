# ComeGiftIt — Landing Page Brief

Rebuild the marketing surface at `/`. Copy work and layout only. **No changes to app logic, the join flow, the wishlist screens, modals, themes, or any endpoint.**

---

## 1. Context you need before starting

**`index.html` is both the landing page and the entire app.** There is no separate marketing file and there must not be one — every group link already in circulation points at this file. The landing content lives inside the existing "create group" screen container, and the existing screen-switching logic decides what shows.

**People arriving from a shared link never see this page.** They land on `comegiftit.com/#<groupId>` and get routed to the join screen. Verify the landing content does not flash before routing resolves — if it does, fix it.

**This page ships to every user on every load**, including a joiner on mobile data. Keep it light. Two rules follow from that:

- The video is a click-to-play facade (section 5), never an embedded iframe on load.
- The hero screenshot is the only image above the fold and must be optimised.

**Traffic is overwhelmingly mobile.** The link arrives by text message. Design mobile-first and check a 375px viewport before anything else.

---

## 2. Structure

Six blocks, in this order. The hero is the form — a returning visitor should be able to create a group without scrolling.

### Block 1 — Hero

Contains, in this DOM order:

1. `<h1>` with the seasonal headline (section 3)
2. Sub-line
3. The existing create-group form, unchanged in function
4. A small reassurance line: `Free · No accounts · No ads`
5. The hero screenshot (section 4)

On mobile, the screenshot sits **below** the form. On desktop (≥900px), place them side by side — form left, screenshot right.

The form must remain first in tab order on every viewport.

### Block 2 — Three steps

Three items, one line each, horizontal on desktop and stacked on mobile.

### Block 3 — The surprise

The differentiator. Gets its own block with more visual weight than blocks 2 and 5.

### Block 4 — Video

Click-to-play facade. See section 5.

### Block 5 — Not just Christmas

Short. This is the year-round layer and the reason the page works in March.

### Block 6 — Footer

Keep the existing footer. Add a **Privacy** link alongside About / FAQ / Contact, opening a modal (section 7).

**Remove the "Join an Existing Group" panel entirely.** It only ever told people to go do something elsewhere, and its audience never sees this page.

Replace it with one small line near the footer:

> Got a link from someone? Just open it — it takes you straight to your group.

---

## 3. Copy

Use this text as written.

### Hero headline — seasonal

Between **1 November and 26 December inclusive**:

> Christmas without three people buying the same gift.

All other dates:

> Group gifting without three people buying the same gift.

### Hero sub-line — both seasons

> Create a group, share one link. Everyone adds a wishlist and claims what they're buying — and the person it's for never sees a thing.

### Under the form

> Free · No accounts · No ads

### Block 2 — Three steps

**1. Create your group**
Name it, pick the occasion, and you're done in about ten seconds.

**2. Share one link**
Text it, drop it in the group chat, email it. No signups for anyone.

**3. Claim what you're buying**
Everyone can see what's already taken — so nobody doubles up.

### Block 3 — The surprise

Heading:
> Your list looks completely normal to you.

Body:
> When someone claims a gift on your wishlist, you see nothing. No badge, no strikethrough, no hint that anything happened at all. Everyone else sees the full picture — who claimed what, what's been bought, who's splitting the cost of the expensive thing.
>
> You just get surprised on the day, like you're supposed to.

### Block 4 — Video

Heading:
> See it in action

Caption under the play button:
> 90 seconds

### Block 5 — Not just Christmas

Heading:
> Works for more than Christmas

Body:
> Birthdays, anniversaries, Hanukkah, or anything else you're buying for as a group. Pick the occasion when you create the group and the app follows along.

---

## 4. Hero screenshot

**The asset does not exist yet and must be created.** If it is not available, use a clearly-marked placeholder of the correct dimensions and tell me — do not ship a broken image or silently drop the block.

Requirements for whoever produces it:

- Show a group **mid-use**, viewing *another person's* wishlist, with claimed badges, a price range, and a priority marker visible. That view is the product.
- **Use fabricated names and items.** No real user data, ever.
- Default Christmas theme, since that is what most visitors will see on arrival.
- Mobile-shaped (portrait) reads better than desktop here and is narrower on the page.

Implementation:

- Serve WebP with a PNG fallback via `<picture>`.
- **Load eagerly** — it is above the fold. Do not lazy-load it, and do not put a fade-in animation on it.
- Set explicit `width` and `height` attributes to prevent layout shift.
- Real `alt` text describing what the screenshot shows, not "screenshot".
- `max-width: 100%`, never causes horizontal scroll at 320px.

---

## 5. Video

**Facade pattern, not an embed.** On load the page shows a poster image with a play button and nothing else. The iframe is injected only on click.

- A YouTube or Vimeo iframe pulls over a megabyte of JavaScript on load. This file is also the app. That cost is not acceptable for something most visitors will not play.
- The poster image is lazy-loaded (it is below the fold).
- The play button is a real `<button>` with an accessible label, keyboard-operable.
- Once clicked, the iframe autoplays.

If no video URL is available yet, build the block with a placeholder and make it easy to drop a URL in one place. Do not omit the block.

---

## 6. Seasonal switch

- Pure client-side, date-based. No server involvement, no config.
- **1 November to 26 December inclusive** → seasonal headline. Otherwise → neutral.
- Use the browser's local date.
- One small function, one place. The headline text should not be duplicated across the codebase.
- Apply it before first paint so the headline never visibly changes after load.

**Do not make the OG tags seasonal.** Social platforms cache aggressively and a rotating description produces inconsistent previews. Leave them static.

**Do not touch the existing theme system**, the falling animations, or the holiday dropdown. The seasonal switch affects the `<h1>` only.

---

## 7. Privacy modal

Add a **Privacy** link to the footer, opening a modal in the same style as About and FAQ.

Content: expand the existing privacy paragraph from the About modal into something a cautious parent would find reassuring. Cover, in plain English:

- What is stored — group name, occasion, the names people type, wishlist items and details
- That there are no accounts, passwords, or email addresses required to use it
- How long groups are kept (two years) and that they are then deleted automatically
- What the contact form stores and that it is deleted after twelve months
- That anyone with the group link can open the group, so only share it with people you want in it
- How to ask for data to be deleted — point at the contact form

No legal boilerplate. Write it the way the About modal is written.

---

## 8. Mobile

**Assume the majority of visitors are on a phone.** The link arrives by text message. Desktop is the minority case and should be treated as the adaptation, not the baseline.

### 8.1 What fits on the first screen

On a 375×667 viewport the headline, sub-line and create form already exceed one screen. A mobile visitor sees the promise and the top of the form and nothing else.

That is acceptable — the form is the priority — but it must be deliberate:

- Headline, sub-line, and the **first form field** must all be visible without scrolling at 375×667. Tune the type scale and spacing until that is true.
- The page must not *look finished* at the fold. Leave a visible edge of the next element so it is obvious there is more below. No scroll-prompt arrows or animation; just don't end the viewport on clean whitespace.
- Do not add a mobile-only pitch block above the form. The headline and sub-line are the pitch.

### 8.2 Form inputs — specific bugs to avoid

- **All form inputs need `font-size: 16px` or larger.** Below 16px, iOS Safari zooms the viewport on focus and frequently does not zoom back out. This is the single most common mobile form bug and it makes the app feel broken on the first interaction.
- **Do not use `100vh`** for the hero or any full-height element. Mobile browser chrome makes it wrong and causes content to sit under the address bar. Use `100dvh` with a `min-height` fallback, or avoid viewport-height units.
- **The Create button must be reachable with the keyboard open.** When the group-name field is focused, the on-screen keyboard takes roughly 40% of the screen. Check that submitting does not require dismissing the keyboard first.
- Mark the event date as **optional** in its label. It is an optional field in a three-field form, and on mobile every field feels like work.
- Set appropriate `inputmode` and `autocomplete` attributes so the right keyboard appears.

### 8.3 Touch and layout

- Minimum tap target **44×44px** for every button and link, including footer links. The footer currently packs several links onto one line — check the spacing between them.
- The hero screenshot is portrait, so **cap its height on mobile** (roughly 50vh) or it will consume an entire screen on its own.
- Body copy blocks: comfortable line length, generous line height. Blocks 3 and 5 are prose and need to be readable one-handed.
- **Check the fixed donation banner against notched devices.** If anything is fixed-positioned, it needs `env(safe-area-inset-top)` or it will sit under the notch or the home indicator.
- No horizontal scroll at 320px. Test by setting `overflow-x: hidden` off and looking, not by hiding the symptom.

### 8.4 Performance

- **Budget: no more than 50KB added to the HTML/CSS/JS payload**, excluding images. Report the actual figure.
- Hero screenshot: target under 100KB for the WebP.
- No iframe, no font file, and no third-party request before interaction.
- Test on a throttled connection (Fast 3G in devtools at minimum), not on office wifi.

### 8.5 Testing

Devtools device emulation does not catch the input-zoom bug, the `100vh` bug, or keyboard overlap. **Verify on a real iPhone and a real Android device** before calling this done. If that is not possible, say so explicitly rather than reporting it as tested.

---

## 9. Design constraints

- Use the existing colour variables and type scale. This should look like the same product, not a separate marketing site.
- Heading hierarchy: one `<h1>` (the hero headline), `<h2>` for each block. The current `<h1>` is the logo lockup — demote it.
- No new fonts, no CSS framework, no JS libraries.
- Respect `prefers-reduced-motion` on anything that animates.
- Contrast must pass WCAG AA against the seasonal theme backgrounds.

---

## 10. Acceptance criteria

- [ ] Opening `comegiftit.com` with no hash shows the new landing page
- [ ] Opening a valid group URL with a hash goes straight to the join screen with **no flash** of landing content
- [ ] The create form works exactly as before and is first in tab order at 375px and 1440px
- [ ] Headline reads "Christmas without…" when the local date is 1 Nov–26 Dec, and "Group gifting without…" otherwise (test by faking the clock, not by waiting)
- [ ] No iframe request is made until the play button is clicked
- [ ] No horizontal scroll at 320px, 375px, or 768px
- [ ] Headline, sub-line and the first form field are all visible at 375×667 without scrolling
- [ ] Focusing a form input on iOS Safari does not zoom the viewport
- [ ] The Create button is reachable with the on-screen keyboard open
- [ ] Every button and link meets a 44×44px tap target, footer links included
- [ ] Nothing sits under the notch or home indicator on a notched device
- [ ] Verified on a real iPhone and a real Android device, or explicitly reported as not verified
- [ ] Hero screenshot causes no cumulative layout shift
- [ ] Privacy modal opens from the footer and closes like the other modals
- [ ] "Join an Existing Group" panel is gone
- [ ] Added payload is under 50KB excluding images, and the actual figure is reported

---

## 11. Out of scope

Do not touch:

- Any API endpoint, server route, or database query
- The join flow, wishlist screens, claim logic, or split logic
- The theme system, falling animations, or holiday dropdown
- Admin dashboard
- Anything in the Phase 4 Tier 2 work
