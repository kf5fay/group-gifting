# 🎄 ComeGiftIt - Holiday Gift Exchange App

**Live at https://comegiftit.com**

A festive web app for organizing gift exchanges with family and friends. Each group gets a unique shareable link, and members can add wishlists, claim gifts, and coordinate purchases—all while preserving the surprise of who's getting what!

## ✨ Features

### Core Features
- 🔗 **Unique Group Links** - Each family/group gets their own unique shareable link
- 📱 **Share Button** - Easy link copying and native mobile sharing
- 🎨 **5 Dynamic Themes** - Christmas, Birthday, Hanukkah, Anniversary, or Other with matching colors and falling animations (snowflakes ❄️, balloons 🎈, stars ✡️, hearts 💕, confetti 🎊)
- 📅 **Smart Event Dates** - Auto-fills Christmas and Hanukkah dates; custom dates for any occasion
- 🎁 **Gift Management** - Add items to your wishlist with easy-to-use X button to delete
- 👥 **Multiple Users** - Everyone in the group can join and manage their lists
- ⚡ **Live Updates** - Changes appear automatically every 10 seconds without refreshing
- 🔒 **Creator Controls** - Only the group creator can reset the group or remove users, enforced by the server against their device token
- 📱 **Multiple Devices** - Use the same list on your phone and your computer; no password to type

### Gift Coordination Features
- ✅ **Claim Gifts** - Click to claim a gift you'll purchase. If two people claim at the same moment the server picks one and tells the other, so nobody buys the same present twice
- ↩️ **Unclaim** - Change your mind? Unclaim anytime
- 🤝 **Gift Splitting** - Click a claimed gift to split the cost with someone
- 💰 **Price Ranges** - Add suggested price ranges (Under $25, $25-$50, $50-$100, Over $100)
- ⭐ **Priority Levels** - Mark items as High, Medium, or Low priority
- 📝 **Details & Links** - Add notes like size, color, links (automatically clickable!), or preferences
- ✓ **Mark as Purchased** - Track when gifts have been bought
- 💌 **Who Do I Thank?** - After the event date, find out who bought which of your gifts
- ❓ **Ask for More Info (Anonymous)** - Vague item on someone's list? Ask them to add details without revealing you asked. The owner sees a reminder banner and a badge on that item; nobody — including the owner — can see who asked. The reminder stays until they actually update the item, and the "×" only hides the banner for 24 hours (a new request from someone else brings it back).

### The Magic: Gift Surprise Preservation 🎁
- 🎁 **Recipients Can't See Claims** - Claim data on your own items is removed by the
  server before the page ever receives it, so on YOUR OWN wishlist there is nothing to see:
  - Who claimed your items
  - That your items were claimed at all
  - Purchase status
  - Split gift status
- 👀 **Gift Givers See Everything** - When viewing OTHERS' wishlists, you can see:
  - All claim status and who claimed what
  - Purchase status
  - Split gift participants
  - Full coordination info
- 🔎 **Enforced server-side** - The filtering happens per viewer, in the API response.
  Opening the API URL directly, or reading the page source, shows a recipient no more
  than the app does.
- 💌 **Except afterwards** - Once the event date has passed, "Who Do I Thank?" tells you
  who bought what for you. That reveal is date-gated on the server too.
- **Result**: Perfect gift coordination without spoiling the surprise!

### Group Management (Creator Only)
- ✏️ **Edit Any Item** - Fix typos or update details on anyone's wishlist
- 👤 **Remove Users** - Delete accidentally added users (misspelled names, test accounts, etc.)
- 🗑️ **Reset Group** - Clears the group for everyone. Needs the group's name typed to confirm, and can be undone for 30 days

### Design & UX
- 📊 **Visual Indicators** - Clear badges for priority, price, claimed status, and split gifts
- 🎨 **Theme-Matched Headers** - Icons change based on event type (🎄 for Christmas, 🕎 for Hanukkah, etc.)
- 📱 **Mobile-Friendly** - Fully responsive design
- 🌮 **Support the Creator** - Optional donation banner (buy me a taco!)

### Security & Privacy
- 🔒 **No Accounts Required** - No passwords, no email verification
- 🛡️ **Security Basics** - HTTPS, Helmet security headers, rate limiting, input validation, output escaping
- 🗄️ **PostgreSQL Database** - Reliable, scalable data storage
- 🕐 **Data Retention** - Groups automatically deleted after 2 years; contact form submissions after 12 months
- 📧 **Contact Form** - Built-in feedback system via Web3Forms

