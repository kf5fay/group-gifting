const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(__dirname));

// PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? {
    rejectUnauthorized: false
  } : false
});

// Initialize database table
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS groups (
        group_id VARCHAR(255) PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
  }
}

initDatabase();

// API Routes

// Get group data
app.get('/api/groups/:groupId', async (req, res) => {
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
});

// Create or update group
app.post('/api/groups/:groupId', async (req, res) => {
  const { groupId } = req.params;
  const groupData = req.body;
  
  try {
    await pool.query(
      `INSERT INTO groups (group_id, data, updated_at) 
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (group_id) 
       DO UPDATE SET data = $2, updated_at = CURRENT_TIMESTAMP`,
      [groupId, JSON.stringify(groupData)]
    );
    
    res.json({ success: true, message: 'Group saved' });
  } catch (error) {
    console.error('Error saving group:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Delete group (for reset)
app.delete('/api/groups/:groupId', async (req, res) => {
  const { groupId } = req.params;
  
  try {
    await pool.query('DELETE FROM groups WHERE group_id = $1', [groupId]);
    res.json({ success: true, message: 'Group deleted' });
  } catch (error) {
    console.error('Error deleting group:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'healthy', database: 'connected' });
  } catch (error) {
    res.status(500).json({ status: 'unhealthy', database: 'disconnected' });
  }
});

// Serve the main HTML file for any other route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'christmas-gift-exchange.html'));
});

app.listen(PORT, () => {
  console.log(`Gift Exchange app running on port ${PORT}`);
  console.log('Database: PostgreSQL');
});
