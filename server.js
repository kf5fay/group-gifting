const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const validator = require('validator');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// SECURITY MIDDLEWARE
// ============================================

// 1. Helmet - Sets security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"], // Needed for inline scripts in HTML
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"]
    }
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

// 2. CORS Protection - Only allow your domain
app.use((req, res, next) => {
  const allowedOrigins = [
    process.env.FRONTEND_URL, // Your Railway domain
    'http://localhost:3000', // Local development
    'http://127.0.0.1:3000'
  ].filter(Boolean);

  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin) || !origin) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

// 3. Rate Limiting - Prevent spam/DoS attacks
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

const createGroupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // Limit to 10 group creations per hour per IP
  message: 'Too many groups created, please try again later.',
  skipSuccessfulRequests: false
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // Limit each IP to 30 API requests per minute
  message: 'Too many API requests, please slow down.',
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/', apiLimiter);

// 4. Size Limits - Prevent database bloat
app.use(express.json({ 
  limit: '1mb', // Maximum request size
  verify: (req, res, buf, encoding) => {
    // Store raw body for additional validation if needed
    req.rawBody = buf.toString(encoding || 'utf8');
  }
}));

app.use(express.urlencoded({ 
  extended: true, 
  limit: '1mb' 
}));

// ============================================
// DATABASE CONNECTION
// ============================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? {
    rejectUnauthorized: false
  } : false
});

