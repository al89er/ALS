const fs = require('fs');
const path = require('path');
const {
    DEFAULT_SUPABASE_URL,
    DEFAULT_SUPABASE_PUBLISHABLE_KEY,
    isLegacyJwtLike,
    isSupabaseSecretKey
} = require('./supabase-config');

const SUPABASE_CONFIG_NAMES = new Set([
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'SUPABASE_PUBLISHABLE_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_SECRET_KEY',
    'SUPABASE_SECRET_KEYS'
]);

function unquote(value) {
    const trimmed = value.trim();
    if (trimmed.length >= 2 && (
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))
    )) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

function createBundledEnv(source = '') {
    const retained = [];

    for (const line of source.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!match) {
            if (line.trim()) retained.push(line);
            continue;
        }

        const name = match[1];
        const value = unquote(match[2]);
        if (SUPABASE_CONFIG_NAMES.has(name)) continue;
        if (isLegacyJwtLike(value) || isSupabaseSecretKey(value)) continue;
        retained.push(line);
    }

    retained.push(`SUPABASE_URL=${DEFAULT_SUPABASE_URL}`);
    retained.push(`SUPABASE_PUBLISHABLE_KEY=${DEFAULT_SUPABASE_PUBLISHABLE_KEY}`);
    return `${retained.join('\n')}\n`;
}

function runPrebuild(edition = process.argv[2]) {
    const bundledEnvPath = path.join(__dirname, 'bundled.env');
    if (fs.existsSync(bundledEnvPath)) {
        fs.unlinkSync(bundledEnvPath);
    }

    if (edition === 'full' || edition === 'hub') {
        const envPath = path.join(__dirname, '.env');
        let source = '';
        if (edition === 'full' && fs.existsSync(envPath)) {
            source = fs.readFileSync(envPath, 'utf8');
        } else if (edition === 'full') {
            console.warn('[PREBUILD] WARNING: .env file not found; bundling public Supabase configuration only.');
        }

        fs.writeFileSync(bundledEnvPath, createBundledEnv(source));
        console.log(`[PREBUILD] Generated sanitized bundled.env for ${edition} edition.`);
    } else {
        console.log(`[PREBUILD] ${edition || 'Unknown'} edition: skipped bundling .env.`);
    }
}

if (require.main === module) {
    runPrebuild();
}

module.exports = {
    createBundledEnv,
    runPrebuild
};
