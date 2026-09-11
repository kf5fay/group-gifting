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
}).catch(err => {
  console.error('❌ Database initialization error:', err);
});

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
function resetStatePayload(row) {
  const deletedAt = new Date(row.deleted_at);
  const undoUntil = new Date(deletedAt.getTime() + UNDO_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return {
    status: 'reset',
    groupName: row.data && row.data.groupName ? row.data.groupName : '',
    resetAt: deletedAt.toISOString(),
    undoAvailableUntil: undoUntil.toISOString(),
    undoAvailable: Date.now() < undoUntil.getTime()
  };
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
    
    for (const username of usernames) {
      const cleanUsername = sanitizeString(username, 100);
      const user = data.users[username];
      
      sanitized.users[cleanUsername] = {
        items: Array.isArray(user.items) 
          ? user.items.slice(0, 100).map(item => ({
              // Item ids are machine-generated identifiers, not user prose.
              // sanitizeString no longer strips characters, so validate the
              // charset here instead of relying on it. Accepts both the legacy
              // hex ids and the UUIDs the client now generates.
              id: typeof item.id === 'string' && /^[a-zA-Z0-9-]{1,40}$/.test(item.id.trim())
                ? item.id.trim()
                : generateItemId(),
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
      'SELECT data, deleted_at FROM groups WHERE group_id = $1',
      [groupId]
    );

    if (result.rows.length === 0) {
      return res.json({ success: true, data: null });
    }

    const row = result.rows[0];

    // A soft-deleted group is a state, not a 404: members who still have the
    // link get told it was reset, and the creator gets an undo affordance.
    if (row.deleted_at) {
      return res.json({ success: true, data: null, reset: resetStatePayload(row) });
    }

    const token = readMemberToken(req);
    let viewer = null;

    if (token) {
      const member = await resolveMember(pool, groupId, token);
      if (!member) {
        // Let the client heal itself (re-join with its stored name) rather
        // than silently serving it as an anonymous viewer forever.
        return res.status(401).json({
          success: false,
          code: 'invalid_token',
          message: 'This device is no longer recognised for this group.'
        });
      }
      await touchMember(pool, member);
      viewer = { memberName: member.member_name, isCreator: member.is_creator };
    }

    // NOTE: the response body is the stored blob, which never contains token
    // material -- tokens live only in group_members, and `viewer` below carries
    // a name and a boolean, nothing else.
    res.json({ success: true, data: row.data, viewer });
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
      entry.devices.push({
        label: row.device_label || 'Unknown device',
        joinedAt: row.created_at,
        lastSeenAt: row.last_seen_at
      });
    }

    res.json({ success: true, members: Array.from(byName.values()) });
  } catch (error) {
    console.error('Error loading members:', error);
    res.status(500).json({ success: false, message: 'Error loading members' });
  }
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

    // Check if group exists
    const existingGroup = await pool.query(
      'SELECT data, deleted_at FROM groups WHERE group_id = $1',
      [groupId]
    );

    if (existingGroup.rows.length > 0) {
      const stored = existingGroup.rows[0];

      // Writes to a reset group are refused. Otherwise an open tab's next
      // poll-and-save would quietly resurrect it.
      if (stored.deleted_at) {
        return res.status(409).json({
          success: false,
          code: 'group_reset',
          message: 'This group was reset.',
          reset: resetStatePayload(stored)
        });
      }

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
      const storedBlob = stored.data || {};
      const storedUsers = Object.keys(storedBlob.users || {});
      const incomingUsers = new Set(Object.keys(sanitizedData.users || {}));
      const removedUsers = storedUsers.filter(name => !incomingUsers.has(name));

      const storedCreator = typeof storedBlob.createdBy === 'string' ? storedBlob.createdBy : '';
      // An empty createdBy being filled in is the first join, not a takeover.
      const creatorChanged = Boolean(storedCreator) && storedCreator !== sanitizedData.createdBy;

      if (removedUsers.length > 0 || creatorChanged) {
        const token = readMemberToken(req);
        const member = await resolveMember(pool, groupId, token);
        const allowed = await hasCreatorAuthority(
          pool, groupId, storedBlob, member, readActingName(req)
        );

        if (!allowed) {
          return res.status(403).json({
            success: false,
            code: 'creator_only',
            message: removedUsers.length > 0
              ? 'Only the group creator can remove someone from the group.'
              : 'Only the group creator can change who owns this group.'
          });
        }

        // Removing a member takes their devices with them, so the name is
        // free again and the FK does not strand rows.
        if (removedUsers.length > 0) {
          await pool.query(
            'DELETE FROM group_members WHERE group_id = $1 AND member_name = ANY($2::varchar[])',
            [groupId, removedUsers]
          );
        }
      }
    }

    if (existingGroup.rows.length === 0) {
      // Apply stricter rate limit for new groups
      groupCreationLimiter(req, res, async () => {
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
    } else {
      // Update existing group
      await pool.query(
        'UPDATE groups SET data = $1, updated_at = CURRENT_TIMESTAMP WHERE group_id = $2',
        [JSON.stringify(sanitizedData), groupId]
      );
      res.json({ success: true, message: 'Group updated successfully' });
    }
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
      if (row.undo_expired || row.retention_expired) {
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
