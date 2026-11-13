AGSB Claims app - setup (about 10 minutes, once)

1. Update the Apps Script
   - Open the claims Google Sheet > Extensions > Apps Script.
   - Replace Code.gs with the new Code.gs (sent with this app). Save.
   - Deploy > Manage deployments > pencil icon > Version: New version > Deploy.
   - Copy the Web app URL (ends in /exec).

2. The link is already in config.js (done)
   - If you ever redeploy as a NEW deployment (new link), edit config.js on GitHub.

3. Put the app online (free) with GitHub Pages
   - Sign in at github.com (create a free account if needed).
   - New repository > name it agsb-claims > Public > Create.
   - "uploading an existing file" > drag in everything in this folder
     (index.html, app.js, config.js, sw.js, manifest.webmanifest, README.txt and the icons folder) > Commit.
   - Settings > Pages > Source: Deploy from a branch > Branch: main, / (root) > Save.
   - After 1-2 minutes the app is at https://YOUR-GITHUB-NAME.github.io/agsb-claims/

4. Install on phones
   - Android (Chrome): open the link > menu (three dots) > Install app / Add to Home screen.
   - iPhone (Safari): open the link > Share > Add to Home Screen.
   - First time: pick your name (and the access code, if one is set in Settings!B3).

Updating later: change a file on GitHub; phones get the new version next time the app opens with internet.
