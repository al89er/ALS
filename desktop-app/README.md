# ALS Desktop Applications

This directory contains the desktop automation clients for the ALS Platform:
- **ALS Single Agent** (`ALS-Full-Setup-<version>.exe`)
- **ALS Server Hub** (`ALS-Hub-Setup-<version>.exe`)
- **ALS Lite Client** (`ALS-Lite-Setup-<version>.exe`)

---

## ⚡ Quick Guide: Pushing Code & UI Updates (No Installer Required!)

Thanks to the **Modular Hot-Update Architecture**, you do **not** need to rebuild the ~90MB NSIS installer every time you edit code or UI screens.

1. **Edit the file** in `desktop-app/` (e.g. `automation.js`, `hub-client.js`, `scheduler.js`, `hub-ui.html`, etc.).
2. **Bump `VERSION`** inside the modified file (e.g. `const VERSION = '1.5.9';`).
3. **Run the manifest generator**:
   ```bash
   npm run update-manifest
   ```
   *(This calculates SHA-256 hashes, validates JS syntax AST, and writes `modules-manifest.json`)*
4. **Run tests**:
   ```bash
   npm test
   ```
5. **Git push to `main`**:
   ```bash
   git add <modified-files> modules-manifest.json
   git commit -m "feat: update automation portal selector"
   git push origin main
   ```
6. **Users/Hub receive update**:
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
