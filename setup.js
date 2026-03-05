/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  DISCORD MUSIC BOT — ONE-COMMAND BOOTSTRAP                  ║
 * ║  This script auto-installs ALL dependencies, generates      ║
 * ║  .env if missing, installs Java + yt-dlp, and starts bot    ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Usage:  node setup.js
 *    or:  npm start
 */

import { execSync, spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

const cliArgs = new Set(process.argv.slice(2));
const AUTO_MODE = cliArgs.has('--auto') || process.env.SETUP_AUTO === 'true';
const WITH_MONGO = cliArgs.has('--with-mongo') || process.env.SETUP_WITH_MONGO === 'true';
const NO_MONGO = cliArgs.has('--no-mongo') || process.env.SETUP_NO_MONGO === 'true';
const RECONFIGURE = cliArgs.has('--reconfigure') || process.env.SETUP_RECONFIGURE === 'true';
const NO_START = cliArgs.has('--no-start');

// ─── Pretty console ────────────────────────────────────────────
const C = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    cyan: '\x1b[36m',
    magenta: '\x1b[35m',
    blue: '\x1b[34m',
};

function log(msg) { console.log(`${C.cyan}[SETUP]${C.reset} ${msg}`); }
function ok(msg)  { console.log(`${C.green}  ✓${C.reset} ${msg}`); }
function warn(msg){ console.log(`${C.yellow}  ⚠${C.reset} ${msg}`); }
function err(msg) { console.log(`${C.red}  ✗${C.reset} ${msg}`); }
function header(msg) {
    console.log('');
    console.log(`${C.bold}${C.magenta}${'═'.repeat(55)}${C.reset}`);
    console.log(`${C.bold}${C.magenta}  ${msg}${C.reset}`);
    console.log(`${C.bold}${C.magenta}${'═'.repeat(55)}${C.reset}`);
}

// ─── Detect platform ───────────────────────────────────────────
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';

// ─── Helpers ───────────────────────────────────────────────────
function cmdExists(cmd) {
    try {
        if (IS_WIN) {
            execSync(`where ${cmd}`, { stdio: 'ignore', timeout: 10000 });
        } else {
            execSync(`which ${cmd}`, { stdio: 'ignore', timeout: 10000 });
        }
        return true;
    } catch {
        return false;
    }
}

function runCmd(cmd, options = {}) {
    try {
        return execSync(cmd, {
            stdio: options.silent ? 'pipe' : 'inherit',
            timeout: options.timeout || 300000,
            encoding: 'utf-8',
            ...options,
        });
    } catch (e) {
        if (!options.ignoreError) throw e;
        return null;
    }
}

function askQuestion(question, defaultValue = '') {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const prompt = defaultValue
        ? `${C.cyan}  ?${C.reset} ${question} ${C.dim}(${defaultValue})${C.reset}: `
        : `${C.cyan}  ?${C.reset} ${question}: `;

    return new Promise((resolve) => {
        rl.question(prompt, (answer) => {
            rl.close();
            resolve(answer.trim() || defaultValue);
        });
    });
}

function randomSecret(size = 24) {
    return randomBytes(size).toString('hex');
}

function getEnvValue(content, key) {
    const match = content?.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return match?.[1]?.trim() || '';
}

function isLocalMongoUri(uri) {
    if (!uri) return true;
    const normalized = uri.trim();
    if (!normalized.startsWith('mongodb://') && !normalized.startsWith('mongodb+srv://')) return false;
    return /(localhost|127\.0\.0\.1|::1)/i.test(normalized);
}

function isPortListening(port) {
    try {
        const out = runCmd(`ss -ltn | grep -E ':${port}\\s'`, { silent: true, ignoreError: true }) || '';
        return out.includes(`:${port}`);
    } catch {
        return false;
    }
}

