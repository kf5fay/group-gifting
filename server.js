const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const validator = require('validator');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for Railway deployment
app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
        // ✅ Allow form submissions to Web3Forms
        formAction: ["'self'", "https://api.web3forms.com"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);


// JSON parsing with size limit
app.use(express.json({ limit: '1mb' }));

// Serve static files from public/ only.
// Serving __dirname published server.js, package.json and env.template to
// anyone who guessed the filename.
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting - General protection
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Increased significantly for polling
  // Keyed per member where possible, for the same shared-IP reason as below.
  keyGenerator: (req) => rateLimitKey(req),
  message: { success: false, message: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limit keying (remediation brief 1.11 / 5.8).
//
// Keying on IP alone means a household behind one public IP shares a single
// bucket: at 100 GET/min and a 10-second poll, roughly 16 people on one network
// exhaust the read limit -- a plausible Christmas-morning scenario. Now that
// members carry device tokens we can key on the member instead, and only fall
// back to IP for callers we cannot identify.
//
// The key is a hash of the token, not the token itself, so tokens are not held
// in the limiter's in-memory store.
function rateLimitKey(req) {
  const token = readMemberToken(req);
  if (token) return `member:${hashToken(token)}`;
  return `ip:${req.ip}`;
}

// Identified members get a higher write ceiling: the limit exists to stop
// abuse, and a token-carrying member is a known participant in one group
// rather than an anonymous source.
function writeCeiling(req) {
  return readMemberToken(req) ? 120 : 30;
}

// Lenient rate limit for GET requests (read operations)
const readLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: (req) => (readMemberToken(req) ? 200 : 100),
  keyGenerator: rateLimitKey,
  message: { success: false, message: 'Too many read requests, please slow down.' },
  skip: (req) => req.method !== 'GET' // Only apply to GET requests
});

// Stricter rate limit for write operations (POST, PUT)
const writeLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: writeCeiling,
  keyGenerator: rateLimitKey,
  message: { success: false, message: 'Too many write requests, please slow down.' },
  skip: (req) => req.method === 'GET' // Skip GET requests
});

// Very strict limit for group creation
const groupCreationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: { success: false, message: 'Too many groups created, please try again later.' }
});

// Rate limit for contact form
const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  message: { success: false, message: 'Too many contact submissions, please try again later.' }
});

// Admin login rate limiter
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 3, // 3 attempts per 15 minutes
  message: { success: false, message: 'Too many login attempts' }
});

// Apply general rate limiting to all requests
app.use(generalLimiter);

// PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Database initialization.
// Exposed as a promise so startup work that needs the schema (the cleanup job)
// can wait for it instead of racing it.
const databaseReady = pool.query(`
  CREATE TABLE IF NOT EXISTS groups (
    group_id VARCHAR(255) PRIMARY KEY,
    data JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).then(() => {
  console.log('✅ Database initialized successfully');

  // Create contact_submissions table
  return pool.query(`
    CREATE TABLE IF NOT EXISTS contact_submissions (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100),
      email VARCHAR(100),
      message TEXT,
      submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      status VARCHAR(20) DEFAULT 'new',
      admin_notes TEXT
    )
  `);
}).then(() => {
  console.log('✅ Contact submissions table initialized');

  // Add created_at column to groups table if it doesn't exist (migration for existing databases)
  return pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'groups' AND column_name = 'created_at'
      ) THEN
        ALTER TABLE groups ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
        -- Set created_at to updated_at for existing rows
        UPDATE groups SET created_at = updated_at WHERE created_at IS NULL;
      END IF;
    END $$;
  `);
}).then(() => {
  console.log('✅ Database migration completed (added created_at column if needed)');

  // ---------------------------------------------------------------
  // Phase 2: member identity.
  //
  // Device tokens live here and ONLY here. They must never be written
  // into groups.data -- that blob is serialized to every member on every
  // poll, so anything in it is public to the whole group. This is the same
  // reasoning sanitizeInfoRequest() applies to the anonymous info-request
  // feature.
  // ---------------------------------------------------------------
  return pool.query(`
    CREATE TABLE IF NOT EXISTS group_members (
      id            SERIAL PRIMARY KEY,
      group_id      VARCHAR(255) NOT NULL REFERENCES groups(group_id) ON DELETE CASCADE,
      member_name   VARCHAR(100) NOT NULL,
      token_hash    CHAR(64) NOT NULL,
      is_creator    BOOLEAN NOT NULL DEFAULT FALSE,
      device_label  VARCHAR(100),
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_seen_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}).then(() => {
  // Named explicitly so the statements are idempotent across restarts --
  // an anonymous CREATE INDEX cannot be guarded with IF NOT EXISTS.
  return pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS group_members_token_hash_key
      ON group_members (token_hash)
  `);
}).then(() => {
  return pool.query(`
    CREATE INDEX IF NOT EXISTS group_members_group_name_idx
      ON group_members (group_id, member_name)
  `);
}).then(() => {
  console.log('✅ Member identity table initialized');

  // groups.version -- optimistic locking, consumed in Phase 4. The column is
  // added now so Phase 4 needs no second migration; nothing reads it yet.
  // groups.deleted_at -- soft delete for Reset Group (brief 5.7).
  return pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'groups' AND column_name = 'version'
      ) THEN
        ALTER TABLE groups ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'groups' AND column_name = 'deleted_at'
      ) THEN
        ALTER TABLE groups ADD COLUMN deleted_at TIMESTAMP NULL;
      END IF;
    END $$;
  `);
}).then(() => {
  console.log('✅ Database migration completed (version + deleted_at columns)');

  // A record of one-off data migrations, so they stop re-scanning the table on
  // every restart. Schema changes above are guarded by their own IF NOT EXISTS
  // checks and are cheap; a row-by-row data migration is not.
  return pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       VARCHAR(100) PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}).then(() => {
  return backfillItemIds();
}).catch(err => {
  console.error('❌ Database initialization error:', err);
});

// ---------------------------------------------------------------
// Phase 4 migration: give every stored item a stable, unique id.
//
// Item ids arrived in August 2026. The app has been live since November 2025,
// and groups are kept for two years -- so every group written before then is
// still in this table, holding items with no `id` field at all. The action
// endpoints below address items by id, so on those groups the browser would
// have nothing to put in the URL and Claim would simply be dead.
//
// Relying on the next whole-blob write to mint the ids is not good enough:
// two tabs each holding a pre-id copy mint DIFFERENT ids for the same item, so
// an id handed to one client can be invalidated by another client's save. The
// backfill therefore happens once, here, before anything starts addressing
// items by id.
//
// Idempotent. A group whose items already carry unique, well-formed ids is left
// byte-for-byte alone, so a restart costs one read per group and no writes.
// Soft-deleted groups are included -- they can still be undone (brief 5.7).
//
// NOTE: this deliberately does not touch updated_at. That column drives the
// two-year retention sweep, and a migration must not make every group in the
// table look freshly active.
// ---------------------------------------------------------------
const ITEM_ID_MIGRATION = 'backfill_item_ids_v1';

async function backfillItemIds() {
  const BATCH_SIZE = 100;
  let cursor = '';
  let scanned = 0;
  let groupsChanged = 0;
  let idsAssigned = 0;

  let hadErrors = false;

  try {
    const done = await pool.query(
      'SELECT 1 FROM schema_migrations WHERE name = $1',
      [ITEM_ID_MIGRATION]
    );
    if (done.rowCount > 0) {
      // Already run. Every write since has gone through sanitizeGroupData(),
      // which mints and de-duplicates ids, so there is nothing left to find.
      return;
    }

    for (;;) {
      const page = await pool.query(
        'SELECT group_id FROM groups WHERE group_id > $1 ORDER BY group_id ASC LIMIT $2',
        [cursor, BATCH_SIZE]
      );

      if (page.rows.length === 0) break;

      for (const row of page.rows) {
        const groupId = row.group_id;
        scanned++;

        try {
          const assigned = await withTransaction(async (client) => {
            const current = await client.query(
              'SELECT data FROM groups WHERE group_id = $1 FOR UPDATE',
              [groupId]
            );
            if (current.rows.length === 0) return 0;

            const blob = current.rows[0].data || {};
            const changed = assignMissingItemIds(blob);
            if (changed === 0) return 0;

            await client.query(
              'UPDATE groups SET data = $1 WHERE group_id = $2',
              [JSON.stringify(blob), groupId]
            );
            return changed;
          });

          if (assigned > 0) {
            groupsChanged++;
            idsAssigned += assigned;
          }
        } catch (error) {
          // One unreadable row must not stop the migration for every other
          // group -- but it does mean the run is incomplete, so it is not
          // marked done and will be retried on the next restart.
          hadErrors = true;
          console.error(`Error backfilling item ids for group ${groupId}:`, error);
        }
      }

      cursor = page.rows[page.rows.length - 1].group_id;
    }

    if (hadErrors) {
      console.log(`⚠️  Item id backfill incomplete: ${idsAssigned} ids assigned, some groups failed -- will retry on next start`);
      return;
    }

    await pool.query(
      'INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
      [ITEM_ID_MIGRATION]
    );

    if (groupsChanged > 0) {
      console.log(`✅ Item id backfill: ${idsAssigned} ids assigned across ${groupsChanged} of ${scanned} groups`);
    } else {
      console.log(`✅ Item id backfill: nothing to do (${scanned} groups checked)`);
    }
  } catch (error) {
    console.error('Error running item id backfill:', error);
  }
}

// Admin session storage (in-memory for simplicity)
const adminSessions = new Map(); // sessionToken -> { createdAt, expiresAt }

// Middleware to check admin authentication
function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const token = authHeader.substring(7);
  const session = adminSessions.get(token);

  if (!session || Date.now() > session.expiresAt) {
    adminSessions.delete(token);
    return res.status(401).json({ success: false, message: 'Session expired' });
  }

  next();
}

// Helper function to normalise strings for storage.
//
// This deliberately does NOT strip HTML tags or quote characters. It used to,
// and that silently corrupted ordinary text: "Levi's 501" became "Levis 501",
// 5'10" became 510, "O'Brien" became "OBrien". Stripping on input was also the
// wrong layer -- it bought no safety. Text is now stored raw and escaped at
// render time instead: index.html routes every stored string through
// escapeHtml(), escapeJsAttr() or linkifyText() before it reaches innerHTML.
// That is the only layer of defence now, so it must stay complete.
function sanitizeString(str, maxLength = 500) {
  if (typeof str !== 'string') return '';

  // Trim and limit length. Nothing else -- store what the user actually typed.
  return str.trim().substring(0, maxLength);
}

// Generate a stable id for a wishlist item (used to track anonymous info requests)
function generateItemId() {
  return require('crypto').randomBytes(9).toString('hex');
}

// What a well-formed item id looks like. Accepts both the 18-char hex ids the
// server mints and the UUIDs the client generates. Used in three places that
// must agree: sanitizeGroupData(), the backfill migration, and the :itemId
// route parameter on the action endpoints.
const ITEM_ID_PATTERN = /^[a-zA-Z0-9-]{1,40}$/;

// Item ids address items in the action endpoints (brief 7.2), whose paths carry
// no username -- so an id has to identify ONE item across the whole group, not
// merely within one list. Nothing used to enforce that: the server would
// happily store two items sharing an id, in the same list or in different ones.
// The first item to hold a well-formed id keeps it; anything missing,
// malformed, or colliding gets a fresh one.
function stableItemId(rawId, used) {
  const candidate = typeof rawId === 'string' && ITEM_ID_PATTERN.test(rawId.trim())
    ? rawId.trim()
    : generateItemId();

  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }

  let replacement = generateItemId();
  while (used.has(replacement)) replacement = generateItemId();
  used.add(replacement);
  return replacement;
}

// Give every item in a stored blob a unique id, in place. Returns how many it
// had to change, so a caller can skip the write when there is nothing to do.
//
// Deliberately does NOT run the blob through sanitizeGroupData(): this touches
// live rows written by older versions of the app, and re-normalising them would
// quietly drop or reshape fields that have nothing to do with ids.
function assignMissingItemIds(blob) {
  const users = blob && blob.users;
  if (!users || typeof users !== 'object' || Array.isArray(users)) return 0;

  const used = new Set();
  let changed = 0;

  for (const user of Object.values(users)) {
    if (!user || !Array.isArray(user.items)) continue;

    for (const item of user.items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;

      const current = typeof item.id === 'string' ? item.id.trim() : '';
      if (current && ITEM_ID_PATTERN.test(current) && !used.has(current)) {
        used.add(current);
        if (item.id !== current) {
          item.id = current;
          changed++;
        }
        continue;
      }

      let fresh = generateItemId();
      while (used.has(fresh)) fresh = generateItemId();
      used.add(fresh);
      item.id = fresh;
      changed++;
    }
  }

  return changed;
}

// Sanitize an anonymous "more info requested" marker on an item.
// IMPORTANT: this never stores who asked. The whole group blob is served to every
// member, so recording the requester anywhere in it would break anonymity.
function sanitizeInfoRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return undefined;

  const count = Number(request.count);
  if (!Number.isFinite(count) || count < 1) return undefined;

  const requestedAt = typeof request.lastRequestedAt === 'string' && validator.isISO8601(request.lastRequestedAt)
    ? request.lastRequestedAt
    : new Date().toISOString();

  return {
    count: Math.min(Math.floor(count), 99),
    // Fingerprint of the item's info fields when the request was made, so the
    // notification can clear itself once the owner actually changes the listing.
    signature: sanitizeString(String(request.signature || ''), 64),
    lastRequestedAt: requestedAt
  };
}

// ============================================================
// Member identity (brief section 5)
// ------------------------------------------------------------
// Identity here is claimed on trust, not proven. The server needs to know who
// you are so it can tell two people named John apart and (Phase 3) filter your
// own claim data -- not to defend members against each other. There is
// deliberately no approval flow, no PIN and no recovery mechanism: nobody can
// be locked out, so none of it would have anything to do.
//
// Tokens are 32 random bytes, returned to the client exactly once and stored
// only as a SHA-256 hash in group_members. SHA-256 with no salt or stretching
// is the right choice here: these are high-entropy random values, not
// passwords, so there is no dictionary to run against them.
// ============================================================

const MAX_DEVICES_PER_MEMBER = 5;
const UNDO_WINDOW_DAYS = 30;
// Polling is every 10s; rewriting last_seen_at on each poll would mean a write
// per member per 10 seconds for nothing. Only bump it when it is properly stale.
const LAST_SEEN_REFRESH_MS = 5 * 60 * 1000;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function issueMemberToken() {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, tokenHash: hashToken(token) };
}

// A human-readable device name for the member list (brief 5.6), so a family can
// see when a new device shows up. Deliberately coarse -- the raw User-Agent is
// never stored, only this derived label.
function deviceLabelFromUserAgent(userAgent) {
  const ua = typeof userAgent === 'string' ? userAgent : '';
  if (!ua) return 'Unknown device';

  let browser = 'Browser';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) browser = 'Chrome';
  else if (/Chromium/.test(ua)) browser = 'Chromium';
  else if (/Safari\//.test(ua)) browser = 'Safari';

  let platform = 'device';
  if (/iPhone/.test(ua)) platform = 'iPhone';
  else if (/iPad/.test(ua)) platform = 'iPad';
  else if (/Android/.test(ua)) platform = 'Android';
  else if (/Windows/.test(ua)) platform = 'Windows';
  else if (/Mac OS X|Macintosh/.test(ua)) platform = 'Mac';
  else if (/CrOS/.test(ua)) platform = 'ChromeOS';
  else if (/Linux/.test(ua)) platform = 'Linux';

  return `${browser} on ${platform}`.substring(0, 100);
}

// Tokens travel in a header, never a query string -- query strings end up in
// access logs and Referer headers.
function readMemberToken(req) {
  const token = req.headers['x-member-token'];
  if (typeof token !== 'string') return null;
  const trimmed = token.trim();
  return /^[a-f0-9]{64}$/.test(trimmed) ? trimmed : null;
}

// The name the caller claims to be acting as. Used ONLY for the legacy creator
// fallback in hasCreatorAuthority(), where there is no token to consult. It is
// exactly as trustworthy as the browser-side check it replaces there, and it
// stops mattering the moment the creator claims a device.
function readActingName(req) {
  const raw = req.headers['x-member-name'];
  if (typeof raw !== 'string') return '';
  try {
    return sanitizeString(decodeURIComponent(raw), 100);
  } catch (err) {
    // A malformed percent-escape is not worth a 400; treat it as absent.
    return sanitizeString(raw, 100);
  }
}

function isValidGroupId(groupId) {
  return Boolean(groupId) && groupId.length <= 255 && /^[a-zA-Z0-9-_]+$/.test(groupId);
}

// Resolve a request's token to a member row, scoped to the group being acted
// on. A token for group A is meaningless against group B.
async function resolveMember(db, groupId, token) {
  if (!token) return null;

  const result = await db.query(
    `SELECT id, group_id, member_name, is_creator, device_label, created_at, last_seen_at
       FROM group_members
      WHERE token_hash = $1 AND group_id = $2`,
    [hashToken(token), groupId]
  );

  return result.rows.length > 0 ? result.rows[0] : null;
}

async function touchMember(db, member) {
  if (!member) return;
  const lastSeen = member.last_seen_at ? new Date(member.last_seen_at).getTime() : 0;
  if (Date.now() - lastSeen < LAST_SEEN_REFRESH_MS) return;

  try {
    await db.query(
      'UPDATE group_members SET last_seen_at = CURRENT_TIMESTAMP WHERE id = $1',
      [member.id]
    );
  } catch (error) {
    // Freshness bookkeeping must never fail the request it is attached to.
    console.error('Error updating last_seen_at:', error);
  }
}

// Creator authority, per brief 5.9.
//
// IMPORTANT: this is evaluated PER CHECK, never cached per group. The tempting
// shortcut -- "once any member of this group has claimed a slot, enforce by
// token from then on" -- permanently locks a legacy group in which some
// non-creator returns but the creator never does. The only thing that flips a
// group from name-fallback to token-enforced is the CREATOR's own slot being
// claimed, and that is re-checked on every call.
async function hasCreatorAuthority(db, groupId, blob, member, actingName) {
  // A token that says is_creator is authoritative, always.
  if (member && member.is_creator) return true;

  const createdBy = blob && typeof blob.createdBy === 'string' ? blob.createdBy : '';
  if (!createdBy) return false;

  const claimed = await db.query(
    'SELECT 1 FROM group_members WHERE group_id = $1 AND member_name = $2 LIMIT 1',
    [groupId, createdBy]
  );

  // The creator holds at least one device: their authority is a token now, and
  // a bare name is no longer enough for anyone.
  if (claimed.rowCount > 0) return false;

  // Legacy group whose creator has never returned. Fall back to the name check
  // the browser used to do. No worse than the status quo, and it keeps the
  // group usable rather than stranding it.
  return Boolean(actingName) && actingName === createdBy;
}

// Shape of the "this group was reset" response (brief 5.7): members get a
// state, not a 404.
function resetStatePayload(row, canUndo = false) {
  const deletedAt = new Date(row.deleted_at);
  const undoUntil = new Date(deletedAt.getTime() + UNDO_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return {
    status: 'reset',
    groupName: row.data && row.data.groupName ? row.data.groupName : '',
    resetAt: deletedAt.toISOString(),
    undoAvailableUntil: undoUntil.toISOString(),
    undoAvailable: Date.now() < undoUntil.getTime(),
    // Whether the person reading this can actually press the button. Only the
    // creator can undo, and offering everyone else a control that can only
    // return 403 is just a worse way of saying no.
    canUndo
  };
}

// ============================================================
// Viewer-scoped filtering (brief section 6)
// ------------------------------------------------------------
// The headline promise of this app is that a recipient never finds out who
// claimed their own gifts. Until now that was enforced only by index.html
// declining to render the fields: the whole blob, claim data included, went to
// every member, so opening /api/groups/<id> in a browser tab showed a
// recipient exactly who had bought what for them. The promise was cosmetic.
// It is enforced here now, per viewer, using the Phase 2 token.
// ============================================================

// Everything on an item that would give away who is buying it. Stripped from
// the requesting member's OWN items, and from nobody else's.
//
// infoRequest is deliberately NOT in this list. The owner is meant to see that
// somebody asked for more detail -- that is the entire point of the feature --
// and the stored shape ({count, signature, lastRequestedAt}) records no name
// by design. See sanitizeInfoRequest().
//
// splitRequests does not exist in the data model yet; it arrives in Phase 4.
// It is listed now so that it is impossible to ship that feature and forget
// this file.
const PRIVATE_ITEM_FIELDS = ['claimedBy', 'purchased', 'splitWith', 'splitRequests'];

function filterGroupForViewer(blob, viewerName) {
  // Deep clone before touching anything. pg hands back a fresh object per
  // query today, so this is belt and braces -- but it costs nothing, and the
  // failure mode if that ever stops being true (serving one viewer's mutated
  // blob to the next caller) is the exact bug this section exists to prevent.
  const view = JSON.parse(JSON.stringify(blob || {}));

  const own = view.users && view.users[viewerName];
  if (own && Array.isArray(own.items)) {
    own.items.forEach(item => {
      PRIVATE_ITEM_FIELDS.forEach(field => { delete item[field]; });
    });
  }

  // Retire lapsed split requests for display. This is the clone, so nothing is
  // written here -- the next action on the item persists the same decision.
  Object.values(view.users || {}).forEach(user => {
    if (!user || !Array.isArray(user.items)) return;
    user.items.forEach(item => pruneSplitRequests(item));
  });

  return view;
}

// What a caller holding no token is allowed to know: enough to render the join
// screen, and nothing else (brief 6.3). No wishlists, no items, no claims.
function groupMetadataPayload(blob) {
  const data = blob || {};
  return {
    groupName: typeof data.groupName === 'string' ? data.groupName : '',
    holiday: typeof data.holiday === 'string' ? data.holiday : 'Christmas',
    eventDate: typeof data.eventDate === 'string' ? data.eventDate : '',
    // Names only. The join screen needs them so it can suggest a name that is
    // not already taken. Item counts come from the join endpoint, which at
    // least makes the caller name the member they are asking about.
    memberNames: data.users && typeof data.users === 'object' && !Array.isArray(data.users)
      ? Object.keys(data.users)
      : []
  };
}

// The other half of filtering, and the other half of the concurrency fix.
//
// Writes are still whole-blob outside the action endpoints above, and a client
// only ever holds a FILTERED copy of the group. Two things follow, and this
// function handles both:
//
//  1. The claim fields stripped on the way out would come back missing on the
//     way in and erase themselves -- every member silently wiping the claims on
//     their own list every time they added an item.
//
//  2. A whole-blob write carries a snapshot of EVERYONE's claim state, taken
//     whenever that tab last polled. Writing it back verbatim would undo any
//     claim made in between -- the exact lost update the action endpoints
//     exist to prevent, arriving by a different road.
//
// So claim state is authoritative in storage, and a whole-blob write may change
// it in exactly one way: by adding or removing the WRITER's own participation.
// It can never alter anyone else's claim. That keeps the legacy unilateral
// Split Gift button and any still-cached older client working, while making a
// stale snapshot harmless.
function createItemMatcher(storedItems) {
  const byId = new Map();
  storedItems.forEach(item => {
    if (item && typeof item.id === 'string') byId.set(item.id, item);
  });

  // Items stored before this app had item ids. The startup backfill gives every
  // stored item an id, so this is now only reachable for a row written between
  // that migration and this request -- but it costs little and losing claim
  // data is not a nice way to find out the migration missed something.
  // Description rather than position: adding or deleting an item shifts every
  // index after it.
  const byDescription = new Map();
  storedItems.forEach(item => {
    if (!item || typeof item.id === 'string') return;
    const key = item.description || '';
    if (!byDescription.has(key)) byDescription.set(key, []);
    byDescription.get(key).push(item);
  });

  return function matchStoredItem(item) {
    const byIdMatch = byId.get(item.id);
    if (byIdMatch) return byIdMatch;

    const queue = byDescription.get(item.description || '');
    return queue && queue.length > 0 ? queue.shift() : null;
  };
}

function claimNames(value) {
  return Array.isArray(value)
    ? value.slice(0, 10).map(name => sanitizeString(name, 100)).filter(Boolean)
    : [];
}

function reconcileClaimState(incoming, stored, writerName) {
  if (!writerName) return;

  const incomingUsers = (incoming && incoming.users) || {};
  const storedUsers = (stored && stored.users) || {};

  for (const [ownerName, user] of Object.entries(incomingUsers)) {
    if (!user || !Array.isArray(user.items)) continue;

    const storedOwner = storedUsers[ownerName];
    const matchStoredItem = createItemMatcher(
      storedOwner && Array.isArray(storedOwner.items) ? storedOwner.items : []
    );
    const isOwnList = ownerName === writerName;

    user.items.forEach(item => {
      const previous = matchStoredItem(item);

      if (!previous) {
        // Newly added. Nobody can have claimed an item no one else has seen,
        // and an owner has no business setting claim state on their own list.
        item.claimedBy = [];
        item.purchased = false;
        item.splitWith = [];
        delete item.splitRequests;
        return;
      }

      const storedClaimedBy = claimNames(previous.claimedBy);
      const storedSplitWith = claimNames(previous.splitWith);
      const storedPurchased = Boolean(previous.purchased);

      // Split requests only ever move through their own endpoints, so they are
      // taken from storage for everyone. A whole-blob write can neither forge
      // one nor drop one.
      const storedRequests = splitRequestList(previous);
      if (storedRequests.length > 0) item.splitRequests = storedRequests;
      else delete item.splitRequests;

      if (isOwnList) {
        // The writer was never shown any of this, so whatever arrived is an
        // artefact of the filtering, not an intention.
        item.claimedBy = storedClaimedBy;
        item.splitWith = storedSplitWith;
        item.purchased = storedPurchased;
        return;
      }

      // Somebody else's item: start from storage, then allow only the writer's
      // own participation to move.
      const wantsIn = claimNames(item.claimedBy).includes(writerName);
      const wasIn = storedClaimedBy.includes(writerName);

      if (wantsIn && !wasIn) {
        item.claimedBy = storedClaimedBy.concat(writerName);
        item.splitWith = claimNames(item.splitWith).includes(writerName)
          ? storedSplitWith.concat(writerName)
          : storedSplitWith;
      } else if (!wantsIn && wasIn) {
        item.claimedBy = storedClaimedBy.filter(name => name !== writerName);
        item.splitWith = storedSplitWith.filter(name => name !== writerName);
      } else {
        item.claimedBy = storedClaimedBy;
        item.splitWith = storedSplitWith;
      }

      // `purchased` is shared state -- only someone actually buying the gift
      // may move it.
      item.purchased = item.claimedBy.includes(writerName)
        ? Boolean(item.purchased)
        : storedPurchased;
      if (item.claimedBy.length === 0) item.purchased = false;
    });
  }
}

// Removing a member has to take their claims with them. The frontend does this
// too, but it cannot touch claims on the ACTING member's own items -- those are
// filtered out of the copy it holds, and restored above from storage -- so the
// authoritative pass has to happen here.
function scrubNamesFromClaims(blob, names) {
  if (!names || names.length === 0) return;
  const removed = new Set(names);

  Object.values((blob && blob.users) || {}).forEach(user => {
    if (!user || !Array.isArray(user.items)) return;
    user.items.forEach(item => {
      if (Array.isArray(item.claimedBy)) {
        item.claimedBy = item.claimedBy.filter(name => !removed.has(name));
      }
      if (Array.isArray(item.splitWith)) {
        item.splitWith = item.splitWith.filter(name => !removed.has(name));
      }
    });
  });
}

// Gap 1, on the whole-blob write path.
//
// Until the granular endpoints existed, Phase 2 could only gate the two
// destructive shapes of a blob write -- removing a member, and rewriting who
// the creator is -- and everything else went through. That left any member able
// to rename the group or rewrite, or delete, somebody else's wishlist item, by
// posting a blob that said so.
//
// The rule now is the same one the granular handlers enforce: a write may only
// change what its author is allowed to change. Anything else is taken from
// storage rather than refused, because the callers that reach this are stale
// tabs and hand-made requests, and quietly keeping the stored truth is a better
// answer to both than a 403. The real client no longer edits anything through
// this path.
//
// Runs AFTER the creator gate, so a non-creator's attempt to remove a member is
// still an explicit 403 rather than being silently smoothed over.
function enforceWriteAuthority(incoming, stored, writerName, isCreator) {
  if (isCreator) return;

  const storedUsers = (stored && stored.users) || {};

  // Group settings belong to the creator.
  if (typeof stored.groupName === 'string') incoming.groupName = stored.groupName;
  if (typeof stored.holiday === 'string') incoming.holiday = stored.holiday;
  if (stored.eventDate !== undefined) incoming.eventDate = stored.eventDate;
  if (typeof stored.createdBy === 'string' && stored.createdBy) incoming.createdBy = stored.createdBy;

  if (!incoming.users || typeof incoming.users !== 'object') incoming.users = {};

  // A blob write cannot invent members. Joining is the only way in.
  Object.keys(incoming.users).forEach(name => {
    if (name !== writerName && !storedUsers[name]) delete incoming.users[name];
  });

  // Everyone else's list is rebuilt from storage: same items, same order, same
  // text. The only things carried over from the incoming copy are the ones
  // reconcileClaimState() has already decided this writer may move -- their own
  // participation in a claim, and the anonymous info-request marker.
  Object.entries(storedUsers).forEach(([ownerName, storedUser]) => {
    if (ownerName === writerName) return;

    const incomingUser = incoming.users[ownerName];
    const reconciled = new Map();
    if (incomingUser && Array.isArray(incomingUser.items)) {
      incomingUser.items.forEach(item => {
        if (item && typeof item.id === 'string') reconciled.set(item.id, item);
      });
    }

    const items = (Array.isArray(storedUser.items) ? storedUser.items : []).map(storedItem => {
      const rebuilt = Object.assign({}, storedItem);
      const fromWriter = reconciled.get(storedItem.id);
      if (!fromWriter) return rebuilt;

      rebuilt.claimedBy = fromWriter.claimedBy;
      rebuilt.purchased = fromWriter.purchased;
      rebuilt.splitWith = fromWriter.splitWith;

      if (fromWriter.infoRequest !== undefined) rebuilt.infoRequest = fromWriter.infoRequest;
      else delete rebuilt.infoRequest;

      return rebuilt;
    });

    incoming.users[ownerName] = { items };
  });
}

// Has the group's event happened yet?
//
// This is the one condition under which a member is allowed to learn who
// bought their gifts (the thank-you list). index.html has always shown that
// button from the day after the event; the difference now is that the rule is
// enforced where it cannot be edited out with devtools. Event dates are plain
// YYYY-MM-DD, which parses as UTC midnight, so the reveal opens 24 hours after
// that -- deliberately the conservative side of the frontend's local-midnight
// comparison. A recipient waiting a few extra hours is a non-event; the
// opposite mistake is the bug this whole phase is about.
function eventHasPassed(eventDate) {
  if (typeof eventDate !== 'string' || !eventDate) return false;
  const event = new Date(eventDate);
  if (isNaN(event.getTime())) return false;
  return Date.now() > event.getTime() + 24 * 60 * 60 * 1000;
}

// Helper function to validate and sanitize group data
function validateGroupData(data) {
  const errors = [];
  
  // Validate group name
  if (!data.groupName || typeof data.groupName !== 'string') {
    errors.push('Group name is required');
  } else if (data.groupName.length > 100) {
    errors.push('Group name too long (max 100 characters)');
  }
  
  // Validate holiday type
  const validHolidays = ['Christmas', 'Birthday', 'Hanukkah', 'Anniversary', 'Other'];
  if (data.holiday && !validHolidays.includes(data.holiday)) {
    errors.push('Invalid holiday type');
  }
  
  // Validate event date
  if (data.eventDate && !validator.isISO8601(data.eventDate)) {
    errors.push('Invalid event date format');
  }
  
  // Validate users object
  if (!data.users || typeof data.users !== 'object' || Array.isArray(data.users)) {
    errors.push('Users must be an object');
  } else {
    // Validate each user
    const usernames = Object.keys(data.users);
    if (usernames.length > 50) {
      errors.push('Too many users (max 50)');
    }
    
    for (const username of usernames) {
      if (username.length > 100) {
        errors.push(`Username too long: ${username}`);
      }
      
      const user = data.users[username];
      if (!user.items || !Array.isArray(user.items)) {
        errors.push(`Invalid items for user: ${username}`);
      } else if (user.items.length > 100) {
        errors.push(`Too many items for user ${username} (max 100)`);
      } else {
        // Validate each item
        for (const item of user.items) {
          const itemName = item.description || item.item || item.name || '';
          if (!itemName || typeof itemName !== 'string') {
            errors.push(`Item missing description for user: ${username}`);
          } else if (itemName.length > 500) {
            errors.push(`Item description too long for user: ${username}`);
          }
          
          if (item.details && typeof item.details === 'string' && item.details.length > 1000) {
            errors.push(`Item details too long for user: ${username}`);
          }
          
          if (item.notes && typeof item.notes === 'string' && item.notes.length > 1000) {
            errors.push(`Item notes too long for user: ${username}`);
          }
          
          if (item.claimedBy && !Array.isArray(item.claimedBy)) {
            errors.push(`claimedBy must be an array for user: ${username}`);
          }

          if (item.infoRequest !== undefined && item.infoRequest !== null &&
              (typeof item.infoRequest !== 'object' || Array.isArray(item.infoRequest))) {
            errors.push(`infoRequest must be an object for user: ${username}`);
          }
        }
      }
    }
  }
  
  return errors;
}

// Helper function to sanitize group data
function sanitizeGroupData(data) {
  const sanitized = {
    groupName: sanitizeString(data.groupName, 100),
    holiday: data.holiday && ['Christmas', 'Birthday', 'Hanukkah', 'Anniversary', 'Other'].includes(data.holiday) 
      ? data.holiday 
      : 'Christmas',
    eventDate: data.eventDate || '',
    createdBy: data.createdBy ? sanitizeString(data.createdBy, 100) : '',
    users: {}
  };
  
  // Sanitize users
  if (data.users && typeof data.users === 'object') {
    const usernames = Object.keys(data.users).slice(0, 50);

    // Shared across every list in the group, not per user: the action endpoints
    // look an item up by id alone.
    const usedItemIds = new Set();
    
    for (const username of usernames) {
      const cleanUsername = sanitizeString(username, 100);
      const user = data.users[username];
      
      sanitized.users[cleanUsername] = {
        items: Array.isArray(user.items) 
          ? user.items.slice(0, 100).map(item => ({
              // Item ids are machine-generated identifiers, not user prose, so
              // the charset is validated here rather than left to
              // sanitizeString (which no longer strips anything). Collisions
              // get a fresh id -- see stableItemId().
              id: stableItemId(item.id, usedItemIds),
              description: sanitizeString(item.description || item.item || item.name || '', 500),
              priority: item.priority && ['high', 'medium', 'low'].includes(item.priority) 
                ? item.priority 
                : 'medium',
              price: item.price ? sanitizeString(String(item.price), 20) : '',
              notes: item.notes ? sanitizeString(item.notes, 1000) : '',
              details: item.details ? sanitizeString(item.details, 1000) : '',
              claimedBy: Array.isArray(item.claimedBy) 
                ? item.claimedBy.slice(0, 10).map(name => sanitizeString(name, 100))
                : [],
              purchased: Boolean(item.purchased),
              splitWith: Array.isArray(item.splitWith)
                ? item.splitWith.slice(0, 10).map(name => sanitizeString(name, 100))
                : [],
              infoRequest: sanitizeInfoRequest(item.infoRequest)
            }))
          : []
      };
    }
  }
  
  return sanitized;
}

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ 
      success: true, 
      message: 'Server and database healthy',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: 'Database connection error' 
    });
  }
});

// ---------------------------------------------------------------
// Every group response is scoped to one viewer: the same URL returns different
// bodies to different members, because claim data on your own items is stripped
// out. A shared cache keying on URL alone could therefore hand one member's
// body to another, which would invert the whole of Phase 3.
//
// Express already emits body-derived ETags, so a conditional request from the
// wrong viewer does not currently produce a 304. That is luck, not a design:
// it holds only because the bodies happen to differ. These two headers make it
// a rule -- no-store keeps shared caches from keeping the body at all, and Vary
// says the token is part of the cache key for anything that ignores no-store.
// Admin responses are unfiltered group data and get the same treatment.
// ---------------------------------------------------------------
function noSharedCaching(req, res, next) {
  res.set('Cache-Control', 'private, no-store');
  res.set('Vary', 'X-Member-Token');
  next();
}

app.use('/api/groups', noSharedCaching);
app.use('/admin/api', noSharedCaching);

// Run fn inside a transaction, handing it a dedicated client.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Rollback failed:', rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

// GET group data
app.get('/api/groups/:groupId', readLimiter, async (req, res) => {
  try {
    const groupId = req.params.groupId;

    // Validate groupId format
    if (!isValidGroupId(groupId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid group ID format'
      });
    }

    const result = await pool.query(
      'SELECT data, deleted_at, version FROM groups WHERE group_id = $1',
      [groupId]
    );

    if (result.rows.length === 0) {
      return res.json({ success: true, data: null });
    }

    const row = result.rows[0];

    // A soft-deleted group is a state, not a 404: members who still have the
    // link get told it was reset, and the creator gets an undo affordance.
    if (row.deleted_at) {
      const resetToken = readMemberToken(req);
      const resetMember = resetToken ? await resolveMember(pool, groupId, resetToken) : null;
      const canUndo = await hasCreatorAuthority(
        pool, groupId, row.data || {}, resetMember, readActingName(req)
      );
      return res.json({ success: true, data: null, reset: resetStatePayload(row, canUndo) });
    }

    const token = readMemberToken(req);

    // Brief 6.3: no token, no wishlists. A caller who holds the link but has
    // not joined gets the group's name, holiday, date and member names -- all
    // the join screen needs -- and nothing else. This closes the "paste the
    // API URL into a tab" leak completely for non-members.
    if (!token) {
      return res.json({
        success: true,
        access: 'metadata',
        data: null,
        meta: groupMetadataPayload(row.data)
      });
    }

    const member = await resolveMember(pool, groupId, token);
    if (!member) {
      // Let the client heal itself (re-join with its stored name) rather than
      // silently demoting it to an anonymous viewer forever.
      return res.status(401).json({
        success: false,
        code: 'invalid_token',
        message: 'This device is no longer recognised for this group.'
      });
    }
    await touchMember(pool, member);

    // Brief 6.2: this is the fix for the headline bug. The blob goes out with
    // every claim, purchase and split stripped from THIS member's own items,
    // and everyone else's left intact.
    //
    // NOTE: no token material is ever in here -- hashes live only in
    // group_members, and `viewer` carries a name and a boolean.
    res.json({
      success: true,
      access: 'member',
      data: filterGroupForViewer(row.data, member.member_name),
      viewer: { memberName: member.member_name, isCreator: member.is_creator },
      // The row's version as of this read. Action endpoints return the version
      // their write produced, so a client can tell a stale poll from a fresh one.
      version: row.version
    });
  } catch (error) {
    console.error('Error loading group:', error);
    res.status(500).json({
      success: false,
      message: 'Error loading group data'
    });
  }
});

// ---------------------------------------------------------------
// Join a group / claim a name (brief 5.3)
// ---------------------------------------------------------------
app.post('/api/groups/:groupId/join', writeLimiter, async (req, res) => {
  try {
    const groupId = req.params.groupId;

    if (!isValidGroupId(groupId)) {
      return res.status(400).json({ success: false, message: 'Invalid group ID format' });
    }

    const name = sanitizeString(req.body && req.body.name, 100);
    if (!name) {
      return res.status(400).json({ success: false, message: 'Please enter your name' });
    }

    const confirmExisting = Boolean(req.body && req.body.confirmExisting);
    const deviceLabel = deviceLabelFromUserAgent(req.headers['user-agent']);

    const payload = await withTransaction(async (client) => {
      const groupResult = await client.query(
        'SELECT data, deleted_at FROM groups WHERE group_id = $1 FOR UPDATE',
        [groupId]
      );

      if (groupResult.rows.length === 0) {
        return { httpStatus: 404, body: { success: false, message: 'Group not found' } };
      }

      const row = groupResult.rows[0];
      if (row.deleted_at) {
        return { httpStatus: 410, body: { success: true, reset: resetStatePayload(row) } };
      }

      const blob = row.data || {};
      const existing = await client.query(
        `SELECT id, is_creator, created_at, last_seen_at
           FROM group_members
          WHERE group_id = $1 AND member_name = $2
          ORDER BY last_seen_at ASC, id ASC`,
        [groupId, name]
      );

      // The name is already claimed and the user has not told us it is them.
      // Item COUNT and join date only -- never item names. A stranger must not
      // be able to read a wishlist off the join screen.
      if (existing.rowCount > 0 && !confirmExisting) {
        const user = blob.users && blob.users[name];
        const itemCount = user && Array.isArray(user.items) ? user.items.length : 0;
        const joinedAt = existing.rows
          .map(r => new Date(r.created_at).getTime())
          .reduce((a, b) => Math.min(a, b));

        return {
          httpStatus: 200,
          body: {
            success: true,
            status: 'name_taken',
            name,
            itemCount,
            deviceCount: existing.rowCount,
            joinedAt: new Date(joinedAt).toISOString()
          }
        };
      }

      // Brief 5.9: a member with no rows is unclaimed, and the first device to
      // join under that name claims it. That is just the normal join path --
      // there is no special-case migration code, by design.
      const isFirstClaim = existing.rowCount === 0;
      let isCreator = false;
      let blobChanged = false;

      if (isFirstClaim) {
        if (!blob.createdBy) {
          // Brand new group: whoever joins first is the creator.
          blob.createdBy = name;
          blobChanged = true;
          isCreator = true;
        } else if (blob.createdBy === name) {
          // Legacy group: createdBy is a bare name with no row behind it.
          // This is the creator's slot being claimed for the first time.
          isCreator = true;
        }
      } else {
        // Another device for a member who already exists. Creator-ness is a
        // property of the member, so every device of the creator carries it.
        isCreator = existing.rows.some(r => r.is_creator);

        // Device cap (brief 5.1): evict the least recently seen.
        if (existing.rowCount >= MAX_DEVICES_PER_MEMBER) {
          const surplus = existing.rowCount - MAX_DEVICES_PER_MEMBER + 1;
          const evictIds = existing.rows.slice(0, surplus).map(r => r.id);
          await client.query('DELETE FROM group_members WHERE id = ANY($1::int[])', [evictIds]);
        }
      }

      // Make sure the blob knows about the member. Doing this here, in the same
      // transaction that creates the row, avoids a window where a member row
      // exists but the next poll-and-save from another device writes the member
      // (or createdBy) straight back out of the blob.
      if (!blob.users || typeof blob.users !== 'object' || Array.isArray(blob.users)) {
        blob.users = {};
        blobChanged = true;
      }
      if (!blob.users[name]) {
        blob.users[name] = { items: [] };
        blobChanged = true;
      }

      const { token, tokenHash } = issueMemberToken();
      await client.query(
        `INSERT INTO group_members (group_id, member_name, token_hash, is_creator, device_label)
         VALUES ($1, $2, $3, $4, $5)`,
        [groupId, name, tokenHash, isCreator, deviceLabel]
      );

      // Brief 5.9: when the creator's slot is first claimed, mark it. Covers the
      // case where the creator's own second device arrives before we knew.
      if (isCreator) {
        await client.query(
          'UPDATE group_members SET is_creator = TRUE WHERE group_id = $1 AND member_name = $2',
          [groupId, name]
        );
      }

      // Only rewrite the blob if joining actually changed it. An extra device
      // for an existing member changes nothing in there, and a no-op write
      // would needlessly re-normalise a legacy group's stored JSON.
      if (blobChanged) {
        await client.query(
          'UPDATE groups SET data = $1, updated_at = CURRENT_TIMESTAMP WHERE group_id = $2',
          [JSON.stringify(sanitizeGroupData(blob)), groupId]
        );
      }

      return {
        httpStatus: 200,
        body: {
          success: true,
          // The token is returned exactly once, here. Only its hash is stored.
          status: isFirstClaim ? 'joined' : 'joined_additional_device',
          token,
          name,
          isCreator,
          deviceLabel
        }
      };
    });

    res.status(payload.httpStatus).json(payload.body);
  } catch (error) {
    console.error('Error joining group:', error);
    res.status(500).json({ success: false, message: 'Error joining group' });
  }
});

// ---------------------------------------------------------------
// Member list, for the transparency requirement (brief 5.6)
//
// Selects columns explicitly. token_hash is never one of them.
// ---------------------------------------------------------------
app.get('/api/groups/:groupId/members', readLimiter, async (req, res) => {
  try {
    const groupId = req.params.groupId;

    if (!isValidGroupId(groupId)) {
      return res.status(400).json({ success: false, message: 'Invalid group ID format' });
    }

    // Device labels and timestamps are for the group to police itself with
    // (brief 5.6), so they go to members only. A caller with no token gets the
    // same names the join screen already shows it and nothing more, in keeping
    // with 6.3.
    const token = readMemberToken(req);
    const viewer = token ? await resolveMember(pool, groupId, token) : null;

    const result = await pool.query(
      `SELECT member_name, is_creator, device_label, created_at, last_seen_at
         FROM group_members
        WHERE group_id = $1
        ORDER BY member_name ASC, created_at ASC`,
      [groupId]
    );

    const byName = new Map();
    for (const row of result.rows) {
      if (!byName.has(row.member_name)) {
        byName.set(row.member_name, {
          name: row.member_name,
          isCreator: false,
          deviceCount: 0,
          devices: []
        });
      }
      const entry = byName.get(row.member_name);
      entry.isCreator = entry.isCreator || row.is_creator;
      entry.deviceCount += 1;
      if (viewer) {
        entry.devices.push({
          label: row.device_label || 'Unknown device',
          joinedAt: row.created_at,
          lastSeenAt: row.last_seen_at
        });
      }
    }

    res.json({ success: true, members: Array.from(byName.values()) });
  } catch (error) {
    console.error('Error loading members:', error);
    res.status(500).json({ success: false, message: 'Error loading members' });
  }
});

// ---------------------------------------------------------------
// The thank-you list (brief 6.2, existing feature)
//
// This is the single place a member is meant to learn who bought their gifts,
// and only once the event has actually happened. It used to work by reading
// claim data straight out of the blob every member already had, with the
// button hidden until the event date -- which made the reveal exactly as
// cosmetic as the surprise it was breaking. Claim data on your own items no
// longer leaves the server, so the reveal needs its own endpoint, and the date
// check that used to be a piece of UI is now the actual rule.
//
// Only ever answers about the CALLER's own list. There is no parameter for
// whose list to read, deliberately.
// ---------------------------------------------------------------
app.get('/api/groups/:groupId/thank-you', readLimiter, async (req, res) => {
  try {
    const groupId = req.params.groupId;

    if (!isValidGroupId(groupId)) {
      return res.status(400).json({ success: false, message: 'Invalid group ID format' });
    }

    const token = readMemberToken(req);
    const member = token ? await resolveMember(pool, groupId, token) : null;

    if (!member) {
      return res.status(401).json({
        success: false,
        code: token ? 'invalid_token' : 'auth_required',
        message: 'This device is not signed in to the group.'
      });
    }

    const result = await pool.query(
      'SELECT data, deleted_at FROM groups WHERE group_id = $1',
      [groupId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }

    const row = result.rows[0];
    if (row.deleted_at) {
      return res.json({ success: true, reset: resetStatePayload(row) });
    }

    const blob = row.data || {};

    if (!eventHasPassed(blob.eventDate)) {
      // No gift data in this response. Not "an empty list" -- nothing at all.
      return res.json({
        success: true,
        available: false,
        reason: blob.eventDate ? 'event_upcoming' : 'no_event_date'
      });
    }

    const own = blob.users && blob.users[member.member_name];
    const items = own && Array.isArray(own.items) ? own.items : [];

    const gifts = items
      .filter(item => item && item.purchased && Array.isArray(item.claimedBy) && item.claimedBy.length > 0)
      .map(item => ({
        description: item.description || '',
        price: item.price || '',
        buyers: item.claimedBy.slice(0, 10)
      }));

    res.json({ success: true, available: true, gifts });
  } catch (error) {
    console.error('Error loading thank-you list:', error);
    res.status(500).json({ success: false, message: 'Error loading your thank-you list' });
  }
});

// ===============================================================
// Granular action endpoints (brief 7.2) -- claim, unclaim, purchase
// ---------------------------------------------------------------
// Every action used to serialize the whole group and POST it, while clients
// replaced their local state every 10 seconds. Two people acting inside the
// same window meant one change vanished with no error -- and the shape that
// takes in this app is two people buying the same gift, which is precisely
// what the product exists to prevent.
//
// These handlers read, modify and write inside ONE transaction with the group
// row locked, so the server decides who got there first, and the loser is told.
// Items are addressed by their stable id, never by array index: indices move
// under concurrent edits, which is the same bug wearing a different hat.
// ===============================================================

// Locate an item anywhere in the group. The endpoint paths carry no username
// -- an id identifies one item across the whole group, an invariant held by
// stableItemId() on write and by the startup backfill for older rows.
function findItemById(blob, itemId) {
  const users = (blob && blob.users) || {};

  for (const [ownerName, user] of Object.entries(users)) {
    if (!user || !Array.isArray(user.items)) continue;

    const index = user.items.findIndex(item => item && item.id === itemId);
    if (index !== -1) return { ownerName, item: user.items[index], index };
  }

  return null;
}

// ---------------------------------------------------------------
// Split requests (brief 7.4)
// ---------------------------------------------------------------
// Splitting used to be unilateral: you clicked a button and joined someone
// else's claim whether they liked it or not. Now Bob asks and Mary answers.
//
// These live on the item, inside the blob, and are stripped for the item's
// OWNER along with the rest of the claim data (PRIVATE_ITEM_FIELDS). Unlike
// the anonymous info-request, the claimer *does* see who is asking -- Mary
// needs to know it is Bob before she can decide.
const SPLIT_REQUEST_TTL_DAYS = 30;
const MAX_SPLIT_ATTEMPTS_PER_ITEM = 2;   // one ask, and one more after a decline

function splitRequestList(item) {
  return Array.isArray(item && item.splitRequests) ? item.splitRequests : [];
}

function sanitizeSplitRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null;

  const id = typeof request.id === 'string' && ITEM_ID_PATTERN.test(request.id.trim())
    ? request.id.trim()
    : null;
  const from = sanitizeString(request.from, 100);
  if (!id || !from) return null;

  const status = ['pending', 'accepted', 'declined', 'expired'].includes(request.status)
    ? request.status
    : 'pending';

  return {
    id,
    from,
    to: sanitizeString(request.to, 100),
    status,
    requestedAt: typeof request.requestedAt === 'string' && validator.isISO8601(request.requestedAt)
      ? request.requestedAt
      : new Date().toISOString(),
    // Set when the claimer answers, so the asker can be told once and then
    // dismiss it.
    respondedAt: typeof request.respondedAt === 'string' && validator.isISO8601(request.respondedAt)
      ? request.respondedAt
      : undefined
  };
}

// Retire pending requests that can no longer be answered: too old, or the item
// is no longer in a state where splitting means anything (brief 7.4). Returns
// true when something changed, so callers know whether they need to write.
//
// Answered requests are kept. Bob has to be told he was declined, and the
// attempt cap needs to remember the ask happened.
function pruneSplitRequests(item, now = Date.now()) {
  const requests = splitRequestList(item);
  if (requests.length === 0) return false;

  const claimedBy = Array.isArray(item.claimedBy) ? item.claimedBy : [];
  const noLongerSplittable = claimedBy.length === 0 || Boolean(item.purchased);
  let changed = false;

  requests.forEach(request => {
    if (request.status !== 'pending') return;

    const age = now - new Date(request.requestedAt).getTime();
    if (noLongerSplittable || !(age < SPLIT_REQUEST_TTL_DAYS * 24 * 60 * 60 * 1000)) {
      request.status = 'expired';
      request.respondedAt = new Date(now).toISOString();
      changed = true;
    }
  });

  return changed;
}

// Keep the claim fields well-formed. These handlers write into the stored blob
// directly rather than through sanitizeGroupData(), so the normalising that
// function would have done has to happen here.
function normalizeClaimFields(item) {
  item.claimedBy = Array.isArray(item.claimedBy)
    ? item.claimedBy.slice(0, 10).map(name => sanitizeString(name, 100)).filter(Boolean)
    : [];
  item.splitWith = Array.isArray(item.splitWith)
    ? item.splitWith.slice(0, 10).map(name => sanitizeString(name, 100)).filter(Boolean)
    : [];
  item.purchased = Boolean(item.purchased);

  // An item nobody is claiming cannot be purchased. Without this an unclaim
  // would leave a "PURCHASED" badge with no buyer behind it.
  if (item.claimedBy.length === 0) item.purchased = false;

  const requests = splitRequestList(item)
    .slice(0, 20)
    .map(sanitizeSplitRequest)
    .filter(Boolean);

  if (requests.length > 0) item.splitRequests = requests;
  else delete item.splitRequests;
}

// What an actor is told about an item after acting on it. Only ever returned
// to someone who is NOT the item's owner, so full claim state is fine here --
// owners are refused these endpoints outright.
function claimStatePayload(item) {
  return {
    id: item.id,
    claimedBy: Array.isArray(item.claimedBy) ? item.claimedBy : [],
    purchased: Boolean(item.purchased),
    splitWith: Array.isArray(item.splitWith) ? item.splitWith : [],
    splitRequests: splitRequestList(item)
  };
}

// Shared scaffolding for every granular write.
//
// Opens one transaction, locks the group row, resolves the caller, hands the
// live blob to `handler`, and writes only if the handler says something
// changed. Every write bumps groups.version and updated_at.
//
// `handler` returns { httpStatus, body } to answer without writing, or adds
// `changed: true` to have the result persisted.
async function runGroupMutation(req, res, handler) {
  const groupId = req.params.groupId;

  if (!isValidGroupId(groupId)) {
    return res.status(400).json({ success: false, message: 'Invalid group ID format' });
  }

  const token = readMemberToken(req);

  try {
    const payload = await withTransaction(async (client) => {
      const groupResult = await client.query(
        'SELECT data, deleted_at, version FROM groups WHERE group_id = $1 FOR UPDATE',
        [groupId]
      );

      if (groupResult.rows.length === 0) {
        return { httpStatus: 404, body: { success: false, message: 'Group not found' } };
      }

      const row = groupResult.rows[0];
      if (row.deleted_at) {
        return { httpStatus: 409, body: { success: false, code: 'group_reset', reset: resetStatePayload(row) } };
      }

      const member = token ? await resolveMember(client, groupId, token) : null;
      if (!member) {
        return {
          httpStatus: 401,
          body: {
            success: false,
            code: token ? 'invalid_token' : 'auth_required',
            message: 'This device is not signed in to the group.'
          }
        };
      }

      const blob = row.data || {};
      const outcome = await handler({ blob, member, client, groupId, row, req });

      // A response that writes nothing still reports where the group stands, so
      // a client can tell an idempotent no-op from a stale view.
      if (!outcome.changed) {
        return Object.assign({ member }, outcome, {
          body: Object.assign({}, outcome.body, { version: row.version })
        });
      }

      const updated = await client.query(
        `UPDATE groups
            SET data = $1, version = version + 1, updated_at = CURRENT_TIMESTAMP
          WHERE group_id = $2
        RETURNING version`,
        [JSON.stringify(blob), groupId]
      );

      return {
        httpStatus: outcome.httpStatus || 200,
        member,
        body: Object.assign({ success: true }, outcome.body, { version: updated.rows[0].version })
      };
    });

    // Freshness bookkeeping, outside the transaction: never a reason to roll a
    // member's write back.
    if (payload.member) await touchMember(pool, payload.member);

    res.status(payload.httpStatus).json(payload.body);
  } catch (error) {
    console.error('Error applying group write:', error);
    res.status(500).json({ success: false, message: 'Could not apply that change' });
  }
}

// Resolve :itemId and hand the item to `apply`, which returns one of:
//   { changed: true }                     -- write it
//   { unchanged: true }                   -- already in the desired state
//   { conflict: 'code', message: '...' }  -- somebody got there first (409)
//
// `allowOwner` decides whether the item's own owner may use the endpoint. The
// claim actions say no -- nobody coordinates gifts on their own list, and
// letting an owner touch them would turn these into a way to ask whether your
// own gift has been claimed, the question Phase 3 exists to refuse.
async function runItemAction(req, res, apply, { allowOwner = false } = {}) {
  const itemId = req.params.itemId;

  if (typeof itemId !== 'string' || !ITEM_ID_PATTERN.test(itemId)) {
    return res.status(400).json({ success: false, message: 'Invalid item ID format' });
  }

  return runGroupMutation(req, res, async ({ blob, member, client, groupId }) => {
    const found = findItemById(blob, itemId);

    if (!found) {
      // Deleted, or this client is looking at a copy of the group from before
      // it was. Either way the answer is the same: re-read.
      return {
        httpStatus: 404,
        body: {
          success: false,
          code: 'item_not_found',
          message: 'That item is no longer on the list.'
        }
      };
    }

    const isOwner = found.ownerName === member.member_name;

    if (isOwner && !allowOwner) {
      return {
        httpStatus: 403,
        body: {
          success: false,
          code: 'own_item',
          message: 'You cannot claim gifts on your own wishlist.'
        }
      };
    }

    const outcome = await apply(found.item, member, req.body || {}, {
      ownerName: found.ownerName,
      isOwner,
      blob,
      client,
      groupId,
      index: found.index
    });

    if (outcome.conflict) {
      return {
        httpStatus: 409,
        body: {
          success: false,
          code: outcome.conflict,
          message: outcome.message,
          item: claimStatePayload(found.item)
        }
      };
    }

    if (outcome.forbidden) {
      return {
        httpStatus: 403,
        body: { success: false, code: outcome.forbidden, message: outcome.message }
      };
    }

    if (outcome.unchanged) {
      // Idempotent: a double tap, or a retry after a dropped response, is
      // not an error and does not deserve a write.
      return { httpStatus: 200, body: { success: true, item: claimStatePayload(found.item) } };
    }

    normalizeClaimFields(found.item);

    return {
      changed: true,
      body: outcome.body || { item: claimStatePayload(found.item) }
    };
  });
}

// Claim an item. This is the check the whole phase is for: if somebody else
// already holds it, the second person is told, rather than silently winning.
app.post('/api/groups/:groupId/items/:itemId/claim', writeLimiter, async (req, res) => {
  await runItemAction(req, res, (item, member) => {
    const claimedBy = Array.isArray(item.claimedBy) ? item.claimedBy : [];

    if (claimedBy.includes(member.member_name)) return { unchanged: true };

    if (claimedBy.length > 0) {
      return {
        conflict: 'already_claimed',
        message: 'Someone just claimed this gift.'
      };
    }

    item.claimedBy = [member.member_name];
    return { changed: true };
  });
});

// Give up a claim. Removes only the caller -- on a split gift the other
// claimers keep theirs.
app.post('/api/groups/:groupId/items/:itemId/unclaim', writeLimiter, async (req, res) => {
  await runItemAction(req, res, (item, member) => {
    const claimedBy = Array.isArray(item.claimedBy) ? item.claimedBy : [];
    if (!claimedBy.includes(member.member_name)) return { unchanged: true };

    item.claimedBy = claimedBy.filter(name => name !== member.member_name);
    item.splitWith = Array.isArray(item.splitWith)
      ? item.splitWith.filter(name => name !== member.member_name)
      : [];

    return { changed: true };
  });
});

// Mark a gift bought, or un-mark it. Toggles when the body says nothing, so the
// endpoint matches the brief; the client sends the state it wants explicitly,
// which keeps a double tap from undoing itself.
app.post('/api/groups/:groupId/items/:itemId/purchase', writeLimiter, async (req, res) => {
  await runItemAction(req, res, (item, member, body) => {
    const claimedBy = Array.isArray(item.claimedBy) ? item.claimedBy : [];

    if (!claimedBy.includes(member.member_name)) {
      return {
        conflict: 'not_claimed_by_you',
        message: claimedBy.length > 0
          ? 'Someone else is buying this one now.'
          : 'Claim this gift before marking it bought.'
      };
    }

    const desired = typeof body.purchased === 'boolean' ? body.purchased : !item.purchased;
    if (Boolean(item.purchased) === desired) return { unchanged: true };

    item.purchased = desired;
    return { changed: true };
  });
});

// The fingerprint of the fields an owner would change to answer an anonymous
// "please add more detail". Must produce byte-identical output to
// itemInfoSignature() in index.html: the client compares the stored signature
// against its own to decide whether the request has been answered, so the two
// implementations agreeing is load-bearing.
function itemInfoSignature(item) {
  const source = [
    item.description || '',
    item.details || '',
    item.price || '',
    item.priority || ''
  ].join('\u0000');

  let hash = 5381;
  for (let i = 0; i < source.length; i++) {
    hash = ((hash * 33) ^ source.charCodeAt(i)) >>> 0;
  }
  return `${hash.toString(36)}-${source.length.toString(36)}`;
}

// An item's content, with no claim data in it. Safe to hand to anyone,
// including the item's owner, which is why the action endpoints answer with
// this rather than with the raw item.
function publicItemPayload(item) {
  return {
    id: item.id,
    description: item.description || '',
    priority: item.priority || 'medium',
    price: item.price || '',
    notes: item.notes || '',
    details: item.details || '',
    infoRequest: item.infoRequest
  };
}

// Split request ids share the item id charset and have to be unique across the
// group: the respond endpoint addresses them without naming the item.
function collectSplitRequestIds(blob) {
  const used = new Set();
  Object.values((blob && blob.users) || {}).forEach(user => {
    if (!user || !Array.isArray(user.items)) return;
    user.items.forEach(item => {
      splitRequestList(item).forEach(request => {
        if (request && typeof request.id === 'string') used.add(request.id);
      });
    });
  });
  return used;
}

function findSplitRequestById(blob, requestId) {
  const users = (blob && blob.users) || {};

  for (const [ownerName, user] of Object.entries(users)) {
    if (!user || !Array.isArray(user.items)) continue;

    for (const item of user.items) {
      const splitRequest = splitRequestList(item).find(request => request && request.id === requestId);
      if (splitRequest) return { ownerName, item, splitRequest };
    }
  }

  return null;
}

// A removed member's asks go with them, the same way their claims do.
function dropSplitRequestsFrom(blob, name) {
  Object.values((blob && blob.users) || {}).forEach(user => {
    if (!user || !Array.isArray(user.items)) return;
    user.items.forEach(item => {
      const requests = splitRequestList(item);
      if (requests.length === 0) return;
      const kept = requests.filter(request => request.from !== name && request.to !== name);
      if (kept.length > 0) item.splitRequests = kept;
      else delete item.splitRequests;
    });
  });
}

// ---------------------------------------------------------------
// Wishlist items: add, edit, delete (brief 7.2)
//
// Authorization lives in each handler now, which is the point: Phase 2 could
// only gate the destructive shapes of a whole-blob write, so until these
// existed any member could rename the group or rewrite somebody else's item.
// ---------------------------------------------------------------

// Build a stored item from client input. Mirrors sanitizeGroupData()'s item
// shape, because these items end up in the same blob.
function buildItem(input, usedItemIds) {
  return {
    id: stableItemId(input && input.id, usedItemIds),
    description: sanitizeString((input && (input.description || input.item || input.name)) || '', 500),
    priority: input && ['high', 'medium', 'low'].includes(input.priority) ? input.priority : 'medium',
    price: input && input.price ? sanitizeString(String(input.price), 20) : '',
    notes: input && input.notes ? sanitizeString(input.notes, 1000) : '',
    details: input && input.details ? sanitizeString(input.details, 1000) : '',
    claimedBy: [],
    purchased: false,
    splitWith: []
  };
}

function collectItemIds(blob) {
  const used = new Set();
  Object.values((blob && blob.users) || {}).forEach(user => {
    if (!user || !Array.isArray(user.items)) return;
    user.items.forEach(item => {
      if (item && typeof item.id === 'string') used.add(item.id);
    });
  });
  return used;
}

// Add an item to your OWN list. There is deliberately no way to add one to
// somebody else's.
app.post('/api/groups/:groupId/items', writeLimiter, async (req, res) => {
  await runGroupMutation(req, res, async ({ blob, member }) => {
    const name = member.member_name;

    if (!blob.users || typeof blob.users !== 'object' || Array.isArray(blob.users)) blob.users = {};
    if (!blob.users[name] || !Array.isArray(blob.users[name].items)) blob.users[name] = { items: [] };

    const items = blob.users[name].items;
    if (items.length >= 100) {
      return {
        httpStatus: 409,
        body: { success: false, code: 'list_full', message: 'Your wishlist is full (100 items).' }
      };
    }

    const item = buildItem(req.body, collectItemIds(blob));
    if (!item.description) {
      return {
        httpStatus: 400,
        body: { success: false, code: 'description_required', message: 'Please enter an item description.' }
      };
    }

    items.push(item);
    return { changed: true, body: { item } };
  });
});

// Edit an item. Your own, or anyone's if you are the creator.
app.patch('/api/groups/:groupId/items/:itemId', writeLimiter, async (req, res) => {
  await runItemAction(req, res, async (item, member, body, ctx) => {
    if (!ctx.isOwner) {
      const allowed = await hasCreatorAuthority(
        ctx.client, ctx.groupId, ctx.blob, member, readActingName(req)
      );
      if (!allowed) {
        return {
          forbidden: 'creator_only',
          message: 'Only the group creator can edit someone else\'s item.'
        };
      }
    }

    const description = sanitizeString(body.description || '', 500);
    if (!description) {
      return { conflict: 'description_required', message: 'Please enter an item description.' };
    }

    item.description = description;
    if (body.priority !== undefined) {
      item.priority = ['high', 'medium', 'low'].includes(body.priority) ? body.priority : 'medium';
    }
    if (body.price !== undefined) item.price = body.price ? sanitizeString(String(body.price), 20) : '';
    if (body.details !== undefined) item.details = body.details ? sanitizeString(body.details, 1000) : '';
    if (body.notes !== undefined) item.notes = body.notes ? sanitizeString(body.notes, 1000) : '';

    // Editing is how an owner answers an anonymous "please add more detail",
    // so a real change clears the marker (same rule the client used to apply).
    if (item.infoRequest && itemInfoSignature(item) !== item.infoRequest.signature) {
      delete item.infoRequest;
    }

    return { changed: true, body: { item: publicItemPayload(item) } };
  }, { allowOwner: true });
});

// Delete an item. Your own, or anyone's if you are the creator.
app.delete('/api/groups/:groupId/items/:itemId', writeLimiter, async (req, res) => {
  await runItemAction(req, res, async (item, member, body, ctx) => {
    if (!ctx.isOwner) {
      const allowed = await hasCreatorAuthority(
        ctx.client, ctx.groupId, ctx.blob, member, readActingName(req)
      );
      if (!allowed) {
        return {
          forbidden: 'creator_only',
          message: 'Only the group creator can delete someone else\'s item.'
        };
      }
    }

    ctx.blob.users[ctx.ownerName].items.splice(ctx.index, 1);
    return { changed: true, body: { deletedId: item.id } };
  }, { allowOwner: true });
});

// Anonymously ask an owner for more detail (existing behaviour, brief 7.2).
//
// Nothing identifying the asker is stored -- the whole blob is served to every
// member, so a name here would give them away. The client remembers locally
// that it already asked.
app.post('/api/groups/:groupId/items/:itemId/info-request', writeLimiter, async (req, res) => {
  await runItemAction(req, res, (item) => {
    const signature = itemInfoSignature(item);
    const existing = item.infoRequest && item.infoRequest.signature === signature
      ? item.infoRequest
      : null;

    item.infoRequest = sanitizeInfoRequest({
      count: existing ? (Number(existing.count) || 0) + 1 : 1,
      signature,
      lastRequestedAt: new Date().toISOString()
    });

    return { changed: true, body: { item: publicItemPayload(item) } };
  });
});

// ---------------------------------------------------------------
// Split requests (brief 7.4): ask, then be answered.
// ---------------------------------------------------------------

// Bob asks to join Mary's claim.
app.post('/api/groups/:groupId/items/:itemId/split-request', writeLimiter, async (req, res) => {
  await runItemAction(req, res, (item, member, body, ctx) => {
    pruneSplitRequests(item);

    const claimedBy = Array.isArray(item.claimedBy) ? item.claimedBy : [];
    const asker = member.member_name;

    if (claimedBy.length === 0) {
      return { conflict: 'not_claimed', message: 'Nobody has claimed this yet — you can just claim it.' };
    }
    if (claimedBy.includes(asker)) {
      return { conflict: 'already_sharing', message: "You're already in on this gift." };
    }
    if (item.purchased) {
      return { conflict: 'already_purchased', message: 'This gift has already been bought.' };
    }

    const mine = splitRequestList(item).filter(request => request.from === asker);
    if (mine.some(request => request.status === 'pending')) {
      return { conflict: 'already_pending', message: 'You have already asked — waiting for an answer.' };
    }
    // One ask, and one more after a decline. Then that is the end of it.
    if (mine.length >= MAX_SPLIT_ATTEMPTS_PER_ITEM) {
      return { conflict: 'split_attempts_exhausted', message: 'You have already asked about this gift twice.' };
    }

    const request = {
      id: stableItemId(null, collectSplitRequestIds(ctx.blob)),
      from: asker,
      to: claimedBy[0],
      status: 'pending',
      requestedAt: new Date().toISOString()
    };

    item.splitRequests = splitRequestList(item).concat([request]);
    return { changed: true, body: { request } };
  });
});

// Mary answers. Any current claimer may answer -- on an already-split gift
// there is more than one person who could.
app.post('/api/groups/:groupId/split-requests/:requestId/respond', writeLimiter, async (req, res) => {
  const requestId = req.params.requestId;

  if (typeof requestId !== 'string' || !ITEM_ID_PATTERN.test(requestId)) {
    return res.status(400).json({ success: false, message: 'Invalid request ID format' });
  }

  await runGroupMutation(req, res, async ({ blob, member }) => {
    const found = findSplitRequestById(blob, requestId);
    if (!found) {
      return {
        httpStatus: 404,
        body: { success: false, code: 'request_not_found', message: 'That request is no longer open.' }
      };
    }

    const { item, splitRequest, ownerName } = found;
    pruneSplitRequests(item);

    const claimedBy = Array.isArray(item.claimedBy) ? item.claimedBy : [];

    // The gift's owner must never see, let alone answer, a split request on
    // their own item -- that would tell them it had been claimed.
    if (ownerName === member.member_name || !claimedBy.includes(member.member_name)) {
      return {
        httpStatus: 403,
        body: {
          success: false,
          code: 'not_the_claimer',
          message: 'Only whoever claimed this gift can answer that.'
        }
      };
    }

    if (splitRequest.status !== 'pending') {
      return {
        httpStatus: 409,
        body: {
          success: false,
          code: 'already_answered',
          message: 'That request has already been answered.',
          request: splitRequest
        }
      };
    }

    const accept = Boolean((req.body || {}).accept);
    splitRequest.status = accept ? 'accepted' : 'declined';
    splitRequest.respondedAt = new Date().toISOString();

    if (accept && !claimedBy.includes(splitRequest.from)) {
      item.claimedBy = claimedBy.concat(splitRequest.from);
      item.splitWith = (Array.isArray(item.splitWith) ? item.splitWith : []).concat(splitRequest.from);
    }

    normalizeClaimFields(item);
    return { changed: true, body: { request: splitRequest, item: claimStatePayload(item) } };
  });
});

// Bob dismisses a decline he has been shown. Only his own, and only one that
// has actually been answered.
app.post('/api/groups/:groupId/split-requests/:requestId/dismiss', writeLimiter, async (req, res) => {
  const requestId = req.params.requestId;

  if (typeof requestId !== 'string' || !ITEM_ID_PATTERN.test(requestId)) {
    return res.status(400).json({ success: false, message: 'Invalid request ID format' });
  }

  await runGroupMutation(req, res, async ({ blob, member }) => {
    const found = findSplitRequestById(blob, requestId);
    if (!found) {
      return { httpStatus: 200, body: { success: true, message: 'Already gone' } };
    }

    if (found.splitRequest.from !== member.member_name) {
      return {
        httpStatus: 403,
        body: { success: false, code: 'not_yours', message: 'That is not your request.' }
      };
    }

    found.splitRequest.dismissed = true;
    return { changed: true, body: { requestId } };
  });
});

// ---------------------------------------------------------------
// Group settings and membership -- creator only (brief 7.2)
// ---------------------------------------------------------------
app.patch('/api/groups/:groupId/settings', writeLimiter, async (req, res) => {
  await runGroupMutation(req, res, async ({ blob, member, client, groupId }) => {
    const allowed = await hasCreatorAuthority(client, groupId, blob, member, readActingName(req));
    if (!allowed) {
      return {
        httpStatus: 403,
        body: {
          success: false,
          code: 'creator_only',
          message: 'Only the group creator can change the group settings.'
        }
      };
    }

    const body = req.body || {};

    if (body.groupName !== undefined) {
      const groupName = sanitizeString(body.groupName, 100);
      if (!groupName) {
        return {
          httpStatus: 400,
          body: { success: false, code: 'name_required', message: 'The group needs a name.' }
        };
      }
      blob.groupName = groupName;
    }

    if (body.holiday !== undefined) {
      if (!['Christmas', 'Birthday', 'Hanukkah', 'Anniversary', 'Other'].includes(body.holiday)) {
        return {
          httpStatus: 400,
          body: { success: false, code: 'invalid_holiday', message: 'That is not an event type we know.' }
        };
      }
      blob.holiday = body.holiday;
    }

    if (body.eventDate !== undefined) {
      if (body.eventDate && !validator.isISO8601(String(body.eventDate))) {
        return {
          httpStatus: 400,
          body: { success: false, code: 'invalid_date', message: 'That date is not valid.' }
        };
      }
      blob.eventDate = body.eventDate || '';
    }

    return {
      changed: true,
      body: { settings: { groupName: blob.groupName, holiday: blob.holiday, eventDate: blob.eventDate } }
    };
  });
});

app.delete('/api/groups/:groupId/members/:name', writeLimiter, async (req, res) => {
  await runGroupMutation(req, res, async ({ blob, member, client, groupId }) => {
    const target = sanitizeString(decodeURIComponent(req.params.name || ''), 100);

    const allowed = await hasCreatorAuthority(client, groupId, blob, member, readActingName(req));
    if (!allowed) {
      return {
        httpStatus: 403,
        body: {
          success: false,
          code: 'creator_only',
          message: 'Only the group creator can remove someone from the group.'
        }
      };
    }

    if (!target || !blob.users || !blob.users[target]) {
      return {
        httpStatus: 404,
        body: { success: false, code: 'member_not_found', message: 'That person is not in this group.' }
      };
    }

    if (target === member.member_name) {
      return {
        httpStatus: 409,
        body: { success: false, code: 'cannot_remove_self', message: 'You cannot remove yourself from the group.' }
      };
    }

    delete blob.users[target];
    scrubNamesFromClaims(blob, [target]);
    dropSplitRequestsFrom(blob, target);

    // Their devices go with them, so the name is free again and no rows are
    // left pointing at a member who is not in the group.
    await client.query(
      'DELETE FROM group_members WHERE group_id = $1 AND member_name = $2',
      [groupId, target]
    );

    return { changed: true, body: { removed: target } };
  });
});

// POST/UPDATE group data
app.post('/api/groups/:groupId', writeLimiter, async (req, res) => {
  try {
    const groupId = req.params.groupId;
    const groupData = req.body;
    
    // Validate groupId format
    if (!groupId || groupId.length > 255 || !/^[a-zA-Z0-9-_]+$/.test(groupId)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid group ID format' 
      });
    }
    
    // Validate group data
    const validationErrors = validateGroupData(groupData);
    if (validationErrors.length > 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Validation failed', 
        errors: validationErrors 
      });
    }
    
    // Sanitize group data
    const sanitizedData = sanitizeGroupData(groupData);

    // A brand new group has nothing to race against and no claim state to
    // protect, so it keeps the simple path (and the stricter creation limiter).
    const existingGroup = await pool.query(
      'SELECT 1 FROM groups WHERE group_id = $1',
      [groupId]
    );

    if (existingGroup.rows.length === 0) {
      return groupCreationLimiter(req, res, async () => {
        try {
          await pool.query(
            'INSERT INTO groups (group_id, data, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP)',
            [groupId, JSON.stringify(sanitizedData)]
          );
          res.json({ success: true, message: 'Group created successfully' });
        } catch (error) {
          console.error('Error creating group:', error);
          res.status(500).json({
            success: false,
            message: 'Error creating group'
          });
        }
      });
    }

    // Updating an existing group happens inside one transaction with the row
    // locked. Read-modify-write across two pool queries was a lost update
    // waiting to happen, which is the whole subject of this phase.
    const payload = await withTransaction(async (client) => {
      const groupResult = await client.query(
        'SELECT data, deleted_at FROM groups WHERE group_id = $1 FOR UPDATE',
        [groupId]
      );

      if (groupResult.rows.length === 0) {
        return { httpStatus: 404, body: { success: false, message: 'Group not found' } };
      }

      const stored = groupResult.rows[0];

      // Writes to a reset group are refused. Otherwise an open tab's next
      // poll-and-save would quietly resurrect it.
      if (stored.deleted_at) {
        return {
          httpStatus: 409,
          body: {
            success: false,
            code: 'group_reset',
            message: 'This group was reset.',
            reset: resetStatePayload(stored)
          }
        };
      }

      // ---------------------------------------------------------------
      // Identity is now required to write to a group that already exists
      // (brief 6.2/6.3).
      //
      // Every client only ever holds a FILTERED copy of the group, so a caller
      // we cannot identify is by definition posting an incomplete blob: either
      // a tab left open from before member tokens, or somebody who never
      // joined. Neither may overwrite a live group. Creating a brand new group
      // still needs no token -- there is nothing to overwrite, and the joining
      // client claims its name immediately afterwards.
      //
      // 401 rather than 403 on purpose: it is what apiFetch() in index.html
      // heals from, by re-claiming the stored name and retrying once.
      // ---------------------------------------------------------------
      const token = readMemberToken(req);
      const member = token ? await resolveMember(client, groupId, token) : null;

      if (!member) {
        return {
          httpStatus: 401,
          body: {
            success: false,
            code: 'auth_required',
            message: 'This device needs to sign back in to the group before saving.'
          }
        };
      }

      const storedBlob = stored.data || {};

      // Claim state is authoritative in storage. This puts back what filtering
      // stripped from the writer's own items, and stops a stale snapshot of
      // everyone else's claims from overwriting claims made since this tab
      // last polled.
      reconcileClaimState(sanitizedData, storedBlob, member.member_name);

      // ---------------------------------------------------------------
      // Creator gate on the blob write (brief 5.5), deliberately narrow.
      //
      // Only the DESTRUCTIVE shapes are gated here: removing a member, and
      // rewriting who the creator is. Settings changes and edits to another
      // member's item content are left to Phase 4, where every write has its
      // own endpoint and the check is a natural line in the handler rather
      // than a field-by-field diff of two blobs. A differ would be throwaway
      // code whose own failure mode -- 403ing a legitimate write on a live
      // site -- is worse than the rudeness it would prevent. This does not
      // regress anything: the creator's name was already claimable by anyone
      // who typed it, and Phase 2 does not widen that.
      // ---------------------------------------------------------------
      const storedUsers = Object.keys(storedBlob.users || {});
      const incomingUsers = new Set(Object.keys(sanitizedData.users || {}));
      const removedUsers = storedUsers.filter(name => !incomingUsers.has(name));

      const storedCreator = typeof storedBlob.createdBy === 'string' ? storedBlob.createdBy : '';
      // An empty createdBy being filled in is the first join, not a takeover.
      const creatorChanged = Boolean(storedCreator) && storedCreator !== sanitizedData.createdBy;

      if (removedUsers.length > 0 || creatorChanged) {
        const allowed = await hasCreatorAuthority(
          client, groupId, storedBlob, member, readActingName(req)
        );

        if (!allowed) {
          return {
            httpStatus: 403,
            body: {
              success: false,
              code: 'creator_only',
              message: removedUsers.length > 0
                ? 'Only the group creator can remove someone from the group.'
                : 'Only the group creator can change who owns this group.'
            }
          };
        }

        // Removing a member takes their devices with them, so the name is
        // free again and the FK does not strand rows.
        if (removedUsers.length > 0) {
          await client.query(
            'DELETE FROM group_members WHERE group_id = $1 AND member_name = ANY($2::varchar[])',
            [groupId, removedUsers]
          );

          // ...and takes their claims with them. The acting member's own items
          // were restored from storage just above, so the client's own pass
          // over them could not have caught these.
          scrubNamesFromClaims(sanitizedData, removedUsers);
          removedUsers.forEach(name => dropSplitRequestsFrom(sanitizedData, name));
        }
      }

      // Gap 1: settings and other people's item content are not this writer's
      // to change unless they are the creator.
      const writerIsCreator = await hasCreatorAuthority(
        client, groupId, storedBlob, member, readActingName(req)
      );
      enforceWriteAuthority(sanitizedData, storedBlob, member.member_name, writerIsCreator);

      const updated = await client.query(
        `UPDATE groups
            SET data = $1, version = version + 1, updated_at = CURRENT_TIMESTAMP
          WHERE group_id = $2
        RETURNING version`,
        [JSON.stringify(sanitizedData), groupId]
      );

      return {
        httpStatus: 200,
        member,
        body: {
          success: true,
          message: 'Group updated successfully',
          version: updated.rows[0].version
        }
      };
    });

    // Freshness bookkeeping, outside the transaction: it must never be the
    // reason a member's save rolls back.
    if (payload.member) await touchMember(pool, payload.member);

    res.status(payload.httpStatus).json(payload.body);
  } catch (error) {
    console.error('Error saving group:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error saving group data' 
    });
  }
});

// ---------------------------------------------------------------
// Reset Group (brief 5.7)
//
// Reset is now a soft delete with a 30-day undo. Because anyone can claim the
// creator's name, anyone can reach this button -- most likely a confused
// relative who clicked "that's me". Trust is fine when the worst case is
// annoying; it is not fine when the worst case is permanent.
// ---------------------------------------------------------------
async function softDeleteGroup(req, res) {
  const groupId = req.params.groupId;

  if (!isValidGroupId(groupId)) {
    return res.status(400).json({ success: false, message: 'Invalid group ID format' });
  }

  const payload = await withTransaction(async (client) => {
    const groupResult = await client.query(
      'SELECT data, deleted_at FROM groups WHERE group_id = $1 FOR UPDATE',
      [groupId]
    );

    if (groupResult.rows.length === 0) {
      return { httpStatus: 404, body: { success: false, message: 'Group not found' } };
    }

    const row = groupResult.rows[0];
    if (row.deleted_at) {
      // Already reset. Idempotent rather than an error.
      return { httpStatus: 200, body: { success: true, reset: resetStatePayload(row) } };
    }

    const member = await resolveMember(client, groupId, readMemberToken(req));
    const allowed = await hasCreatorAuthority(
      client, groupId, row.data || {}, member, readActingName(req)
    );

    if (!allowed) {
      return {
        httpStatus: 403,
        body: {
          success: false,
          code: 'creator_only',
          message: 'Only the group creator can reset this group.'
        }
      };
    }

    const updated = await client.query(
      `UPDATE groups SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE group_id = $1
        RETURNING data, deleted_at`,
      [groupId]
    );

    return { httpStatus: 200, body: { success: true, reset: resetStatePayload(updated.rows[0]) } };
  });

  res.status(payload.httpStatus).json(payload.body);
}

app.post('/api/groups/:groupId/reset', writeLimiter, async (req, res) => {
  try {
    await softDeleteGroup(req, res);
  } catch (error) {
    console.error('Error resetting group:', error);
    res.status(500).json({ success: false, message: 'Error resetting group' });
  }
});

// The old hard-delete route now soft-deletes too. A browser tab still running
// pre-Phase-2 JavaScript calls this one, and it must not be able to destroy a
// group irrecoverably.
app.delete('/api/groups/:groupId', writeLimiter, async (req, res) => {
  try {
    await softDeleteGroup(req, res);
  } catch (error) {
    console.error('Error deleting group:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting group'
    });
  }
});

// Undo a reset, within the 30-day window.
//
// The brief says "creator token required". That is read here as creator
// AUTHORITY -- the same per-check rule as everywhere else, token first with the
// legacy name fallback behind it. A strict token requirement would mean a
// legacy creator who reset via the name fallback could never undo it, which is
// exactly the lockout that 5.0 says must not exist.
app.post('/api/groups/:groupId/undo-reset', writeLimiter, async (req, res) => {
  try {
    const groupId = req.params.groupId;

    if (!isValidGroupId(groupId)) {
      return res.status(400).json({ success: false, message: 'Invalid group ID format' });
    }

    const payload = await withTransaction(async (client) => {
      const groupResult = await client.query(
        `SELECT data, deleted_at, updated_at,
                deleted_at < NOW() - INTERVAL '${UNDO_WINDOW_DAYS} days' AS undo_expired,
                updated_at < NOW() - INTERVAL '2 years' AS retention_expired
           FROM groups WHERE group_id = $1 FOR UPDATE`,
        [groupId]
      );

      if (groupResult.rows.length === 0) {
        return { httpStatus: 404, body: { success: false, message: 'Group not found' } };
      }

      const row = groupResult.rows[0];
      if (!row.deleted_at) {
        return { httpStatus: 200, body: { success: true, message: 'Group is already active' } };
      }

      // Never resurrect something the retention rules have already condemned.
      // These are two different reasons and deserve two different answers: a
      // group reset yesterday but untouched for two years is refused by
      // retention, and telling its owner the 30-day window has passed would be
      // a plain lie.
      if (row.retention_expired) {
        return {
          httpStatus: 410,
          body: {
            success: false,
            code: 'retention_expired',
            message: 'This group has not been used for over two years, so it is being deleted and cannot be restored.'
          }
        };
      }

      if (row.undo_expired) {
        return {
          httpStatus: 410,
          body: {
            success: false,
            code: 'undo_expired',
            message: 'The 30-day window to undo this reset has passed.'
          }
        };
      }

      const member = await resolveMember(client, groupId, readMemberToken(req));
      const allowed = await hasCreatorAuthority(
        client, groupId, row.data || {}, member, readActingName(req)
      );

      if (!allowed) {
        return {
          httpStatus: 403,
          body: {
            success: false,
            code: 'creator_only',
            message: 'Only the group creator can undo a reset.'
          }
        };
      }

      await client.query(
        'UPDATE groups SET deleted_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE group_id = $1',
        [groupId]
      );

      return { httpStatus: 200, body: { success: true, message: 'Group restored' } };
    });

    res.status(payload.httpStatus).json(payload.body);
  } catch (error) {
    console.error('Error undoing reset:', error);
    res.status(500).json({ success: false, message: 'Error undoing reset' });
  }
});

// Contact form endpoint - Saves to database
app.post('/api/contact', contactLimiter, async (req, res) => {
  try {
    const { name, email, message } = req.body;

    // Validate inputs
    if (!name || !email || !message) {
      return res.status(400).json({
        success: false,
        message: 'All fields are required'
      });
    }

    if (!validator.isEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email address'
      });
    }

    if (name.length > 100 || message.length > 2000) {
      return res.status(400).json({
        success: false,
        message: 'Input too long'
      });
    }

    // Sanitize inputs
    const sanitizedName = sanitizeString(name, 100);
    const sanitizedEmail = validator.normalizeEmail(email);
    const sanitizedMessage = sanitizeString(message, 2000);

    // Store in database
    await pool.query(
      'INSERT INTO contact_submissions (name, email, message) VALUES ($1, $2, $3)',
      [sanitizedName, sanitizedEmail, sanitizedMessage]
    );

    // Also log to console for immediate visibility
    console.log('\n📧 ===== CONTACT FORM SUBMISSION =====');
    console.log('From:', sanitizedName);
    console.log('Email:', sanitizedEmail);
    console.log('Message:', sanitizedMessage);
    console.log('Time:', new Date().toISOString());
    console.log('=====================================\n');

    res.json({
      success: true,
      message: 'Message received! Thank you for your feedback.'
    });
  } catch (error) {
    console.error('Error processing contact form:', error);
    res.status(500).json({
      success: false,
      message: 'Error sending message. Please try again later.'
    });
  }
});

// ===== ADMIN ENDPOINTS =====

// Admin login
app.post('/admin/api/login', adminLoginLimiter, (req, res) => {
  const { password } = req.body;

  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({
      success: false,
      message: 'Admin password not configured'
    });
  }

  if (password !== process.env.ADMIN_PASSWORD) {
    console.log('❌ Failed admin login attempt');
    return res.status(401).json({
      success: false,
      message: 'Invalid password'
    });
  }

  // Generate session token
  const crypto = require('crypto');
  const token = crypto.randomBytes(32).toString('hex');
  const session = {
    createdAt: Date.now(),
    expiresAt: Date.now() + (2 * 60 * 60 * 1000) // 2 hours
  };

  adminSessions.set(token, session);
  console.log('✅ Admin logged in');

  res.json({ success: true, token });
});

// Admin logout
app.post('/admin/api/logout', requireAdmin, (req, res) => {
  const token = req.headers.authorization.substring(7);
  adminSessions.delete(token);
  console.log('✅ Admin logged out');
  res.json({ success: true });
});

// Get system stats
app.get('/admin/api/stats', requireAdmin, async (req, res) => {
  try {
    const groupsResult = await pool.query('SELECT COUNT(*) as count FROM groups');
    const groupsCount = parseInt(groupsResult.rows[0].count);

    const allGroups = await pool.query('SELECT data FROM groups');
    let totalUsers = 0;
    let totalItems = 0;

    allGroups.rows.forEach(row => {
      const data = row.data;
      if (data.users) {
        totalUsers += Object.keys(data.users).length;
        Object.values(data.users).forEach(user => {
          totalItems += user.items?.length || 0;
        });
      }
    });

    const contactsResult = await pool.query(
      "SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = 'new') as new FROM contact_submissions"
    );

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const createdTodayResult = await pool.query(
      'SELECT COUNT(*) as count FROM groups WHERE created_at >= $1',
      [todayStart]
    );

    res.json({
      success: true,
      stats: {
        totalGroups: groupsCount,
        totalUsers,
        totalItems,
        totalContacts: parseInt(contactsResult.rows[0].total),
        newContacts: parseInt(contactsResult.rows[0].new),
        groupsCreatedToday: parseInt(createdTodayResult.rows[0].count)
      }
    });
  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({ success: false, message: 'Error loading stats' });
  }
});

// List all groups (paginated, searchable)
app.get('/admin/api/groups', requireAdmin, async (req, res) => {
  try {
    const search = req.query.search || '';
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;

    let query = 'SELECT group_id, data, created_at, updated_at FROM groups';
    let params = [];

    if (search) {
      query += " WHERE data->>'groupName' ILIKE $1";
      params.push(`%${search}%`);
    }

    query += ' ORDER BY updated_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(limit, offset);

    const result = await pool.query(query, params);

    const groups = result.rows.map(row => ({
      groupId: row.group_id,
      groupName: row.data.groupName,
      holiday: row.data.holiday,
      eventDate: row.data.eventDate,
      userCount: Object.keys(row.data.users || {}).length,
      itemCount: Object.values(row.data.users || {}).reduce((sum, user) => sum + (user.items?.length || 0), 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));

    res.json({ success: true, groups });
  } catch (error) {
    console.error('Error listing groups:', error);
    res.status(500).json({ success: false, message: 'Error loading groups' });
  }
});

// Get specific group (for observer mode)
app.get('/admin/api/groups/:groupId', requireAdmin, async (req, res) => {
  try {
    const groupId = req.params.groupId;
    const result = await pool.query('SELECT data FROM groups WHERE group_id = $1', [groupId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }

    res.json({ success: true, data: result.rows[0].data });
  } catch (error) {
    console.error('Error loading group:', error);
    res.status(500).json({ success: false, message: 'Error loading group' });
  }
});

// Delete group
app.delete('/admin/api/groups/:groupId', requireAdmin, async (req, res) => {
  try {
    const groupId = req.params.groupId;
    await pool.query('DELETE FROM groups WHERE group_id = $1', [groupId]);
    console.log(`🗑️ Admin deleted group: ${groupId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting group:', error);
    res.status(500).json({ success: false, message: 'Error deleting group' });
  }
});

