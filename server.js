const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(__dirname));

// Data storage file
const DATA_FILE = path.join(__dirname, 'groups-data.json');

// Initialize data file if it doesn't exist
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({}));
}

// Helper functions
function readData() {
  try {
    const data = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return {};
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// API Routes

// Get group data
app.get('/api/groups/:groupId', (req, res) => {
  const { groupId } = req.params;
  const allData = readData();
  
  if (allData[groupId]) {
    res.json({ success: true, data: allData[groupId] });
  } else {
    res.json({ success: false, message: 'Group not found' });
  }
});

// Create or update group
app.post('/api/groups/:groupId', (req, res) => {
  const { groupId } = req.params;
  const groupData = req.body;
  
  const allData = readData();
  allData[groupId] = groupData;
  writeData(allData);
  
  res.json({ success: true, message: 'Group saved' });
});

// Delete group (for reset)
app.delete('/api/groups/:groupId', (req, res) => {
  const { groupId } = req.params;
  
  const allData = readData();
  delete allData[groupId];
  writeData(allData);
  
  res.json({ success: true, message: 'Group deleted' });
});

// Serve the main HTML file for any other route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'christmas-gift-exchange.html'));
});

app.listen(PORT, () => {
  console.log(`Gift Exchange app running on port ${PORT}`);
});