async function ensureLavalinkBeforeBot() {
    header('Starting Lavalink (pre-bot)');

    const { config } = await import('./src/config/env.js');
    if (!config.lavalink.enableLocalFallback || !config.lavalink.local.manage) {
        warn('Local Lavalink management disabled — expecting external node(s)');
        return { ok: true, prestarted: false };
    }

    // Check for port conflicts before starting
    const port = config.lavalink.local.port || 2333;
    if (isPortListening(port)) {
        // Check if it's our Lavalink already
        try {
            const check = execSync(`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/version`, { encoding: 'utf-8', timeout: 5000 }).trim();
            if (check === '200' || check === '401') {
                ok(`Lavalink already running on port ${port}`);
                return { ok: true, prestarted: true };
            }
        } catch {}
        warn(`Port ${port} is already in use — killing existing process...`);
        try { execSync(`kill -9 $(lsof -t -i:${port}) 2>/dev/null`, { timeout: 5000 }); } catch {}
        await new Promise(r => setTimeout(r, 2000));
    }

    const { startLavalink } = await import('./src/music/lavalinkManager.js');
    const ready = await startLavalink();

    if (!ready) {
        warn('Lavalink failed to start — bot will rely on yt-dlp fallback or external nodes');
        return { ok: false, prestarted: false };
    }

    ok('Lavalink is ready before bot startup');
    return { ok: true, prestarted: true };
}

// ─── Pre-flight: Sync slash commands ───────────────────────────
async function syncSlashCommands() {
    header('Syncing slash commands');

    try {
        const { validateEnv, config } = await import('./src/config/env.js');
        validateEnv();

        const { REST, Routes } = await import('discord.js');
        const { loadCommands } = await import('./src/loader.js');

        const holder = { commands: new Map() };
        await loadCommands(holder);

        const commands = [...holder.commands.values()].map(cmd => cmd.data.toJSON());
        const rest = new REST({ version: '10' }).setToken(config.token);

        log(`Deploying ${commands.length} commands globally...`);
        await rest.put(Routes.applicationCommands(config.clientId), { body: commands });

        ok(`${commands.length} slash commands synced`);
        return true;
    } catch (e) {
        warn(`Command sync failed: ${e.message}`);
        warn('Commands will be synced when the bot starts');
        return false;
    }
}

// ─── Step 1: Node.js version check ────────────────────────────
function checkNodeVersion() {
    header('Checking Node.js');
    const version = process.versions.node;
    const major = parseInt(version.split('.')[0], 10);
    if (major < 18) {
        err(`Node.js ${version} is too old. Need v18+. Download: https://nodejs.org`);
        process.exit(1);
    }
    ok(`Node.js v${version}`);
}

// ─── Step 2: Install npm dependencies ──────────────────────────
function installNpmDeps() {
    header('Installing npm dependencies');
    if (!existsSync(join(ROOT, 'node_modules'))) {
        log('Running npm install...');
        runCmd('npm install', { cwd: ROOT });
        ok('Dependencies installed');
    } else {
        // Check if all deps are there
        try {
            runCmd('npm ls --depth=0', { cwd: ROOT, silent: true, ignoreError: true });
            ok('Dependencies already installed');
        } catch {
            log('Repairing dependencies...');
            runCmd('npm install', { cwd: ROOT });
            ok('Dependencies repaired');
        }
    }
}

