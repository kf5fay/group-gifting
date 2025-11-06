const express = require('express');
const path = require('path');
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
      frameSrc: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

// JSON parsing with size limit
app.use(express.json({ limit: '1mb' }));

// Serve static files
app.use(express.static(__dirname));

// Rate limiting - General protection
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: { success: false, message: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter rate limit for API operations
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  message: { success: false, message: 'Too many API requests, please slow down.' }
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

// Apply general rate limiting to all requests
app.use(generalLimiter);

// PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Database initialization
pool.query(`
  CREATE TABLE IF NOT EXISTS groups (
    group_id VARCHAR(255) PRIMARY KEY,
    data JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).then(() => {
  console.log('✅ Database initialized successfully');
}).catch(err => {
  console.error('❌ Database initialization error:', err);
});

// Helper function to sanitize strings
function sanitizeString(str, maxLength = 500) {
  if (typeof str !== 'string') return '';
  
  // Remove any HTML tags and scripts
  let sanitized = str.replace(/<[^>]*>/g, '');
  
  // Remove potentially dangerous characters
  sanitized = sanitized.replace(/[<>\"\']/g, '');
  
  // Trim and limit length
  sanitized = sanitized.trim().substring(0, maxLength);
  
  return sanitized;
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
                : []
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

// GET group data
app.get('/api/groups/:groupId', apiLimiter, async (req, res) => {
  try {
    const groupId = req.params.groupId;
    
    // Validate groupId format
    if (!groupId || groupId.length > 255 || !/^[a-zA-Z0-9-_]+$/.test(groupId)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid group ID format' 
      });
    }
    
    const result = await pool.query(
      'SELECT data FROM groups WHERE group_id = $1',
      [groupId]
    );
    
    if (result.rows.length === 0) {
      return res.json({ success: true, data: null });
    }
    
    res.json({ success: true, data: result.rows[0].data });
  } catch (error) {
    console.error('Error loading group:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error loading group data' 
    });
  }
});

// POST/UPDATE group data
app.post('/api/groups/:groupId', apiLimiter, async (req, res) => {
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
      'SELECT group_id FROM groups WHERE group_id = $1',
      [groupId]
    );
    
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

// DELETE group
app.delete('/api/groups/:groupId', apiLimiter, async (req, res) => {
  try {
    const groupId = req.params.groupId;
    
    // Validate groupId format
    if (!groupId || groupId.length > 255 || !/^[a-zA-Z0-9-_]+$/.test(groupId)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid group ID format' 
      });
    }
    
    await pool.query('DELETE FROM groups WHERE group_id = $1', [groupId]);
    res.json({ success: true, message: 'Group deleted successfully' });
  } catch (error) {
    console.error('Error deleting group:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error deleting group' 
    });
  }
});

// Contact form endpoint - LOGS TO CONSOLE ONLY (no email)
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
    
    // Log to console (you can check Railway logs)
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

// Cleanup old groups (optional - runs once when server starts)
async function cleanupOldGroups() {
  try {
    // Delete groups older than 2 years
    const result = await pool.query(
      "DELETE FROM groups WHERE updated_at < NOW() - INTERVAL '2 years'"
    );
    if (result.rowCount > 0) {
      console.log(`✅ Cleaned up ${result.rowCount} old groups`);
    }
  } catch (error) {
    console.error('Error cleaning up old groups:', error);
  }
}

// Run cleanup on startup
cleanupOldGroups();

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
  console.log(`✅ Data retention: 2 years`);
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
