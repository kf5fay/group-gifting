# 🎄 ComeGiftIt - Holiday Gift Exchange App

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
- 🔒 **Creator Controls** - Only the group creator can reset all data, edit any item, or remove users

### Gift Coordination Features
- ✅ **Claim Gifts** - Click to claim a gift you'll purchase
- ↩️ **Unclaim** - Change your mind? Unclaim anytime
- 🤝 **Gift Splitting** - Click a claimed gift to split the cost with someone
- 💰 **Price Ranges** - Add suggested price ranges (Under $25, $25-$50, $50-$100, Over $100)
- ⭐ **Priority Levels** - Mark items as High, Medium, or Low priority
- 📝 **Details & Links** - Add notes like size, color, links (automatically clickable!), or preferences
- ✓ **Mark as Purchased** - Track when gifts have been bought

### The Magic: Gift Surprise Preservation 🎁
- 🎁 **Recipients Can't See Claims** - When viewing YOUR OWN wishlist, you can't see:
  - Who claimed your items
  - That your items were claimed at all
  - Purchase status
  - Split gift status
- 👀 **Gift Givers See Everything** - When viewing OTHERS' wishlists, you can see:
  - All claim status and who claimed what
  - Purchase status
  - Split gift participants
  - Full coordination info
- **Result**: Perfect gift coordination without spoiling the surprise!

### Group Management (Creator Only)
- ✏️ **Edit Any Item** - Fix typos or update details on anyone's wishlist
- 👤 **Remove Users** - Delete accidentally added users (misspelled names, test accounts, etc.)
- 🗑️ **Reset Group** - Complete group reset when needed

### Design & UX
- 📊 **Visual Indicators** - Clear badges for priority, price, claimed status, and split gifts
- 🎨 **Theme-Matched Headers** - Icons change based on event type (🎄 for Christmas, 🕎 for Hanukkah, etc.)
- 📱 **Mobile-Friendly** - Fully responsive design
- 🌮 **Support the Creator** - Optional donation banner (buy me a taco!)

### Security & Privacy
- 🔒 **No Accounts Required** - No passwords, no email verification
- 🛡️ **Enterprise-Grade Security** - Helmet, rate limiting, input validation, XSS protection
- 🗄️ **PostgreSQL Database** - Reliable, scalable data storage
- 🕐 **2-Year Data Retention** - Groups automatically deleted after 2 years
- 📧 **Contact Form** - Built-in feedback system via Web3Forms

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
   - No additional config needed!

### Optional: Set Up Contact Form Email
The app includes a contact form that uses Web3Forms (free service):
1. Sign up at https://web3forms.com
2. Get your access key
3. Replace the access key in `index.html` (search for "access_key")

### Files Included for Deployment
- `index.html` - Main application (single-page app)
- `server.js` - Express server with PostgreSQL
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

### Group Creator Powers
As the group creator, you have special abilities:
- **Edit Any Item**: Fix typos or update details on anyone's wishlist with the ✏️ Edit button
- **Remove Users**: Delete accidentally added users with the "Remove User" button
- **Reset Group**: Nuclear option - delete all data and start fresh

### Viewing the App
- **Your Own Wishlist**: Clean view - no claim status (keeps the surprise!)
- **Others' Wishlists**: Full coordination info - see who claimed what, purchases, splits

## 🛠️ Technical Details

### Data Storage
- Uses **PostgreSQL database** for reliable, scalable data storage
- Each group has a unique ID in the URL (hash fragment)
- Users are remembered in browser localStorage for convenience
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
          description: "Blue sweater",
          priority: "high",
          price: "$25-$50",
          details: "Size L, prefer wool, https://amazon.com/...",
          notes: "Found at Target",
          claimedBy: ["Mary", "Bob"], // Array for split gifts
          purchased: false,
          splitWith: ["Bob"]
        }
      ]
    }
  }
}
```

### Database Schema
```sql
CREATE TABLE groups (
  group_id VARCHAR(255) PRIMARY KEY,
  data JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### URL Structure
```
https://comegiftit.up.railway.app/#abc123xyz
                                  ↑
                           Unique Group ID
```

### API Endpoints
The backend provides three REST API endpoints:
- `GET /api/groups/:groupId` - Retrieve group data
- `POST /api/groups/:groupId` - Create or update group data
- `DELETE /api/groups/:groupId` - Delete group data (reset)
- `GET /api/health` - Health check endpoint

### Rate Limiting
- **Read operations** (GET): 100 requests/minute
- **Write operations** (POST/DELETE): 30 requests/minute
- **Group creation**: 10 groups/hour
- **Contact form**: 3 submissions/hour
- **General limit**: 1000 requests/15 minutes
- **Polling**: Updates every 10 seconds

### Security Features
- Helmet.js for security headers
- Input validation and sanitization
- XSS protection
- SQL injection prevention
- Rate limiting on all endpoints
- No sensitive data stored

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
- Verify Web3Forms access key is configured in `index.html`
- Check browser console for errors
- Rate limit: 3 submissions per hour

## 📝 License

Free to use and modify for personal or commercial purposes!

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
