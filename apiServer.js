require('dotenv').config();
const express = require('express');
const cors = require('cors');
const os = require('os');
const { config, saveConfigPatch, OVERRIDE_PATH } = require('./utils/config');
const { authenticate, issueSession, requireAuth, getSession, updatePassword } = require('./utils/auth');
const path = require('path');
const { listProviders, getProvider, getCookieStats } = require('./providers/registry');
const { createProxyRoutes, processStreamsForProxy } = require('./proxy/proxyServer');
const { resolveImdbId } = require('./utils/tmdb');
const { applyFilters } = require('./utils/streamFilters');

const app = express();

// Conditionally mount proxy routes early
if (config.enableProxy) {
  console.log('[startup] enableProxy flag active: mounting proxy routes');
  createProxyRoutes(app);
} else {
  console.log('[startup] enableProxy flag disabled: proxy routes not mounted');
}

// --- Simple In-Memory Rate Limiting for /auth/login ---
const loginAttempts = new Map();
const MAX_ATTEMPTS_WINDOW = 5;
const WINDOW_MS = 10 * 60 * 1000;
const BASE_LOCK_MS = 5 * 60 * 1000;

function getClientIp(req){
  return (req.headers['x-forwarded-for'] || req.connection.remoteAddress || '').split(',')[0].trim();
}

function recordLoginFailure(ip){
  const now = Date.now();
  let entry = loginAttempts.get(ip);
  if (!entry) {
    entry = { count:1, first: now, last: now, lockedUntil:0 };
    loginAttempts.set(ip, entry);
    return entry;
  }
  if (now - entry.first > WINDOW_MS && now > entry.lockedUntil) {
    entry.count = 1;
    entry.first = now;
  } else {
    entry.count++;
  }
  entry.last = now;
  if (entry.count > MAX_ATTEMPTS_WINDOW) {
    const over = entry.count - MAX_ATTEMPTS_WINDOW;
    const lockMs = BASE_LOCK_MS * Math.min(8, Math.pow(2, over-1));
    entry.lockedUntil = now + lockMs;
  }
  return entry;
}

function canAttempt(ip){
  const entry = loginAttempts.get(ip);
  if (!entry) return { allowed:true };
  const now = Date.now();
  if (entry.lockedUntil && now < entry.lockedUntil) {
    return { allowed:false, retryAfter: Math.ceil((entry.lockedUntil - now)/1000) };
  }
  if (now - entry.first > WINDOW_MS) {
    loginAttempts.delete(ip);
    return { allowed:true };
  }
  return { allowed:true };
}

function recordLoginSuccess(ip){
  loginAttempts.delete(ip);
}

const realProcessExit = process.exit.bind(process);
let allowControlledExit = false;
process.exit = function(code){
  if (allowControlledExit) return realProcessExit(code);
  console.warn('[diagnostic] Intercepted process.exit with code', code, new Error('exit trace').stack);
};
setImmediate(()=>console.log('[diagnostic] post-start setImmediate fired'));

app.use(cors());
app.use(express.json());

// Auth routes ...
app.post('/auth/login', (req,res) => {
  const { username, password } = req.body || {};
  const ip = getClientIp(req);
  const attemptState = canAttempt(ip);
  if (!attemptState.allowed) {
    res.setHeader('Retry-After', String(attemptState.retryAfter));
    return res.status(429).json({ success:false, error:'TOO_MANY_ATTEMPTS', retryAfter: attemptState.retryAfter });
  }
  if (!username || !password) return res.status(400).json({ success:false, error:'MISSING_CREDENTIALS' });
  if (!authenticate(username, password)) {
    const entry = recordLoginFailure(ip);
    if (entry.lockedUntil && Date.now() < entry.lockedUntil) {
      const retryAfter = Math.ceil((entry.lockedUntil - Date.now())/1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ success:false, error:'LOCKED', retryAfter });
    }
    return res.status(401).json({ success:false, error:'INVALID_CREDENTIALS', remaining: Math.max(0, MAX_ATTEMPTS_WINDOW - entry.count) });
  }
  recordLoginSuccess(ip);
  const token = issueSession(username);
  res.setHeader('Set-Cookie', `session=\( {token}; HttpOnly; SameSite=Lax; Path=/; Max-Age= \){12*60*60}`);
  res.json({ success:true, username });
});

