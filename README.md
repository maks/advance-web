# picoTracker Advance Web

WebAssembly distribution of **picoTracker Advance**.

## Free Hosting via GitHub Pages

This repository is ready to be hosted on GitHub Pages:

1. Create a repository on GitHub (e.g. `advance-web` or `picotracker`).
2. Add your GitHub remote and push:
   ```bash
   git remote add origin git@github.com:<YOUR-USER>/<YOUR-REPO>.git
   git push -u origin main
   ```
3. In your GitHub repository:
   - Go to **Settings** &rarr; **Pages**.
   - Under **Build and deployment** &rarr; **Source**, select **GitHub Actions**.
4. The workflow in `.github/workflows/deploy.yml` will automatically deploy your site!

### Cross-Origin Isolation (SharedArrayBuffer)

picoTracker utilizes WebAssembly pthreads and AudioWorklet which require Cross-Origin Isolation (`COOP`/`COEP` headers).
- **GitHub Pages**: Enabled automatically via the included `coi-serviceworker.js`.
- **Cloudflare Pages / Netlify**: Supported natively via the included `_headers` configuration.
