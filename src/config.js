const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE_DIR = path.join(os.homedir(), '.land-management-cache');
const CONFIG_PATH = path.join(CACHE_DIR, 'app-config.json');

const DEFAULTS = {
  ai: {
    primary: {
      baseUrl: 'http://localhost:20128/v1',
      apiKey: '',
      model: 'claude-sonnet-4-5',
    },
    fallback: {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: '',
      model: 'anthropic/claude-sonnet-4.5',
    },
  },
};

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw) || {};
  } catch (_) {
    return {};
  }
}

function saveConfig(partial) {
  const current = loadConfig();
  const merged = deepMerge(current, partial);
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

function deepMerge(base, extra) {
  const out = { ...base };
  for (const key of Object.keys(extra || {})) {
    const bv = base ? base[key] : undefined;
    const ev = extra[key];
    if (ev && typeof ev === 'object' && !Array.isArray(ev) && bv && typeof bv === 'object' && !Array.isArray(bv)) {
      out[key] = deepMerge(bv, ev);
    } else {
      out[key] = ev;
    }
  }
  return out;
}

function getAiProviderConfig(name) {
  const cfg = loadConfig();
  const saved = (cfg.ai && cfg.ai[name]) || {};
  const defaults = DEFAULTS.ai[name];
  return {
    baseUrl: saved.baseUrl || defaults.baseUrl,
    apiKey: saved.apiKey || '',
    model: saved.model || defaults.model,
  };
}

function getPrimaryAiConfig() {
  const envKey = process.env.PRIMARY_AI_API_KEY || process.env.NINE_ROUTER_API_KEY;
  const config = getAiProviderConfig('primary');
  if (envKey) config.apiKey = envKey;
  return config;
}

function getFallbackAiConfig() {
  const envKey = process.env.OPENROUTER_API_KEY;
  const config = getAiProviderConfig('fallback');
  if (envKey) config.apiKey = envKey;
  return config;
}

function saveAiConfig({ primary, fallback } = {}) {
  const partial = { ai: {} };
  if (primary) {
    partial.ai.primary = {};
    if (primary.baseUrl) partial.ai.primary.baseUrl = primary.baseUrl;
    if (primary.apiKey) partial.ai.primary.apiKey = primary.apiKey;
    if (primary.model) partial.ai.primary.model = primary.model;
  }
  if (fallback) {
    partial.ai.fallback = {};
    if (fallback.baseUrl) partial.ai.fallback.baseUrl = fallback.baseUrl;
    if (fallback.apiKey) partial.ai.fallback.apiKey = fallback.apiKey;
    if (fallback.model) partial.ai.fallback.model = fallback.model;
  }
  return saveConfig(partial);
}

function maskKey(key) {
  if (!key || key.length < 8) return key ? '••••' : '';
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

module.exports = {
  CONFIG_PATH,
  loadConfig,
  saveConfig,
  getPrimaryAiConfig,
  getFallbackAiConfig,
  saveAiConfig,
  maskKey,
};
