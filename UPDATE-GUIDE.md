# 🔧 Update Guide - Sharing Fix

## What Was Fixed

The original version had a critical bug: **sharing links didn't work** because data was stored in each user's browser (localStorage) instead of on a shared server.

This update adds a **proper backend API** so everyone who clicks your link can actually join your group and see the same data!

## What Changed

### Backend (server.js)
- ✅ Added REST API endpoints for saving/loading group data
- ✅ Data now stored in `groups-data.json` on the server
- ✅ All users share the same data via the API

### Frontend (christmas-gift-exchange.html)
- ✅ Replaced localStorage calls with API calls
- ✅ Added async/await for data operations
- ✅ Auto-refreshes data after changes

### Other Files
- Updated `.gitignore` to exclude `groups-data.json`
- Updated `README.md` with backend info
- Updated `DEPLOYMENT.md` with testing steps

## How to Update Your Existing Deployment

If you already deployed the old version to Railway, here's how to update:

### Option 1: GitHub Push (Recommended)

```bash
# In your project folder, replace the files with new ones
# Then commit and push:

git add .
git commit -m "Fix: Add backend API for proper data sharing"
git push

# Railway will auto-deploy the update!
```

### Option 2: Redeploy from Scratch

1. Delete your existing Railway project
2. Create a new one
3. Connect your GitHub repo again
4. Railway will deploy with the new code

## Testing the Fix

After updating:

1. Create a new group
2. Copy the share link
3. Open it in an incognito/private window
4. You should see the group join screen (not setup)
5. Join with a different name
6. Add items to your wishlist
7. Go back to your original window
8. Refresh and see the other person's items!

## Important Notes

- Old groups from the localStorage version **won't** transfer automatically
- Users will need to create new groups with the updated version
- Data now persists on Railway's server (in `groups-data.json`)
- The file survives app restarts and redeployments

## If You Have Issues

1. Check Railway logs for errors
2. Make sure all three files are updated:
   - `christmas-gift-exchange.html`
   - `server.js`
   - `.gitignore`
3. Clear your browser cache
4. Try in an incognito window

## What Stays the Same

- All the features still work exactly as before
- UI looks identical
- Unique shareable links
- No login required
- Mobile-friendly

The only difference is now **sharing actually works!** 🎉

---

Need help? Open an issue or check Railway logs for errors.
