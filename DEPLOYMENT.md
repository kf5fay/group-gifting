# 🚀 Railway Deployment Checklist

## Pre-Deployment
- [ ] All files are in a folder together:
  - christmas-gift-exchange.html
  - server.js
  - package.json
  - .gitignore
  - README.md

## GitHub Setup (Recommended Method)
- [ ] Create a new GitHub repository
- [ ] Push all files to GitHub:
  ```bash
  git init
  git add .
  git commit -m "Initial commit"
  git branch -M main
  git remote add origin YOUR_GITHUB_REPO_URL
  git push -u origin main
  ```

## Railway Deployment
- [ ] Go to https://railway.app
- [ ] Sign up or log in
- [ ] Click "New Project"
- [ ] Select "Deploy from GitHub repo"
- [ ] Choose your repository
- [ ] Railway auto-detects Node.js and deploys
- [ ] Wait for deployment (usually 1-2 minutes)
- [ ] Click "Generate Domain" to get your public URL

## Post-Deployment
- [ ] Visit your Railway URL
- [ ] Test creating a new group
- [ ] Copy the unique link (including the #groupId part)
- [ ] Open the link in a different browser or incognito window
- [ ] Test that you can join the group and see it properly
- [ ] Share the unique link with a friend/family member
- [ ] Test that they can join and add items
- [ ] Test claiming gifts
- [ ] Test the split gift feature
- [ ] Verify data persists after refresh

## Alternative: Railway CLI
```bash
# Install Railway CLI
npm i -g @railway/cli

# Login
railway login

# Initialize
railway init

# Deploy
railway up

# Get your URL
railway domain
```

## Troubleshooting

### Railway Build Fails
- Check that package.json has correct syntax
- Verify server.js is in the root directory
- Check Railway logs for error messages

### App Doesn't Load
- Verify domain is generated in Railway settings
- Check that PORT environment variable is being used
- Review server logs in Railway dashboard

### Sharing Not Working
- **This is now fixed!** The app uses a backend API so data is shared properly
- Make sure you copy the FULL URL including the `#groupId` part
- Test in an incognito window to verify sharing works

### Data Not Persisting
- Railway automatically persists the `groups-data.json` file
- Data survives app restarts and redeployments
- Only gets cleared if you manually delete it or reset from the app

## Environment Variables (Optional)
Railway automatically sets:
- `PORT` - The port your app runs on

You can add custom ones in Railway settings if needed.

## Custom Domain (Optional)
1. Go to your Railway project
2. Click "Settings"
3. Scroll to "Domains"
4. Click "Add Custom Domain"
5. Follow Railway's instructions to configure DNS

## Monitoring
- Railway dashboard shows:
  - Deployment logs
  - Runtime logs
  - Resource usage
  - Uptime metrics

## Cost
- Railway offers a free tier
- Perfect for personal projects like this
- No credit card required for starter plan

---

Need help? Check out Railway's docs: https://docs.railway.app
