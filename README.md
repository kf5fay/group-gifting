# 🎄 Holiday Gift Exchange App

A festive web app for organizing gift exchanges with family and friends. Each group gets a unique shareable link, and members can add wishlists, claim gifts, and coordinate purchases.

## ✨ Features

### Core Features
- 🔗 **Unique Group Links** - Each family/group gets their own unique shareable link
- 📱 **Share Button** - Easy link copying and native mobile sharing
- 📅 **Custom Event Dates** - Set specific dates for birthdays, holidays, or any occasion
- 🎁 **Gift Management** - Add items to your wishlist (no deletion to prevent accidents)
- 👥 **Multiple Users** - Everyone in the group can join and manage their lists

### Gift Features
- ✅ **Claim Gifts** - Click to claim a gift you'll purchase
- ↩️ **Unclaim** - Change your mind? Unclaim anytime
- 🤝 **Gift Splitting** - Click a claimed gift to split the cost with someone
- 💰 **Price Ranges** - Add suggested price ranges (Under $25, $25-$50, $50-$100, $100+)
- ⭐ **Priority Levels** - Mark items as High, Medium, or Low priority
- 📝 **Notes** - Add details like size, color, links, or preferences
- ✓ **Mark as Purchased** - Track when gifts have been bought

### Privacy & UX
- 🔒 **Privacy Mode** - You can't see who claimed items on YOUR list
- 👀 **Transparency** - You CAN see who claimed items on other people's lists
- 📊 **Visual Indicators** - Clear badges for priority, price, claimed status, and split gifts
- 🎨 **Festive Design** - Christmas-themed with animated snowflakes
- 📱 **Mobile-Friendly** - Fully responsive design

## 🚀 Deployment to Railway

### Option 1: Quick Deploy (Recommended)

1. Create a Railway account at https://railway.app
2. Click "New Project"
3. Choose "Deploy from GitHub repo"
4. Connect your GitHub account and select your repo
5. Railway will auto-detect the Node.js project and deploy!

### Option 2: Railway CLI

```bash
# Install Railway CLI
npm i -g @railway/cli

# Login to Railway
railway login

# Initialize project
railway init

# Deploy
railway up
```

### Files Included for Deployment
- `christmas-gift-exchange.html` - Main application
- `server.js` - Express server to serve the app
- `package.json` - Node.js dependencies

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
   - Family/Group Name (e.g., "Smith Family")
   - Event Type (Christmas, Birthday, etc.)
   - Event Date
   - Your Name
3. Click "Create Group"
4. Share the link with your family/friends

### Everyone Else (Joiners)
1. Click the shared link
2. Enter your name
3. Click "Join Group"
4. Start adding items to your wishlist!

### Adding to Your Wishlist
1. Type what you want in the text field
2. Select priority level (optional)
3. Select price range (optional)
4. Click "Add Item"

### Claiming Gifts for Others
1. Browse other people's wishlists
2. Click "I'll Get This!" to claim a gift
3. Optionally add notes (like where you'll buy it)
4. Click "Mark as Purchased" when you've bought it

### Splitting a Gift
1. Click on any claimed (crossed-out) item
2. A popup will ask if you want to split with the current claimer
3. Click "Yes, Split It!" to join in

## 🛠️ Technical Details

### Data Storage
- Uses a **backend API with file-based storage** for true data sharing across users
- Data is stored in `groups-data.json` on the server (Railway handles persistence)
- Each group has a unique ID in the URL (hash fragment)
- Users are remembered in browser localStorage (just for convenience)
- Data structure:
```javascript
{
  groupName: "Smith Family",
  eventType: "Christmas",
  eventDate: "2024-12-25",
  people: {
    "John": {
      items: [
        {
          description: "Blue sweater",
          priority: "high",
          price: "$25-$50",
          notes: "Size L, prefer wool",
          claimedBy: ["Mary", "Bob"], // Array for split gifts
          purchased: false
        }
      ]
    }
  }
}
```

### URL Structure
```
https://your-domain.com/#abc123xyz
                          ↑
                    Unique Group ID
```

### API Endpoints
The backend provides three REST API endpoints:
- `GET /api/groups/:groupId` - Retrieve group data
- `POST /api/groups/:groupId` - Create or update group data
- `DELETE /api/groups/:groupId` - Delete group data (reset)

### Browser Compatibility
- Modern browsers (Chrome, Firefox, Safari, Edge)
- Mobile browsers (iOS Safari, Chrome Mobile)
- Requires JavaScript enabled
- Uses Web Share API when available (mobile)

## 🎨 Customization Ideas

Want to customize? Here are some ideas:
- Change color scheme in the CSS (search for `#c41e3a` and `#165b33`)
- Modify snowflake effect (search for `createSnowflake()`)
- Add more event types in the dropdown
- Adjust price ranges
- Add more priority levels

## 🐛 Troubleshooting

**Q: Link doesn't work for others?**
- Make sure they're using the full URL including the `#` and ID after it
- Check that your Railway app is still running

**Q: Data disappeared?**
- Check if the Railway app restarted (data persists in `groups-data.json`)
- Make sure the file wasn't deleted from the server

**Q: Can't see others' lists?**
- Make sure everyone is using the SAME link (with the same group ID)
- Try refreshing the page
- Check that the backend API is responding (look in browser console for errors)

**Q: Changes not showing up for others?**
- Have them refresh their browser
- Check Railway logs for any errors

## 📝 License

Free to use and modify for personal or commercial purposes!

## 🎁 Future Enhancement Ideas

- Real-time updates (WebSockets for instant syncing without refresh)
- Email/SMS notifications when someone claims your item
- Export lists as PDF/CSV
- Import wishlists from Amazon/other sites
- Theme customization (beyond Christmas)
- Anonymous claiming mode
- Budget tracking per person
- Gift recommendations based on interests
- Integration with online stores
- Mobile app version
- User accounts with profiles and history
- Comment threads on items
- Image uploads for gifts
- Database backup/restore feature

---

Made with ❄️ and ❤️ for holiday gift giving!