## 🔐 Admin Dashboard

The admin dashboard provides essential management tools for ComeGiftIt.

### Access
Navigate to `/admin` on your deployed site and log in with the admin password (set in `.env` as `ADMIN_PASSWORD`).

### Features
- **System Statistics**: View total groups, users, items, and contact submissions in real-time
- **Groups Management**: Search, view, and delete groups with detailed information
- **Observer Mode**: View any group without joining or affecting data - your name won't appear and no changes will be saved
- **Contact Submissions**: View and manage user feedback from the contact form
- **Manual Cleanup**: Trigger deletion of old groups (2+ years)

### Observer Mode
The observer mode is a powerful feature that lets you debug user issues without affecting their data:
1. In the admin dashboard, find the group you want to inspect
2. Click "👁️ View" to open it in observer mode
3. A red banner will appear at the top indicating "ADMIN OBSERVER MODE - Read Only"
4. You can see all wishlists, claims, and purchases without your name appearing in the user list
5. All input fields and action buttons are disabled - no data can be modified

Observer mode reads `/admin/api/groups/:groupId`, which is unfiltered, rather than the public
endpoint, which is not. It therefore needs a live admin session: open it from the dashboard's
"👁️ View" button rather than by typing the `?admin=true` URL yourself.

### Security
- Sessions expire after 2 hours of inactivity
- Login attempts are rate-limited (3 attempts per 15 minutes)
- All admin actions are logged to console (visible in Railway logs)
- Admin password is stored as an environment variable
- In-memory session storage (cleared on server restart)