// List contact submissions
app.get('/admin/api/contacts', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM contact_submissions ORDER BY submitted_at DESC'
    );
    res.json({ success: true, contacts: result.rows });
  } catch (error) {
    console.error('Error loading contacts:', error);
    res.status(500).json({ success: false, message: 'Error loading contacts' });
  }
});

// Update contact submission status
app.put('/admin/api/contacts/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, adminNotes } = req.body;

    await pool.query(
      'UPDATE contact_submissions SET status = $1, admin_notes = $2 WHERE id = $3',
      [status, adminNotes || null, id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating contact:', error);
    res.status(500).json({ success: false, message: 'Error updating contact' });
  }
});

// Manual cleanup trigger
app.post('/admin/api/cleanup', requireAdmin, async (req, res) => {
  try {
    // Two-year retention. Deliberately NOT filtered on deleted_at: a
    // soft-deleted group that is also two years stale still goes, and an
    // undo cannot bring back something retention has already condemned
    // (undo-reset checks the same two conditions).
    const groupsResult = await pool.query(
      "DELETE FROM groups WHERE updated_at < NOW() - INTERVAL '2 years'"
    );
    // Reset groups are hard-deleted once the 30-day undo window has passed.
    const resetResult = await pool.query(
      `DELETE FROM groups WHERE deleted_at IS NOT NULL
         AND deleted_at < NOW() - INTERVAL '${UNDO_WINDOW_DAYS} days'`
    );
    // Contact submissions hold names, emails and message bodies. Retain for
    // 12 months, matching the two-year rule on groups.
    const contactsResult = await pool.query(
      "DELETE FROM contact_submissions WHERE submitted_at < NOW() - INTERVAL '12 months'"
    );
    console.log(`🧹 Admin triggered cleanup: ${groupsResult.rowCount} groups, ${resetResult.rowCount} reset groups, ${contactsResult.rowCount} contact submissions deleted`);
    res.json({
      success: true,
      deletedCount: groupsResult.rowCount,
      deletedResetCount: resetResult.rowCount,
      deletedContactCount: contactsResult.rowCount
    });
  } catch (error) {
    console.error('Error running cleanup:', error);
    res.status(500).json({ success: false, message: 'Error running cleanup' });
  }
});