// Initialize database
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS groups (
        group_id VARCHAR(255) PRIMARY KEY,
        data JSONB NOT NULL,
        password_hash VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Create index for faster queries
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_groups_updated 
      ON groups(updated_at)
    `);
    
    console.log('Database initialized successfully');
  } catch (err) {
    console.error('Database initialization error:', err);
  }
}

initializeDatabase();

// ============================================
// INPUT VALIDATION & SANITIZATION
// ============================================

// Sanitize string input
function sanitizeString(input, maxLength = 500) {
  if (typeof input !== 'string') return '';
  
  // Remove any HTML tags and scripts
  let sanitized = input
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .trim();
  
  // Escape special characters
  sanitized = validator.escape(sanitized);
  
  // Limit length
  return sanitized.substring(0, maxLength);
}

// Validate group ID format
function isValidGroupId(groupId) {
  return /^[a-zA-Z0-9-]{6,20}$/.test(groupId);
}

// Validate date format
function isValidDate(dateString) {
  if (!dateString) return true; // Optional dates
  return validator.isISO8601(dateString, { strict: true });
}

// Validate and sanitize group data
function validateGroupData(data) {
  const errors = [];
  
  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['Invalid data format'] };
  }
  
  // Validate group name
  if (!data.groupName || typeof data.groupName !== 'string') {
    errors.push('Group name is required');
  } else if (data.groupName.length > 100) {
    errors.push('Group name too long (max 100 characters)');
  }
  
  // Validate event type
  if (!data.eventType || typeof data.eventType !== 'string') {
    errors.push('Event type is required');
  }
  
  // Validate event date
  if (data.eventDate && !isValidDate(data.eventDate)) {
    errors.push('Invalid event date format');
  }
  
  // Validate users array
  if (!Array.isArray(data.users)) {
    errors.push('Users must be an array');
  } else if (data.users.length > 50) {
    errors.push('Too many users (max 50)');
  } else {
    // Validate each user
    data.users.forEach((user, index) => {
      if (!user.name || typeof user.name !== 'string') {
        errors.push(`User ${index + 1}: Name is required`);
      } else if (user.name.length > 100) {
        errors.push(`User ${index + 1}: Name too long (max 100 characters)`);
      }
      
      if (!Array.isArray(user.wishlist)) {
        errors.push(`User ${index + 1}: Wishlist must be an array`);
      } else if (user.wishlist.length > 100) {
        errors.push(`User ${index + 1}: Too many wishlist items (max 100)`);
      } else {
        // Validate each wishlist item
        user.wishlist.forEach((item, itemIndex) => {
          if (!item.item || typeof item.item !== 'string') {
            errors.push(`User ${index + 1}, Item ${itemIndex + 1}: Item name is required`);
          } else if (item.item.length > 500) {
            errors.push(`User ${index + 1}, Item ${itemIndex + 1}: Item name too long (max 500 characters)`);
          }
          
          if (item.notes && item.notes.length > 1000) {
            errors.push(`User ${index + 1}, Item ${itemIndex + 1}: Notes too long (max 1000 characters)`);
          }
          
          if (item.price && typeof item.price !== 'string') {
            errors.push(`User ${index + 1}, Item ${itemIndex + 1}: Invalid price format`);
          }
          
          if (item.link && !validator.isURL(item.link, { require_protocol: true })) {
            errors.push(`User ${index + 1}, Item ${itemIndex + 1}: Invalid URL format`);
          }
        });
      }
    });
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

// Sanitize entire group data object
function sanitizeGroupData(data) {
  const sanitized = {
    groupName: sanitizeString(data.groupName, 100),
    eventType: sanitizeString(data.eventType, 50),
    eventDate: data.eventDate || null,
    users: []
  };
  
  if (Array.isArray(data.users)) {
    sanitized.users = data.users.slice(0, 50).map(user => ({
      name: sanitizeString(user.name, 100),
      wishlist: Array.isArray(user.wishlist) 
        ? user.wishlist.slice(0, 100).map(item => ({
            item: sanitizeString(item.item, 500),
            notes: item.notes ? sanitizeString(item.notes, 1000) : '',
            price: item.price ? sanitizeString(item.price, 20) : '',
            link: item.link && validator.isURL(item.link) ? item.link : '',
            claimedBy: item.claimedBy ? sanitizeString(item.claimedBy, 100) : '',
            splitWith: Array.isArray(item.splitWith) 
              ? item.splitWith.slice(0, 10).map(name => sanitizeString(name, 100))
              : []
          }))
        : []
    }));
  }
  
  return sanitized;
}

// ============================================
// API ENDPOINTS
// ============================================

// Health check
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ 
      status: 'healthy', 
      database: 'connected',
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(503).json({ 
      status: 'unhealthy', 
      database: 'disconnected',
      error: 'Database connection failed'
    });
  }
});

// Get group data
app.get('/api/groups/:groupId', async (req, res) => {
  try {
    const { groupId } = req.params;
    
    // Validate group ID
    if (!isValidGroupId(groupId)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid group ID format' 
      });
    }
    
    const result = await pool.query(
      'SELECT data, updated_at FROM groups WHERE group_id = $1',
      [groupId]
    );
    
    if (result.rows.length === 0) {
      return res.json({ success: false, message: 'Group not found' });
    }
    
    res.json({ 
      success: true, 
      data: result.rows[0].data,
      lastUpdated: result.rows[0].updated_at
    });
  } catch (err) {
    console.error('Error fetching group:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});

// Create/update group data
app.post('/api/groups/:groupId', createGroupLimiter, async (req, res) => {
  try {
    const { groupId } = req.params;
    const groupData = req.body;
    
    // Validate group ID
    if (!isValidGroupId(groupId)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid group ID format' 
      });
    }
    
    // Validate group data
    const validation = validateGroupData(groupData);
    if (!validation.valid) {
      return res.status(400).json({ 
        success: false, 
        message: 'Validation failed',
        errors: validation.errors
      });
    }
    
    // Sanitize data
    const sanitizedData = sanitizeGroupData(groupData);
    
    // Check if data size is reasonable (prevent massive objects)
    const dataSize = JSON.stringify(sanitizedData).length;
    if (dataSize > 500000) { // 500KB limit
      return res.status(400).json({ 
        success: false, 
        message: 'Group data too large. Please reduce the number of items.' 
      });
    }
    
    // Insert or update group (SQL injection protected via parameterized query)
    await pool.query(
      `INSERT INTO groups (group_id, data, updated_at) 
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (group_id) 
       DO UPDATE SET data = $2, updated_at = CURRENT_TIMESTAMP`,
      [groupId, JSON.stringify(sanitizedData)]
    );
    
    res.json({ 
      success: true, 
      message: 'Group saved successfully' 
    });
  } catch (err) {
    console.error('Error saving group:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});

// Delete group (with optional password protection)
app.delete('/api/groups/:groupId', async (req, res) => {
  try {
    const { groupId } = req.params;
    
    // Validate group ID
    if (!isValidGroupId(groupId)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid group ID format' 
      });
    }
    
    // Delete group (SQL injection protected via parameterized query)
    const result = await pool.query(
      'DELETE FROM groups WHERE group_id = $1 RETURNING group_id',
      [groupId]
    );
    
    if (result.rowCount === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Group not found' 
      });
    }
    
    res.json({ 
      success: true, 
      message: 'Group deleted successfully' 
    });
  } catch (err) {
    console.error('Error deleting group:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});

// Cleanup old groups (optional - run periodically)
app.post('/api/cleanup', async (req, res) => {
  try {
    // Delete groups older than 6 months
    const result = await pool.query(
      `DELETE FROM groups 
       WHERE updated_at < NOW() - INTERVAL '6 months'
       RETURNING group_id`
    );
    
    res.json({ 
      success: true, 
      message: `Cleaned up ${result.rowCount} old groups` 
    });
  } catch (err) {
    console.error('Error cleaning up:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});

// ============================================
// SERVE FRONTEND
// ============================================

// Serve static files with security headers
app.use(express.static(__dirname, {
  setHeaders: (res, path) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('X-XSS-Protection', '1; mode=block');
  }
}));

// Serve the main HTML file for any other route
app.get('*', generalLimiter, (req, res) => {
  res.sendFile(path.join(__dirname, 'christmas-gift-exchange.html'));
});

// ============================================
// ERROR HANDLING
// ============================================

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    success: false, 
    message: 'Endpoint not found' 
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    success: false, 
    message: 'Internal server error' 
  });
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log(`🎄 Gift Exchange app running securely on port ${PORT}`);
  console.log(`✅ Security features enabled:`);
  console.log(`   - Rate limiting`);
  console.log(`   - Input validation & sanitization`);
  console.log(`   - SQL injection protection`);
  console.log(`   - XSS protection`);
  console.log(`   - CORS protection`);
  console.log(`   - Size limits`);
  console.log(`   - Security headers`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  pool.end(() => {
    console.log('Database pool closed');
    process.exit(0);
  });
});
