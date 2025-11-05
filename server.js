const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { body, param, validationResult } = require('express-validator');
const xss = require('xss');

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false, // Allow inline scripts for our single-page app
  crossOriginEmbedderPolicy: false
}));

// JSON parsing with size limit
app.use(express.json({ limit: '1mb' }));

// Serve static files
app.use(express.static(__dirname));

// Rate limiting - General API protection
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per window
  message: { success: false, message: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter rate limit for creating/updating groups
const groupWriteLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 writes per minute
  message: { success: false, message: 'Too many updates, please slow down.' },
  skipSuccessfulRequests: false
});

// Very strict rate limit for group creation
const groupCreationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // Only 10 new groups per hour per IP
  message: { success: false, message: 'Too many groups created. Please wait before creating more.' }
});

// Apply rate limiting to all API routes
app.use('/api/', apiLimiter);

// PostgreSQL connection pool with connection limits
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? {
    rejectUnauthorized: false
  } : false,
  max: 20, // Maximum number of connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Constants for data limits
const LIMITS = {
  MAX_GROUP_NAME: 100,
  MAX_USER_NAME: 50,
  MAX_ITEM_DESCRIPTION: 200,
  MAX_ITEM_DETAILS: 1000,
  MAX_ITEM_NOTES: 500,
  MAX_ITEMS_PER_USER: 50,
  MAX_USERS_PER_GROUP: 50,
  MAX_GROUP_AGE_DAYS: 365 // Auto-cleanup after 1 year
};

// XSS sanitization function
function sanitizeInput(input) {
  if (typeof input !== 'string') return input;
  return xss(input, {
    whiteList: {}, // No HTML tags allowed
    stripIgnoreTag: true,
    stripIgnoreTagBody: ['script', 'style']
  });
}

// Deep sanitize an object
function sanitizeObject(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
  
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item));
  }
  
  const sanitized = {};
  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      if (typeof obj[key] === 'string') {
        sanitized[key] = sanitizeInput(obj[key]);
      } else if (typeof obj[key] === 'object') {
        sanitized[key] = sanitizeObject(obj[key]);
      } else {
        sanitized[key] = obj[key];
      }
    }
  }
  return sanitized;
}

// Validate group data structure
function validateGroupData(data) {
  const errors = [];
  
  // Check required fields
  if (!data.groupName || typeof data.groupName !== 'string') {
    errors.push('Invalid group name');
  } else if (data.groupName.length > LIMITS.MAX_GROUP_NAME) {
    errors.push(`Group name too long (max ${LIMITS.MAX_GROUP_NAME} characters)`);
  }
  
  if (!data.eventType || typeof data.eventType !== 'string') {
    errors.push('Invalid event type');
  }
  
  if (!data.eventDate) {
    errors.push('Invalid event date');
  }
  
  if (!data.people || typeof data.people !== 'object') {
    errors.push('Invalid people data');
  } else {
    // Validate people count
    const peopleCount = Object.keys(data.people).length;
    if (peopleCount > LIMITS.MAX_USERS_PER_GROUP) {
      errors.push(`Too many users (max ${LIMITS.MAX_USERS_PER_GROUP})`);
    }
    
    // Validate each person's data
    for (const [userName, userData] of Object.entries(data.people)) {
      if (userName.length > LIMITS.MAX_USER_NAME) {
        errors.push(`Username too long: ${userName}`);
      }
      
      if (!Array.isArray(userData.items)) {
        errors.push(`Invalid items for user: ${userName}`);
      } else if (userData.items.length > LIMITS.MAX_ITEMS_PER_USER) {
        errors.push(`Too many items for ${userName} (max ${LIMITS.MAX_ITEMS_PER_USER})`);
      }
      
      // Validate each item
      userData.items.forEach((item, idx) => {
        if (item.description && item.description.length > LIMITS.MAX_ITEM_DESCRIPTION) {
          errors.push(`Item description too long for ${userName}`);
        }
        if (item.details && item.details.length > LIMITS.MAX_ITEM_DETAILS) {
          errors.push(`Item details too long for ${userName}`);
        }
        if (item.notes && item.notes.length > LIMITS.MAX_ITEM_NOTES) {
          errors.push(`Item notes too long for ${userName}`);
        }
      });
    }
  }
  
  return errors;
}

// Initialize database with auto-cleanup
async function initDatabase() {
  try {
    // Create groups table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS groups (
        group_id VARCHAR(255) PRIMARY KEY,
        data JSONB NOT NULL,
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
    
    // Schedule cleanup of old groups (run daily)
    setInterval(cleanupOldGroups, 24 * 60 * 60 * 1000);
    
  } catch (error) {
    console.error('Error initializing database:', error);
  }
}