// ─── Step 3: Install Java ──────────────────────────────────────
async function installJava() {
    header('Checking Java (for Lavalink)');

    // Check if java already exists
    try {
        const output = execSync('java -version 2>&1', { encoding: 'utf-8', timeout: 10000 });
        const match = output.match(/version "(\d+)/);
        const ver = match ? parseInt(match[1], 10) : 0;
        if (ver >= 17) {
            ok(`Java ${ver} installed`);
            return true;
        }
        warn(`Java ${ver} found but Lavalink needs 17+, upgrading...`);
    } catch {
        warn('Java not found — installing automatically...');
    }

    // Auto-install Java based on OS
    try {
        if (IS_WIN) {
            // Try winget first (Windows 10/11)
            if (cmdExists('winget')) {
                log('Installing Java 21 via winget (this may take a few minutes)...');
                runCmd('winget install EclipseAdoptium.Temurin.21.JRE --accept-source-agreements --accept-package-agreements', {
                    cwd: ROOT,
                    ignoreError: true,
                    timeout: 600000, // 10 min
                });
            } else {
                // Try chocolatey
                if (cmdExists('choco')) {
                    log('Installing Java 21 via Chocolatey...');
                    runCmd('choco install temurin21jre -y', { ignoreError: true, timeout: 600000 });
                } else {
                    err('No package manager found (winget/choco). Please install Java 17+ manually.');
                    err('Download: https://adoptium.net/');
                    return false;
                }
            }
        } else if (IS_MAC) {
            if (cmdExists('brew')) {
                log('Installing Java 21 via Homebrew...');
                runCmd('brew install --cask temurin@21', { ignoreError: true, timeout: 600000 });
            } else {
                err('Homebrew not found. Please install Java 17+ manually: https://adoptium.net/');
                return false;
            }
        } else if (IS_LINUX) {
            log('Installing Java 21 via apt...');
            runCmd('sudo apt-get update -qq && sudo apt-get install -y -qq temurin-21-jre 2>/dev/null || sudo apt-get install -y -qq openjdk-21-jre-headless', {
                ignoreError: true,
                timeout: 600000,
            });
        }

        // Verify installation
        // Refresh PATH on Windows
        if (IS_WIN) {
            try {
                const newPath = execSync('cmd /c "echo %PATH%"', { encoding: 'utf-8' }).trim();
                process.env.PATH = newPath;
            } catch {}
        }

        try {
            const output = execSync('java -version 2>&1', { encoding: 'utf-8', timeout: 10000 });
            ok(`Java installed: ${output.split('\n')[0].trim()}`);
            return true;
        } catch {
            warn('Java installed but may need a terminal restart to be on PATH.');
            warn('Lavalink will be skipped — yt-dlp fallback will be used.');
            return false;
        }
    } catch (e) {
        warn(`Java auto-install failed: ${e.message}`);
        warn('Bot will work without Java using yt-dlp fallback.');
        return false;
    }
}

// ─── Step 4: Install yt-dlp ───────────────────────────────────
function installYtDlp() {
    header('Checking yt-dlp (audio fallback)');

    if (cmdExists('yt-dlp')) {
        ok('yt-dlp already installed');
        // Update to latest
        try {
            log('Updating yt-dlp to latest...');
            runCmd('yt-dlp -U', { silent: true, ignoreError: true, timeout: 30000 });
        } catch {}
        return true;
    }

    log('Installing yt-dlp...');
    try {
        if (IS_WIN) {
            if (cmdExists('winget')) {
                runCmd('winget install yt-dlp --accept-source-agreements --accept-package-agreements', {
                    ignoreError: true,
                    timeout: 120000,
                });
            } else if (cmdExists('pip')) {
                runCmd('pip install yt-dlp', { ignoreError: true, timeout: 120000 });
            } else if (cmdExists('pip3')) {
                runCmd('pip3 install yt-dlp', { ignoreError: true, timeout: 120000 });
            } else {
                // Direct download as last resort
                log('Downloading yt-dlp.exe directly...');
                runCmd('powershell -Command "Invoke-WebRequest -Uri \'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe\' -OutFile \'yt-dlp.exe\'"', {
                    cwd: ROOT,
                    ignoreError: true,
                    timeout: 120000,
                });
                if (existsSync(join(ROOT, 'yt-dlp.exe'))) {
                    ok('yt-dlp.exe downloaded to project folder');
                    return true;
                }
            }
        } else if (IS_MAC) {
            if (cmdExists('brew')) {
                runCmd('brew install yt-dlp', { ignoreError: true, timeout: 120000 });
            } else if (cmdExists('pip3')) {
                runCmd('pip3 install yt-dlp', { ignoreError: true, timeout: 120000 });
            }
        } else if (IS_LINUX) {
            if (cmdExists('pip3')) {
                runCmd('pip3 install yt-dlp', { ignoreError: true, timeout: 120000 });
            } else {
                runCmd('sudo apt-get install -y -qq yt-dlp 2>/dev/null || sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && sudo chmod a+rx /usr/local/bin/yt-dlp', {
                    ignoreError: true,
                    timeout: 120000,
                });
            }
        }

        // Refresh PATH on Windows
        if (IS_WIN) {
            try {
                const newPath = execSync('cmd /c "echo %PATH%"', { encoding: 'utf-8' }).trim();
                process.env.PATH = newPath;
            } catch {}
        }

        if (cmdExists('yt-dlp') || existsSync(join(ROOT, 'yt-dlp.exe'))) {
            ok('yt-dlp installed');
            return true;
        } else {
            warn('yt-dlp install may need terminal restart. Will retry at runtime.');
            return false;
        }
    } catch (e) {
        warn(`yt-dlp auto-install failed: ${e.message}`);
        warn('Music will only work with Lavalink. Install yt-dlp manually: pip install yt-dlp');
        return false;
    }
}

// ─── Step 4.5: Auto-start local MongoDB service when needed ──
function setupMongoService() {
    if (NO_MONGO) return '';

    const envPath = join(ROOT, '.env');
    const content = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
    const configuredUri = process.env.MONGO_URI || getEnvValue(content, 'MONGO_URI') || 'mongodb://127.0.0.1:27017/discord-music-bot';
    const shouldManage = WITH_MONGO || isLocalMongoUri(configuredUri);

    if (!shouldManage) {
        log('MONGO_URI points to remote database — skipping local MongoDB auto-start');
        return '';
    }

    header('Configuring local MongoDB service');

    if (isPortListening(27017)) {
        ok('MongoDB already listening on port 27017');
        return 'mongodb://127.0.0.1:27017/discord-music-bot';
    }

    if (!cmdExists('docker')) {
        warn('Docker not found — cannot auto-start MongoDB container.');
        warn('Install Docker or run MongoDB service manually on port 27017.');
        return 'mongodb://127.0.0.1:27017/discord-music-bot';
    }

    const containerName = 'discord-music-bot-mongo';
    const mongoDb = 'discord-music-bot';

    try {
        const existing = runCmd(`docker ps -a --format "{{.Names}}"`, { silent: true, cwd: ROOT }) || '';

        if (!existing.split('\n').includes(containerName)) {
            log('Creating MongoDB container...');
            runCmd(
                `docker run -d --name ${containerName} -p 27017:27017 ` +
                `-e MONGO_INITDB_DATABASE=${mongoDb} mongo:7`,
                { cwd: ROOT, timeout: 120000 }
            );
            ok('MongoDB container created');
        } else {
            log('Starting existing MongoDB container...');
            runCmd(`docker start ${containerName}`, { cwd: ROOT, ignoreError: true });
            ok('MongoDB container started');
        }

        return 'mongodb://127.0.0.1:27017/discord-music-bot';
    } catch (e) {
        warn(`MongoDB auto-start failed: ${e.message}`);
        warn('Continuing startup with configured MONGO_URI');
        return '';
    }
}

// ─── Step 5: Generate .env ─────────────────────────────────────
async function ensureEnvFile(autoMongoUri = '') {
    header('Configuring .env');

    const envPath = join(ROOT, '.env');
    const hasEnv = existsSync(envPath);
    const existingContent = hasEnv ? readFileSync(envPath, 'utf-8') : '';

    if (!hasEnv && existsSync(join(ROOT, '.env.example'))) {
        copyFileSync(join(ROOT, '.env.example'), envPath);
        log('Created .env from .env.example');
    }

    const existingToken = getEnvValue(existingContent, 'BOT_TOKEN');
    const existingClientId = getEnvValue(existingContent, 'CLIENT_ID');

    let token = process.env.BOT_TOKEN || existingToken;
    let clientId = process.env.CLIENT_ID || existingClientId;

    if (!token || token === 'your_bot_token_here' || !clientId || clientId === 'your_client_id_here') {
        if (AUTO_MODE) {
            err('AUTO mode requires BOT_TOKEN and CLIENT_ID (either in current .env or shell env vars).');
            err('Example: BOT_TOKEN=... CLIENT_ID=... npm run bootstrap');
            process.exit(1);
        }

        console.log('');
        log(`${C.bold}Let's set up your bot!${C.reset}`);
        log(`Get your bot token & client ID from: ${C.cyan}https://discord.com/developers/applications${C.reset}`);
        console.log('');

        token = await askQuestion('Bot Token (from Developer Portal)', token || '');
        clientId = await askQuestion('Client/Application ID', clientId || '');
    }

    if (!token || !clientId) {
        err('BOT_TOKEN and CLIENT_ID are required!');
        process.exit(1);
    }

    let mongoUri = process.env.MONGO_URI || autoMongoUri || getEnvValue(existingContent, 'MONGO_URI') || 'mongodb://127.0.0.1:27017/discord-music-bot';
    let aiKey = process.env.AI_API_KEY || getEnvValue(existingContent, 'AI_API_KEY') || '';
    let spotifyId = process.env.SPOTIFY_CLIENT_ID || getEnvValue(existingContent, 'SPOTIFY_CLIENT_ID') || '';
    let spotifySecret = process.env.SPOTIFY_CLIENT_SECRET || getEnvValue(existingContent, 'SPOTIFY_CLIENT_SECRET') || '';
    let ytOauthToken = process.env.YOUTUBE_OAUTH_REFRESH_TOKEN || getEnvValue(existingContent, 'YOUTUBE_OAUTH_REFRESH_TOKEN') || '';
    let ytPoToken = process.env.YOUTUBE_PO_TOKEN || getEnvValue(existingContent, 'YOUTUBE_PO_TOKEN') || '';
    let ytVisitorData = process.env.YOUTUBE_VISITOR_DATA || getEnvValue(existingContent, 'YOUTUBE_VISITOR_DATA') || '';

    const shouldPromptOptional = !AUTO_MODE && (RECONFIGURE || !hasEnv);
    if (shouldPromptOptional) {
        console.log('');
        log(`${C.dim}Optional config (press Enter to keep defaults):${C.reset}`);
        mongoUri = await askQuestion('MongoDB URI', mongoUri);
        aiKey = await askQuestion('OpenAI API Key (for smart autoplay)', aiKey);
        spotifyId = await askQuestion('Spotify Client ID', spotifyId);
        spotifySecret = spotifyId ? await askQuestion('Spotify Client Secret', spotifySecret) : '';
    }

    const primaryHost = process.env.LAVALINK_HOST || getEnvValue(existingContent, 'LAVALINK_HOST') || '127.0.0.1';
    const primaryPort = process.env.LAVALINK_PORT || getEnvValue(existingContent, 'LAVALINK_PORT') || '2333';
    const primarySecure = process.env.LAVALINK_SECURE || getEnvValue(existingContent, 'LAVALINK_SECURE') || 'false';
    const generatedPassword = randomSecret(12);
    const primaryPassword = process.env.LAVALINK_PASSWORD || getEnvValue(existingContent, 'LAVALINK_PASSWORD') || generatedPassword;

    const localFallbackPort = process.env.LAVALINK_LOCAL_PORT || getEnvValue(existingContent, 'LAVALINK_LOCAL_PORT') || '2333';
    const localFallbackPassword = process.env.LAVALINK_LOCAL_PASSWORD || getEnvValue(existingContent, 'LAVALINK_LOCAL_PASSWORD') || primaryPassword;
    const localFallbackEnabled = process.env.LAVALINK_ENABLE_LOCAL_FALLBACK || getEnvValue(existingContent, 'LAVALINK_ENABLE_LOCAL_FALLBACK') || 'true';
    const localFallbackManaged = process.env.LAVALINK_MANAGE_LOCAL || getEnvValue(existingContent, 'LAVALINK_MANAGE_LOCAL') || 'true';
    const lavalinkJavaOpts = process.env.LAVALINK_JAVA_OPTS || getEnvValue(existingContent, 'LAVALINK_JAVA_OPTS') || '-Xms512M -Xmx1024M -XX:+UseG1GC -Dsun.zip.disableMemoryMapping=true';
    const explicitNodes = process.env.LAVALINK_NODES || getEnvValue(existingContent, 'LAVALINK_NODES') || '';

    const envContent = `# ─── Discord Bot (REQUIRED) ──────────────────────────────────
BOT_TOKEN=${token}
CLIENT_ID=${clientId}

# ─── Database ────────────────────────────────────────────────
MONGO_URI=${mongoUri}

# ─── Lavalink Primary Node (external or local) ───────────────
LAVALINK_HOST=${primaryHost}
LAVALINK_PORT=${primaryPort}
LAVALINK_PASSWORD=${primaryPassword}
LAVALINK_SECURE=${primarySecure}

# Optional JSON array for multi-node tier fallback
LAVALINK_NODES=${explicitNodes}

# Auto-managed local fallback Lavalink
LAVALINK_ENABLE_LOCAL_FALLBACK=${localFallbackEnabled}
LAVALINK_LOCAL_HOST=127.0.0.1
LAVALINK_LOCAL_PORT=${localFallbackPort}
LAVALINK_LOCAL_PASSWORD=${localFallbackPassword}
LAVALINK_LOCAL_SECURE=false
LAVALINK_MANAGE_LOCAL=${localFallbackManaged}
LAVALINK_JAVA_OPTS=${lavalinkJavaOpts}

# ─── Spotify ────────────────────────────────────────────────
SPOTIFY_CLIENT_ID=${spotifyId}
SPOTIFY_CLIENT_SECRET=${spotifySecret}

# ─── Apple Music ────────────────────────────────────────────
APPLE_MUSIC_TOKEN=

# ─── Deezer ─────────────────────────────────────────────────
DEEZER_DECRYPTION_KEY=

# ─── YouTube Authentication (VPS) ───────────────────────────
# OAuth is enabled by default. On first Lavalink start, check the
# logs for a device-code URL to authenticate. Once done, paste
# the refresh token below so it persists across restarts:
YOUTUBE_OAUTH_REFRESH_TOKEN=${ytOauthToken}
# Alternative: PoToken + VisitorData (if OAuth doesn't work)
YOUTUBE_PO_TOKEN=${ytPoToken}
YOUTUBE_VISITOR_DATA=${ytVisitorData}

# ─── AI / OpenAI ────────────────────────────────────────────
AI_API_KEY=${aiKey}
AI_MODEL=gpt-4o-mini

# ─── Channel (auto-set by /setup command) ───────────────────
REQUEST_CHANNEL_ID=

# ─── Settings ───────────────────────────────────────────────
DEFAULT_VOLUME=80
MAX_QUEUE_SIZE=500
AUTO_DELETE_DELAY=1500
EMBED_UPDATE_INTERVAL=5000
`;

    writeFileSync(envPath, envContent, 'utf-8');
    ok('.env file created/updated');
    if (AUTO_MODE) {
        ok('AUTO mode: secrets and fallback settings were generated automatically');
    }
}

// ─── Step 6: Start the bot ─────────────────────────────────────
function startBot(prestartedLavalink = false) {
    header('Starting Bot');
    log('Launching src/bot.js ...');
    console.log('');

    const child = spawn('node', ['src/bot.js'], {
        cwd: ROOT,
        stdio: 'inherit',
        env: {
            ...process.env,
            FORCE_COLOR: '1',
            PRESTARTED_LAVALINK: prestartedLavalink ? 'true' : 'false',
        },
    });

    child.on('exit', (code) => {
        if (code !== 0) {
            err(`Bot exited with code ${code}`);
            process.exit(code);
        }
    });

    // Forward signals
    process.on('SIGINT', () => { child.kill('SIGINT'); });
    process.on('SIGTERM', () => { child.kill('SIGTERM'); });
}

// ─── Main ──────────────────────────────────────────────────────
async function main() {
    console.log('');
    console.log(`${C.bold}${C.blue}╔══════════════════════════════════════════════╗${C.reset}`);
    console.log(`${C.bold}${C.blue}║   🎵 Discord Music Bot — Auto Setup         ║${C.reset}`);
    console.log(`${C.bold}${C.blue}║   One command. Zero hassle.                  ║${C.reset}`);
    console.log(`${C.bold}${C.blue}╚══════════════════════════════════════════════╝${C.reset}`);

    // 1. Node version
    checkNodeVersion();

    // 2. npm install
    installNpmDeps();

    // 3. Local Mongo service
    const autoMongoUri = setupMongoService();

    // 4. .env
    await ensureEnvFile(autoMongoUri);

    // 5. Java (for Lavalink)
    await installJava();

    // 6. yt-dlp (fallback audio)
    installYtDlp();

    // 7. Strict Lavalink-first startup
    const lavalinkStatus = await ensureLavalinkBeforeBot();
    if (!lavalinkStatus.ok) {
        warn('Lavalink failed to pre-start — bot will rely on yt-dlp fallback or external nodes');
    }

    // 8. Pre-flight: sync slash commands before bot starts
    const commandsSynced = await syncSlashCommands();

    // 9. Summary
    header('Setup Complete');
    console.log('');
    ok('npm dependencies installed');
    ok('.env configured');
    ok(`Java: ${cmdExists('java') ? 'installed' : 'not found (Lavalink skipped, yt-dlp fallback)'}`);
    ok(`yt-dlp: ${cmdExists('yt-dlp') || existsSync(join(ROOT, 'yt-dlp.exe')) ? 'installed' : 'not found'}`);
    ok(`MongoDB: ${NO_MONGO ? 'auto-start disabled by flag' : 'auto-start checked'}`);
    ok(`Lavalink: ${lavalinkStatus.ok ? (lavalinkStatus.prestarted ? 'running' : 'external') : 'failed (yt-dlp fallback)'}`);
    ok(`Commands: ${commandsSynced ? 'synced' : 'will sync on bot start'}`);

    // YouTube auth guidance for VPS
    const hasYtAuth = process.env.YOUTUBE_OAUTH_REFRESH_TOKEN || process.env.YOUTUBE_PO_TOKEN;
    if (!hasYtAuth) {
        console.log('');
        warn(`${C.bold}YouTube VPS Setup Required:${C.reset}`);
        log('  OAuth is enabled. On first start, Lavalink will print a');
        log('  device-code URL in the logs. Visit it to authenticate with');
        log('  a Google account. Then save the refresh token to .env as');
        log(`  ${C.cyan}YOUTUBE_OAUTH_REFRESH_TOKEN=<token>${C.reset}`);
    }
    console.log('');

    // 10. Launch bot
    if (NO_START) {
        warn('Skipping bot launch because --no-start was provided');
        return;
    }
    startBot(lavalinkStatus.prestarted);
}

main().catch((e) => {
    err(`Setup failed: ${e.message}`);
    console.error(e.stack);
    process.exit(1);
});
