const DEFAULT_SUPABASE_URL = 'https://pvutxjfkskzgccawfibu.supabase.co';
const DEFAULT_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_rjpS5yL05g40E2gI_uSMEw_1IDk1azY';

const PUBLISHABLE_KEY_PATTERN = /^sb_publishable_[A-Za-z0-9_-]+$/;
const SECRET_KEY_PATTERN = /^sb_secret_[A-Za-z0-9_-]+$/;
const LEGACY_JWT_PATTERN = /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function normalizeKey(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isSupabasePublishableKey(value) {
  return PUBLISHABLE_KEY_PATTERN.test(normalizeKey(value));
}

function isLegacyJwtLike(value) {
  return LEGACY_JWT_PATTERN.test(normalizeKey(value));
}

function isSupabaseSecretKey(value) {
  return SECRET_KEY_PATTERN.test(normalizeKey(value));
}

function resolveSupabasePublishableKey({
  runtimeKey,
  compatibilityKey,
  savedKey
} = {}) {
  const candidates = [runtimeKey, compatibilityKey, savedKey];
  const modernKey = candidates.map(normalizeKey).find(isSupabasePublishableKey);
  return modernKey || DEFAULT_SUPABASE_PUBLISHABLE_KEY;
}

module.exports = {
  DEFAULT_SUPABASE_URL,
  DEFAULT_SUPABASE_PUBLISHABLE_KEY,
  isLegacyJwtLike,
  isSupabasePublishableKey,
  isSupabaseSecretKey,
  resolveSupabasePublishableKey
};
