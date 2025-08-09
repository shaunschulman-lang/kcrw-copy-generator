
# KCRW Copy Generator (Netlify Functions)

This package includes a backend **Netlify Function** that fetches public information and a static `index.html` frontend.

## One-time setup (no GitHub required)

1. Install Netlify CLI  
   ```bash
   npm install -g netlify-cli
   ```

2. Log in  
   ```bash
   netlify login
   ```

3. Deploy this folder (unzip it first) as a production site  
   ```bash
   netlify deploy --prod
   ```

   - When prompted for the **publish directory**, type `.` (a single dot).
   - CLI will create a site and upload the function at `/.netlify/functions/scrape`.

After that, open the URL the CLI prints. The app will call the backend function to gather facts and generate options.

## What the function does
- Fetches the provided website homepage.
- Pulls Wikipedia first-paragraph extract if available.
- As a fallback, uses DuckDuckGo to discover one additional public page (no API keys).
- Extracts neutral facts (title/meta description, plus heuristics like “founded in …”, “headquartered in …”).

> You can add API keys later (e.g., Bing or Google Custom Search) by editing `netlify/functions/scrape.js` to improve coverage.