// ... (logout, session, change-password, config.html, root, diagnostics, metrics, etc. remain unchanged)

// Helper to pick best stream
function pickBestStream(streams, preferredProvider = null) {
  if (!streams || streams.length === 0) return null;

  let candidates = streams;

  if (preferredProvider) {
    candidates = streams.filter(s => s.provider === preferredProvider);
    if (candidates.length === 0) return null; // no match → we'll fall back later
  }

  // Sort by quality heuristic
  candidates.sort((a, b) => {
    const scoreA = getQualityScore(a.quality);
    const scoreB = getQualityScore(b.quality);
    if (scoreB !== scoreA) return scoreB - scoreA;
    // Tie-breaker: prefer provider that appears first in config (or alphabetical)
    return 0;
  });

  return candidates[0] || null;
}

function getQualityScore(q) {
  if (!q || typeof q !== 'string') return 0;
  const upper = q.toUpperCase();
  if (upper.includes('4K') || upper.includes('2160')) return 100;
  if (upper.includes('1440') || upper.includes('2K')) return 90;
  if (upper.includes('1080')) return 80;
  if (upper.includes('720')) return 60;
  if (upper.includes('480') || upper.includes('SD')) return 40;
  return 20;
}

// Aggregate streams across all enabled providers
app.get('/api/streams/:type/:tmdbId', async (req, res) => {
  const { type, tmdbId } = req.params;
  if (!['movie','series'].includes(type)) return res.status(400).json({ success:false, error:'INVALID_TYPE' });

  const season   = req.query.season   ? Number(req.query.season)   : null;
  const episode  = req.query.episode  ? Number(req.query.episode)  : null;
  const direct   = req.query.direct   !== undefined;
  const redirect = req.query.direct === 'redirect';
  const preferredProvider = req.query.provider || null;

  try {
    metrics.streamRequests++;
    const tmdbType = type === 'movie' ? 'movie' : 'tv';
    const imdbId = await resolveImdbId(tmdbType, tmdbId); 
    if (imdbId) metrics.tmdbToImdbLookups++;

    const selectedProviders = (config.defaultProviders.length ? config.defaultProviders : listProviders().map(p=>p.name));
    const providerTimings = {};
    const results = await Promise.all(selectedProviders.map(async name => {
      const prov = getProvider(name);
      if (!prov || !prov.enabled) return [];
      metrics.providerCalls[name] = (metrics.providerCalls[name]||0)+1;
      try {
        console.log(`[api] invoking provider \( {name} for tmdbId= \){tmdbId}`);
        const t0 = Date.now();
        const r = await prov.fetch({ tmdbId, type, season, episode, imdbId, filters:{} });
        providerTimings[name] = Date.now()-t0;
        console.log(`[api] provider ${name} returned ${Array.isArray(r)?r.length:0} streams`);
        return r;
      } catch (e) {
        console.error(`[api] provider ${name} failed:`, e.message);
        providerTimings[name] = null;
        return [];
      }
    }));

    let streams = results.flat();
    streams = applyFilters(streams, 'aggregate', config.minQualities, config.excludeCodecs);
    metrics.streamsReturned += streams.length;

    if (config.enableProxy) {
      const serverUrl = `\( {req.protocol}:// \){req.get('host')}`;
      streams = processStreamsForProxy(streams, serverUrl);
      streams = streams.map(s => { 
        if (s && typeof s === 'object') { 
          const { headers, ...rest } = s; 
          return rest; 
        } 
        return s; 
      });
    }

    // ──────────────────────────────────────────────
    // DIRECT MODE
    if (direct) {
      const best = pickBestStream(streams, preferredProvider);

      if (!best || !best.url) {
        return res.status(404).type('text/plain').send('No suitable stream found');
      }

      const url = best.url;

      if (redirect) {
        console.log(`[direct] redirecting to ${best.provider} - ${best.quality} → ${url}`);
        return res.redirect(302, url);
      }

      // Plain text response (VLC friendly)
      const comment = `# ${best.provider} • ${best.quality || 'unknown'} • ${tmdbId}\n`;
      res.type('text/plain').send(comment + url);
      return;
    }

    // Normal JSON response
    res.json({ success:true, tmdbId, imdbId, count: streams.length, providerTimings, streams });

  } catch (e) {
    metrics.lastError = e.message;
    res.status(500).json({ success:false, error:'INTERNAL_ERROR', message:e.message });
  }
});