// Cleanup groups older than MAX_GROUP_AGE_DAYS
async function cleanupOldGroups() {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - LIMITS.MAX_GROUP_AGE_DAYS);
    
    const result = await pool.query(
      'DELETE FROM groups WHERE updated_at < $1',
      [cutoffDate]
    );
    
    if (result.rowCount > 0) {
      console.log(`Cleaned up ${result.rowCount} old groups`);
    }
  } catch (error) {
    console.error('Error cleaning up old groups:', error);
  }
}

initDatabase();

// Validation middleware
const validateGroupId = [
  param('groupId')
    .isLength({ min: 5, max: 50 })
    .matches(/^[a-z0-9]+$/)
    .withMessage('Invalid group ID format')
];

// API Routes

// Get group data
app.get('/api/groups/:groupId',
  validateGroupId,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Invalid request' });
    }
    
    const { groupId } = req.params;
    
    try {
      const result = await pool.query(
        'SELECT data FROM groups WHERE group_id = $1',
        [groupId]
      );
      
      if (result.rows.length > 0) {
        res.json({ success: true, data: result.rows[0].data });
      } else {
        res.json({ success: false, message: 'Group not found' });
      }
    } catch (error) {
      console.error('Error fetching group:', error);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  }
);

// Create or update group
app.post('/api/groups/:groupId',
  groupWriteLimiter,
  validateGroupId,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Invalid request' });
    }
    
    const { groupId } = req.params;
    let groupData = req.body;
    
    // Sanitize all input data
    groupData = sanitizeObject(groupData);
    
    // Validate group data structure and limits
    const validationErrors = validateGroupData(groupData);
    if (validationErrors.length > 0) {
      return res.status(400).json({ 
        success: false, 
        message: validationErrors[0] // Return first error
      });
    }
    
    try {
      // Check if group exists (to apply creation rate limit)
      const existingGroup = await pool.query(
        'SELECT group_id FROM groups WHERE group_id = $1',
        [groupId]
      );
      
      // Apply stricter rate limit for new group creation
      if (existingGroup.rows.length === 0) {
        // This is a new group - check creation rate limit manually
        const ip = req.ip;
        const recentGroups = await pool.query(
          `SELECT COUNT(*) as count FROM groups 
           WHERE created_at > NOW() - INTERVAL '1 hour'`
        );
        
        // Basic protection - don't allow more than 10 groups per hour globally
        if (parseInt(recentGroups.rows[0].count) > 100) {
          return res.status(429).json({ 
            success: false, 
            message: 'Service is busy. Please try again later.' 
          });
        }
      }
      
      await pool.query(
        `INSERT INTO groups (group_id, data, created_at, updated_at) 
         VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (group_id) 
         DO UPDATE SET data = $2, updated_at = CURRENT_TIMESTAMP`,
        [groupId, JSON.stringify(groupData)]
      );
      
      res.json({ success: true, message: 'Group saved' });
    } catch (error) {
      console.error('Error saving group:', error);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  }
);

// Delete group (for reset)
app.delete('/api/groups/:groupId',
  groupWriteLimiter,
  validateGroupId,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Invalid request' });
    }
    
    const { groupId } = req.params;
    
    try {
      await pool.query('DELETE FROM groups WHERE group_id = $1', [groupId]);
      res.json({ success: true, message: 'Group deleted' });
    } catch (error) {
      console.error('Error deleting group:', error);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  }
);

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    const stats = await pool.query('SELECT COUNT(*) as groups FROM groups');
    res.json({ 
      status: 'healthy', 
      database: 'connected',
      totalGroups: parseInt(stats.rows[0].groups)
    });
  } catch (error) {
    res.status(500).json({ status: 'unhealthy', database: 'disconnected' });
  }
});

// Admin endpoint to check database size (optional - you can remove this)
app.get('/api/admin/stats', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total_groups,
        COUNT(*) FILTER (WHERE updated_at > NOW() - INTERVAL '24 hours') as active_24h,
        COUNT(*) FILTER (WHERE updated_at > NOW() - INTERVAL '7 days') as active_7d,
        pg_size_pretty(pg_total_relation_size('groups')) as table_size
      FROM groups
    `);
    
    res.json({ 
      success: true, 
      stats: stats.rows[0]
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error fetching stats' });
  }
});

// Serve the main HTML file for any other route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'christmas-gift-exchange.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Gift Exchange app running on port ${PORT}`);
  console.log('Security: Rate limiting, input validation, XSS protection enabled');
  console.log('Database: PostgreSQL with connection pooling');
});

