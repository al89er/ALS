# ALS Desktop Applications

This directory contains the desktop automation clients for the ALS Platform:
- **ALS Single Agent** (`ALS-Full-Setup-<version>.exe`)
- **ALS Server Hub** (`ALS-Hub-Setup-<version>.exe`)
- **ALS Lite Client** (`ALS-Lite-Setup-<version>.exe`)

---

## ⚡ Quick Guide: Pushing Code & UI Updates (No Installer Required!)

Thanks to the **Modular Hot-Update Architecture**, you do **not** need to rebuild the ~90MB NSIS installer every time you edit code or UI screens.

1. **Edit the file** in `desktop-app/` (e.g. `automation.js`, `hub-client.js`, `scheduler.js`, `hub-ui.html`, etc.).
2. **Run the manifest generator & auto-versioner**:
   ```bash
   npm run update-manifest
   ```
   *(Automatically detects modified files via SHA-256 hash comparison, auto-bumps their `VERSION` constant in-place, validates JS AST syntax, updates `modules-manifest.json`, and syncs `package.json`!)*
3. **Run tests**:
   ```bash
   npm test
   ```
4. **Git push to `main`**:
   ```bash
   git add desktop-app/ modules-manifest.json
   git commit -m "feat: update automation portal selector"
   git push origin main
   ```
5. **Users/Hub receive update**:
   The desktop apps detect the new manifest and download/install the updated modules in milliseconds!

For complete architectural details and fail-safe documentation, see:
👉 [**Full Modular Hot-Update Guide (`docs/MODULAR_AUTO_UPDATE_GUIDE.md`)**](../docs/MODULAR_AUTO_UPDATE_GUIDE.md)

---

## 🛠️ Full Build Commands (Only for Host Shell Upgrades)

If you need to recompile the static Host Shell (e.g. upgrading Electron, Playwright binary, or native dependencies):

```bash
# Build Single Agent (Full Edition)
npm run build:full

# Build Multi-Account Server Hub
npm run build:hub

# Build Lightweight Headless Client
npm run build:lite

# Build All 3 Editions
npm run build:all
```
Installers will be generated in `C:\Temp\ALS-releases\v<version>\` and copied to `releases/v<version>/` and `dist/`.