### Setting Up Admin Access
1. Update the `ADMIN_PASSWORD` in your `.env` file
2. Use a strong password (20+ characters, mix of letters/numbers/symbols)
3. For Railway deployment, add `ADMIN_PASSWORD` as an environment variable in the project settings
4. Never commit the `.env` file to version control (it's already in `.gitignore`)

## 🚀 Deployment to Railway

### Quick Deploy (Recommended)

1. **Create Railway Account**: Visit https://railway.app and sign up
2. **New Project**: Click "New Project"
3. **Add PostgreSQL**: 
   - Click "Add Service"
   - Select "PostgreSQL"
   - Railway will provide a `DATABASE_URL` automatically
4. **Deploy from GitHub**:
   - Click "Add Service" again
   - Choose "GitHub Repo"
   - Connect your GitHub account and select your repo
   - Railway will auto-detect the Node.js project and deploy!
5. **Environment Variables**:
   - `DATABASE_URL` is set automatically by Railway
   - `PORT` is set automatically by Railway
   - `ADMIN_PASSWORD` - Add this manually in Railway's environment variables for admin dashboard access
   - Use a strong password (20+ characters, mix of letters/numbers/symbols)

### Optional: Set Up Contact Form Email
The app includes a contact form that uses Web3Forms (free service):
1. Sign up at https://web3forms.com
2. Get your access key
3. Replace the access key in `public/index.html` (search for "access_key")

### Files Included for Deployment
- `public/index.html` - Main application (single-page app)
- `public/admin.html` - Admin dashboard
- `public/og-image.png`, `public/favicon.svg`, `public/apple-touch-icon.png` - Social preview image and icons (generated placeholders — replace with real artwork)
- `server.js` - Express server with PostgreSQL
- `package.json` / `package-lock.json` - Node.js dependencies

Only `public/` is served statically. `server.js`, `package.json` and
`env.template` sit outside it and are not reachable over HTTP.

## 💻 Local Development

```bash
# Install dependencies
npm install

# Run the server
npm start

# Open browser to http://localhost:3000
```

## 📖 How to Use

### First Person (Group Creator)
1. Open the app
2. Fill in:
   - **Family/Group Name** (e.g., "Smith Family Christmas 2025")
   - **Event Type** (Christmas, Birthday, Hanukkah, Anniversary, Other)
     - Watch the theme change with animated falling items!
     - Christmas and Hanukkah dates auto-fill
   - **Event Date** (optional, but recommended)
3. Click "Create Group"
4. Enter your name to join
5. Share the link with your family/friends

### Everyone Else (Joiners)
1. Click the shared link
2. Enter your name
3. Click "Join Group"
4. Start adding items to your wishlist!

### Adding to Your Wishlist
1. Type what you want in the text field
2. Select priority level (High, Medium, Low)
3. Select price range (optional)
4. Add details like size, color, or links (URLs become clickable automatically)
5. Click "Add to My Wishlist"
6. Delete items anytime with the X button in the top-right corner

### Claiming Gifts for Others
1. Browse other people's wishlists
2. Click "Claim" to claim a gift you'll purchase
3. You'll see "Unclaim" and "✓ Purchased" buttons appear
4. Click "✓ Purchased" when you've bought it
5. **Note**: The recipient can't see you claimed it - surprise preserved! 🎁

### Splitting a Gift
1. See a gift that's already claimed by someone else?
2. Click "Split Gift" to go in together
3. Both of you will be listed as claimers
4. Perfect for expensive items!

Splitting is currently unilateral — you join someone else's claim without asking.
Changing this to a request the current claimer accepts or declines is planned
(remediation brief 7.4) and not yet built.

### Group Creator Powers
As the group creator, you have special abilities:
- **Edit Any Item**: Fix typos or update details on anyone's wishlist with the ✏️ Edit button
- **Remove Users**: Delete accidentally added users with the "Remove User" button, after a
  confirmation naming the person and how many items they have
- **Reset Group**: Clears the group for everyone. You have to type the group's name to
  confirm, and it is a **soft delete** — for 30 days the group shows a "this group was
  reset" screen with an undo, and the creator can restore everything. After 30 days the
  cleanup job deletes it for good.

Creator actions are enforced by the server against your device token, not by the browser
hiding buttons. See **Member identity** below.

### Who Do I Thank?
Once the event date has passed, a "Who Do I Thank?" button appears on your own list and
tells you who bought which of your gifts. Before that date the server will not answer the
question at all — the surprise is not something the page merely declines to render.

### Viewing the App
- **Your Own Wishlist**: Clean view - no claim status (keeps the surprise!)
- **Others' Wishlists**: Full coordination info - see who claimed what, purchases, splits

The clean view is produced by the server, not the page. Claim data on your own items is
stripped from the API response before it is sent to you, so opening the API URL directly
tells a recipient nothing.

## 🛠️ Technical Details

### Member identity
There are still no accounts, no passwords, no email and nothing for a user to remember.
The server nevertheless needs to know who is asking, so that it can hide your own claim
data from you and tell two people called John apart.

- When you claim a name in a group, the server issues a **random 32-byte device token**,
  returns it once, and stores only its SHA-256 hash in `group_members`. The browser keeps
  it in `localStorage` under `memberToken_<groupId>`.
- The token is sent on every authenticated request in an `X-Member-Token` header. Never in
  a query string, where it would end up in access logs and `Referer` headers.
- One member may hold **up to 5 device tokens**. A sixth evicts the least recently seen.
- Joining under a name that already exists asks "is this you on another device, or a
  different person with the same name?" and shows that person's item **count** and join
  date — never their item names.
- The member list shows how many devices each person has, and says so when a new one
  appears. Since identity is claimed rather than proven, that visibility is the check.

**Identity here is claimed on trust, not proven.** Anyone who has the group link was
invited by someone, and the group polices itself socially. So there are deliberately
**no PINs, no approval flows, no recovery codes and no lockout recovery** — there is
nothing to recover from, because nobody can be locked out, and every one of those
mechanisms would cost the product its main selling point. Impersonation also gains an
attacker nothing: claiming Mary's name shows you *Mary's* filtered view, which hides the
claims on Mary's items.

The one place trust is not enough is destructive creator actions, which is why Reset is a
soft delete with a 30-day undo and a typed confirmation.

**Legacy groups.** A group created before device tokens existed has a `createdBy` name
with no member row behind it. Creator authority falls back to that name check, but only
while the creator holds no device — and that is re-evaluated on every request, never
cached per group, so a group whose creator never returns stays usable.

### Data Storage
- Uses **PostgreSQL database** for reliable, scalable data storage
- Each group has a unique ID in the URL (hash fragment), a `crypto.randomUUID()`
- The browser remembers your name and this group's device token in localStorage
- Every item carries a stable `id`. Actions address items by that id, never by their
  position in the array, which moves whenever anyone adds or deletes something. A startup
  migration backfills ids on groups written before ids existed.
- Data structure:
```javascript
{
  groupName: "Smith Family Christmas",
  holiday: "Christmas",
  eventDate: "2025-12-25",
  createdBy: "Anthony",
  users: {
    "John": {
      items: [
        {
          // claimedBy / purchased / splitWith are removed from this item before
          // it is sent to John himself. Everyone else receives them.
          description: "Blue sweater",
          priority: "high",
          price: "$25-$50",
          details: "Size L, prefer wool, https://amazon.com/...",
          notes: "Found at Target",
          id: "3f2b...",              // stable; how the action endpoints address it
          claimedBy: ["Mary", "Bob"], // Array for split gifts
          purchased: false,
          splitWith: ["Bob"]
        }
      ]
    }
  }
}
```

### How writes work
Claim, unclaim and mark-purchased each go to their own endpoint, which reads, modifies and
writes the group inside a single transaction with the row locked. If two people claim the
same gift at the same moment, one succeeds and the other gets a `409` with the current
state and a message saying so — the server decides, not whichever browser saves last.

Everything else — adding, editing and deleting items, settings, and removing a member —
still sends the whole group object and is last-writer-wins. Two people adding items to
different lists at the same moment can still lose one. Converting those to granular
endpoints is the remaining Phase 4 work (remediation brief 7.2 and 7.4).

Because clients only ever hold a *filtered* copy of the group, the whole-blob write is not
trusted with claim state: claim data is authoritative in the database, and such a write may
only add or remove **the writer's own** participation in a claim. It can never alter anyone
else's. Without that, a tab that last polled before a claim was made would undo it on its
next save.

`groups.version` increments on every write and is returned by `GET /api/groups/:groupId`.

### Database Schema
```sql
-- Groups table
CREATE TABLE groups (
  group_id VARCHAR(255) PRIMARY KEY,
  data JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  version    INTEGER NOT NULL DEFAULT 1,  -- bumped on every write
  deleted_at TIMESTAMP NULL               -- set by Reset; 30-day undo window
);

-- Member devices. Token hashes live here and ONLY here: groups.data is served
-- to every member on every poll, so anything stored in it is public to the group.
CREATE TABLE group_members (
  id            SERIAL PRIMARY KEY,
  group_id      VARCHAR(255) NOT NULL REFERENCES groups(group_id) ON DELETE CASCADE,
  member_name   VARCHAR(100) NOT NULL,
  token_hash    CHAR(64) NOT NULL,        -- SHA-256 of the device token
  is_creator    BOOLEAN NOT NULL DEFAULT FALSE,
  device_label  VARCHAR(100),             -- "Chrome on Windows"; never the raw User-Agent
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_seen_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX group_members_token_hash_key ON group_members (token_hash);
CREATE INDEX group_members_group_name_idx ON group_members (group_id, member_name);

-- Contact submissions table (for admin dashboard)
CREATE TABLE contact_submissions (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100),
  email VARCHAR(100),
  message TEXT,
  submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(20) DEFAULT 'new',
  admin_notes TEXT
);
```

### URL Structure
```
https://comegiftit.com/#abc123xyz
                       ↑
                Unique Group ID
```

### API Endpoints

**Public Endpoints:**

Reads and writes:
- `GET /api/groups/:groupId` — with a member token, the group with claim data stripped from
  the caller's own items, plus `viewer` and `version`. Without one, **metadata only**:
  group name, holiday, event date and member names. No wishlists, no items, no claims.
- `POST /api/groups/:groupId` — create a group, or update one (member token required).
  Still whole-blob; see **How writes work**.
- `POST /api/groups/:groupId/join` — claim a name and receive a device token. Answers
  `name_taken` with an item count and join date when the name is already in use.
- `GET /api/groups/:groupId/members` — member list and device counts. Device labels and
  timestamps are returned to members only.
- `GET /api/groups/:groupId/thank-you` — who bought your gifts. Only answers about the
  caller's own list, and only once the event date has passed.

Item actions — transactional, addressed by stable item id:
- `POST /api/groups/:groupId/items/:itemId/claim` — `409` if someone else holds it
- `POST /api/groups/:groupId/items/:itemId/unclaim`
- `POST /api/groups/:groupId/items/:itemId/purchase` — body `{ purchased }`, or toggles

Group lifecycle:
- `POST /api/groups/:groupId/reset` — creator only; soft delete
- `POST /api/groups/:groupId/undo-reset` — creator only; within 30 days
- `DELETE /api/groups/:groupId` — same as reset, kept for older clients

Other:
- `POST /api/contact` — submit contact form
- `GET /api/health` — health check endpoint

Member tokens travel in an `X-Member-Token` header, never in a query string.

Not yet built (remediation brief 7.2/7.4): granular endpoints for adding, editing and
deleting items, settings, removing a member, and split request/accept. Those paths still
go through `POST /api/groups/:groupId`.

**Admin Endpoints (require authentication):**
- `POST /admin/api/login` - Admin login
- `POST /admin/api/logout` - Admin logout
- `GET /admin/api/stats` - Get system statistics
- `GET /admin/api/groups` - List all groups (with search)
- `GET /admin/api/groups/:groupId` - Get specific group data, unfiltered (powers Observer Mode)
- `DELETE /admin/api/groups/:groupId` - Delete group
- `GET /admin/api/contacts` - List contact submissions
- `PUT /admin/api/contacts/:id` - Update contact status
- `POST /admin/api/cleanup` - Manual cleanup trigger
- `GET /admin` - Admin dashboard page

### Rate Limiting
Limits are keyed on the **member token** where one is present, falling back to IP. A whole
household shares one public IP, so per-IP limits alone would have throttled a family on
Christmas morning. Identified members also get a higher ceiling, since they are a known
participant in one group rather than an anonymous source.

- **Read operations** (GET): 200/minute with a token, 100/minute without
- **Write operations** (POST/DELETE): 120/minute with a token, 30/minute without
- **Group creation**: 10 groups/hour (per IP)
- **Contact form**: 3 submissions/hour
- **Admin login**: 3 attempts/15 minutes
- **General limit**: 1000 requests/15 minutes
- **Polling**: Updates every 10 seconds. There is no ETag / 304 handling and no
  hidden-tab backoff — a background tab polls at the same rate as a visible one.

### Security Features
- Helmet.js for security headers, including a Content Security Policy
- Input validation and length limits on all stored fields
- Output escaping at render time (stored text is never trusted as HTML)
- Parameterised SQL queries
- Rate limiting on all endpoints, keyed on member token where available
- No accounts or passwords; per-device tokens stored only as SHA-256 hashes
- Claim data filtered per viewer server-side, so a recipient cannot read it from the API
- An unidentified caller cannot read wishlists or overwrite an existing group
- Static files served only from `public/`

Known limitation: anyone holding a group's link can open that group. Share
group links only with the people you want in the group.

### Browser Compatibility
- Modern browsers (Chrome, Firefox, Safari, Edge)
- Mobile browsers (iOS Safari, Chrome Mobile)
- Requires JavaScript enabled
- Uses Web Share API when available (mobile)

## 🎨 Customization Ideas

Want to customize? Here are some ideas:
- **Add New Themes**: Edit the `themes` object in the JavaScript
  - Define colors, falling items, and header emojis
  - Example themes: Easter 🐰, Halloween 🎃, Valentine's Day 💘
- **Modify Falling Animations**: Search for `createFallingItems()` function
- **Change Colors**: Update CSS variables for `--primary-color` and `--secondary-color`
- **Add More Price Ranges**: Edit the price dropdown options
- **Custom Priority Levels**: Modify the priority select and badge colors
- **New Event Types**: Add options to the holiday dropdown

## 🐛 Troubleshooting

**Q: Link doesn't work for others?**
- Make sure they're using the full URL including the `#` and group ID
- Check that your Railway app is running
- Verify the PostgreSQL database is connected

**Q: Data disappeared?**
- Groups are automatically deleted after 2 years of inactivity
- Check Railway logs for any database connection issues
- Verify the app hasn't been redeployed without the database

**Q: Can't see others' lists?**
- Make sure everyone is using the SAME link (exact URL with group ID)
- Try refreshing the page
- Check browser console for errors (F12 → Console)

**Q: Changes not showing up for others?**
- Changes update every 10 seconds automatically
- Try refreshing manually if needed
- Check Railway logs for any errors

**Q: Hit rate limits?**
- Read operations: 100/minute
- Write operations: 30/minute
- Wait a minute and try again
- If creating many groups, you're limited to 10/hour

**Q: Contact form not working?**
- Verify Web3Forms access key is configured in `public/index.html`
- Check browser console for errors
- Rate limit: 3 submissions per hour

## 🎁 Future Enhancement Ideas

- Real-time updates via WebSockets (currently polling every 10 seconds)
- Email/SMS notifications when someone claims your item
- Export lists as PDF/CSV
- Import wishlists from Amazon/other sites
- User accounts with profiles and conversation history
- Comment threads on individual items
- Image uploads for gifts
- Budget tracking dashboard per person
- Gift recommendations based on past preferences
- Direct integration with online stores
- Mobile app version (iOS/Android)
- Advanced analytics (most popular items, spending trends)
- Wish list templates (Baby Registry, Wedding Registry, etc.)
- Group chat feature
- Recurring events (save groups for next year)

---

Made with 🌮 and ❤️ for holiday gift giving!