// Serve admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ===== END ADMIN ENDPOINTS =====

// Cleanup old data (optional - runs once when server starts)
async function cleanupOldData() {
  try {
    // Delete groups older than 2 years. Not filtered on deleted_at: a
    // soft-deleted group that is also two years stale must not be skipped.
    const result = await pool.query(
      "DELETE FROM groups WHERE updated_at < NOW() - INTERVAL '2 years'"
    );
    if (result.rowCount > 0) {
      console.log(`✅ Cleaned up ${result.rowCount} old groups`);
    }
  } catch (error) {
    console.error('Error cleaning up old groups:', error);
  }

  try {
    // Hard-delete reset groups once their 30-day undo window has passed.
    // group_members rows go with them via ON DELETE CASCADE.
    const result = await pool.query(
      `DELETE FROM groups WHERE deleted_at IS NOT NULL
         AND deleted_at < NOW() - INTERVAL '${UNDO_WINDOW_DAYS} days'`
    );
    if (result.rowCount > 0) {
      console.log(`✅ Hard-deleted ${result.rowCount} reset groups past the undo window`);
    }
  } catch (error) {
    console.error('Error cleaning up reset groups:', error);
  }

  try {
    // Delete contact submissions older than 12 months. These hold names,
    // emails and message bodies and previously grew forever.
    const result = await pool.query(
      "DELETE FROM contact_submissions WHERE submitted_at < NOW() - INTERVAL '12 months'"
    );
    if (result.rowCount > 0) {
      console.log(`✅ Cleaned up ${result.rowCount} old contact submissions`);
    }
  } catch (error) {
    console.error('Error cleaning up old contact submissions:', error);
  }
}

// Run cleanup on startup, once the schema is actually there. Previously this
// fired immediately and lost a race with the migrations on a fresh database.
databaseReady.then(cleanupOldData);

// Redirect old filename to new filename (backward compatibility)
app.get('/christmas-gift-exchange.html', (req, res) => {
  res.redirect(301, '/');
});

app.get('/christmas-gift-exchange-fixed.html', (req, res) => {
  res.redirect(301, '/');
});

// Start server
app.listen(PORT, () => {
  console.log(`\n🎄 ComeGiftIt - Gift Exchange App`);
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`✅ Security features enabled`);
  console.log(`✅ Data retention: groups 2 years, contact submissions 12 months`);
  console.log(`⚠️  Contact form logs to console (email not configured)`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  pool.end(() => {
    console.log('Database pool closed');
    process.exit(0);
  });
});
