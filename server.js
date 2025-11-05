const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(__dirname));

// Serve the main HTML file for any route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'christmas-gift-exchange.html'));
});

app.listen(PORT, () => {
  console.log(`Gift Exchange app running on port ${PORT}`);
});