// Provider-specific streams
app.get('/api/streams/:provider/:type/:tmdbId', async (req, res) => {
  const { provider, type, tmdbId } = req.params;
  if (!['movie','series'].includes(type)) return res.status(400).json({ success:false, error:'INVALID_TYPE' });

  const season   = req.query.season   ? Number(req.query.season)   : null;
  const episode  = req.query.episode  ? Number(req.query.episode)  : null;
  const direct   = req.query.direct   !== undefined;
  const redirect = req.query.direct === 'redirect';

  const prov = getProvider(provider);
  if (!prov) return res.status(404).json({ success:false, error:'PROVIDER_NOT_FOUND' });
  if (!prov.enabled) return res.status(503).json({ success:false, error:'PROVIDER_DISABLED' });

  try {
    metrics.streamRequests++;
    metrics.providerCalls[prov.name] = (metrics.providerCalls[prov.name]||0)+1;

    const tmdbType = type === 'movie' ? 'movie' : 'tv';
    const imdbId = await resolveImdbId(tmdbType, tmdbId); 
    if (imdbId) metrics.tmdbToImdbLookups++;

    const t0 = Date.now();
    let streams = await prov.fetch({ tmdbId, type, season, episode, imdbId, filters:{} });
    const providerTimings = { [prov.name]: Date.now()-t0 };

    streams = applyFilters(streams, prov.name, config.minQualities, config.excludeCodecs);
    metrics.streamsReturned += streams.length;

    if (config.enableProxy) {
      const serverUrl = `\( {req.protocol}:// \){req.get('host')}`;
      streams = processStreamsForProxy(streams, serverUrl);
      streams = streams.map(s => { 
        if (s && typeof s === 'object') { 
          const { headers, ...rest } = s; 
          return rest; 
        } 
        return s; 
      });
    }

    // ──────────────────────────────────────────────
    // DIRECT MODE (provider-specific route)
    if (direct) {
      const best = pickBestStream(streams, provider); // provider is already filtered

      if (!best || !best.url) {
        return res.status(404).type('text/plain').send(`No stream from ${provider}`);
      }

      const url = best.url;

      if (redirect) {
        console.log(`[direct] ${provider} redirect → ${url}`);
        return res.redirect(302, url);
      }

      const comment = `# ${provider} • ${best.quality || 'unknown'} • ${tmdbId}\n`;
      res.type('text/plain').send(comment + url);
      return;
    }

    // Normal JSON
    res.json({ success:true, provider: prov.name, tmdbId, imdbId, count: streams.length, providerTimings, streams });

  } catch (e) {
    metrics.lastError = e.message;
    res.status(500).json({ success:false, error:'INTERNAL_ERROR', message:e.message });
  }
});

// ... (rest of the file: PORT listen, server.on('error'), etc. unchanged)

const PORT = config.port;
const HOST = process.env.BIND_HOST || '0.0.0.0';
const server = app.listen(PORT, HOST, () => {
  console.log(`TMDB Embed REST API listening on http://\( {HOST}: \){PORT}`);
  if (HOST !== 'localhost') {
    console.log(`Local access (if running on your machine): http://localhost:${PORT}`);
  }
  console.log('Endpoints:');
  console.log('  GET  /api/health');
  console.log('  GET  /api/metrics');
  console.log('  GET  /api/providers');
  console.log('  GET  /api/streams/:type/:id');
  console.log('  GET  /api/streams/:provider/:type/:id   ← now supports ?direct too');
  console.log('  POST /api/config');
  console.log('  GET /api/config');
});

server.on('error', (err)=>{ console.error('[diagnostic] server error', err); });
