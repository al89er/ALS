# ALS (Autonomous Logging System)

ALS is a dual-architecture automation engine designed to seamlessly handle recurring portal-based tasks via an isolated local desktop agent, fully remote-controllable through a cloud-synced web dashboard.

## 🏗️ Architecture

ALS operates on a hybrid Local/Cloud architecture to bypass CORS limitations while maintaining full remote accessibility:

1. **Local Desktop Agent (`/desktop-app`)**
   - Built on **Electron** and **Node.js**.
   - Uses **Playwright** for headless (or headful) DOM manipulation, iframe traversal, and secure authentication.
   - Houses an autonomous `node-cron` scheduler that runs silently in the system tray, generating randomized target execution times to simulate human activity.
   - Detects network drops and captive portals securely via HTTP checks.

2. **Cloud Backend (Supabase)**
   - Utilizes a PostgreSQL database to maintain system state.
   - Leverages **Supabase Realtime Channels** to instantly bridge the local Electron app and the remote Web Dashboard.
   - **Tables**: `device_status` (heartbeat), `config` (proofs, skip dates, schedules), `logs` (real-time terminal output), `commands` (remote execution triggers).

3. **Web Dashboard (`index.html`)**
   - A pure HTML/CSS/Vanilla JS Single Page Application (SPA).
   - Hosted effortlessly via GitHub Pages.
   - Features a premium dark-themed Glassmorphism UI.
   - Connects to Supabase via CDN to command the local agent and stream execution logs live from anywhere in the world.

## ✨ Core Features

- **Autonomous Randomization**: Generates randomized execution windows (e.g., 07:45 - 07:50) daily to prevent rigid fingerprinting.
- **Pre-Flight Checks**: Before triggering any DOM interactions, the agent scrapes the target portal to check if the action was already completed manually by the user, skipping the automation if true.
- **Smart Iframe Traversal**: Dynamically hunts for target elements across complex, nested, or obfuscated iframe structures.
- **Remote Execution**: Hit a button on your phone, and the command streams through Supabase down to your local desktop to boot Playwright and execute instantly.
- **Manual Proof Sync**: A safe, read-only remote macro that allows users to scrape dashboard proof data without triggering click events.
- **Calendar Skips**: Interactive 14-day UI grid allowing users to halt the local automation engine on specific dates (holidays/leave). Weekends are skipped automatically.
- **Telegram Webhooks**: Native push notifications for success states, failures, and captive portal interceptions.

## 🚀 Setup & Installation

### 1. Environment Configuration
Create a `.env` file inside the `/desktop-app` directory with the following keys:
```env
# Credentials
UPM_USERNAME=your_username
UPM_PASSWORD=your_password

# Supabase Keys (Used by both Local Agent and Web Dashboard)
SUPABASE_URL=https://<YOUR_ID>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<YOUR_SERVICE_KEY>

# Telegram (Optional)
TELEGRAM_BOT_TOKEN=<YOUR_BOT_TOKEN>
TELEGRAM_CHAT_ID=<YOUR_CHAT_ID>
```

### 2. Desktop Agent
```bash
cd desktop-app
npm install
npm start
```
*Note: The app will run in the background. Look for the ALS icon in your Windows System Tray.*

### 3. Web Dashboard
Deploy the root repository to **GitHub Pages** (or any static host). Access your URL on any device to view your active logs and manage the agent.

## 🛡️ Security Note
The Web Dashboard relies purely on Supabase Row Level Security (or Anon keys) and does not store the target portal's credentials. All authentication injection (`UPM_USERNAME`) occurs exclusively on the local host machine running the Electron agent.
