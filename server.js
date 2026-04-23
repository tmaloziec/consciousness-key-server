#!/usr/bin/env node
/**
 * Consciousness Key Server
 *
 * Zero-dependency HTTP service for retrieving SSH private keys,
 * API tokens, and other secrets from a locked-down on-disk vault.
 *
 * Authenticates callers by IP allow-list plus optional X-API-Key header.
 * Every request (success or failure) is written to an append-only audit log.
 *
 * Designed to be used as an auth / secrets sidecar for Consciousness Server,
 * Cortex, or any multi-agent system that needs a small trusted vault
 * without pulling in HashiCorp Vault or a cloud KMS.
 *
 * License: AGPL-3.0-or-later
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.KEY_SERVER_PORT || 3040;
const HOST = process.env.KEY_SERVER_HOST || '0.0.0.0';
const BASE_DIR = __dirname;
const KEYS_DIR = path.join(BASE_DIR, 'keys');
const AUTH_CONFIG = path.join(BASE_DIR, 'auth', 'allowed-clients.json');
const AUDIT_LOG = path.join(BASE_DIR, 'logs', 'audit.log');

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}] ${message}`);
}

function auditLog(ip, endpoint, result, details = '') {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] IP=${ip} ENDPOINT=${endpoint} RESULT=${result} ${details}\n`;

  fs.appendFile(AUDIT_LOG, logEntry, (err) => {
    if (err) console.error('Failed to write audit log:', err);
  });

  log(`AUDIT: ${ip} → ${endpoint} → ${result}`, 'AUDIT');
}

function loadAuthConfig() {
  try {
    const data = fs.readFileSync(AUTH_CONFIG, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    log(`Failed to load auth config: ${err.message}`, 'ERROR');
    return { allowed_ips: ['127.0.0.1', '::1'], api_keys: {} };
  }
}

function isIpAllowed(clientIp, allowedRanges) {
  // Simple IP check - allow localhost and private network
  if (clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '::ffff:127.0.0.1') {
    return true;
  }

  // Check if IP starts with allowed ranges (simple prefix match)
  for (const range of allowedRanges) {
    if (range.includes('/')) {
      // CIDR-ish notation (first three octets matched, e.g. "10.0.0.0/24")
      const prefix = range.split('/')[0].split('.').slice(0, 3).join('.');
      const clientPrefix = clientIp.split('.').slice(0, 3).join('.');
      if (prefix === clientPrefix) return true;
    } else if (clientIp === range) {
      return true;
    }
  }

  return false;
}

function authenticate(req) {
  const authConfig = loadAuthConfig();
  const clientIp = req.socket.remoteAddress;

  // Check IP whitelist
  if (!isIpAllowed(clientIp, authConfig.allowed_ips)) {
    return { allowed: false, reason: 'IP not whitelisted' };
  }

  // For sensitive operations, also check API key (optional for now)
  const apiKey = req.headers['x-api-key'];
  if (apiKey && authConfig.api_keys) {
    const validKey = Object.values(authConfig.api_keys).includes(apiKey);
    if (!validKey) {
      return { allowed: false, reason: 'Invalid API key' };
    }
  }

  return { allowed: true, ip: clientIp };
}

function sendResponse(res, statusCode, body, contentType = 'application/json') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key'
  });

  if (contentType === 'application/json') {
    res.end(JSON.stringify(body, null, 2));
  } else {
    res.end(body);
  }
}

// ============================================================================
// API ENDPOINTS
// ============================================================================

function handleHealth(req, res, auth) {
  auditLog(auth.ip, '/health', 'OK');
  sendResponse(res, 200, {
    status: 'ok',
    service: 'key-server',
    version: '1.0.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
}

function handleGetSshKey(req, res, auth, keyName) {
  const keyPath = path.join(KEYS_DIR, 'ssh', keyName);

  // Security: prevent path traversal
  if (keyName.includes('..') || keyName.includes('/')) {
    auditLog(auth.ip, `/keys/ssh/${keyName}`, 'REJECTED', 'path_traversal_attempt');
    sendResponse(res, 400, { error: 'Invalid key name' });
    return;
  }

  // Check if key exists
  if (!fs.existsSync(keyPath)) {
    auditLog(auth.ip, `/keys/ssh/${keyName}`, 'NOT_FOUND');
    sendResponse(res, 404, { error: 'Key not found' });
    return;
  }

  // Read and return key
  try {
    const keyContent = fs.readFileSync(keyPath, 'utf8');
    auditLog(auth.ip, `/keys/ssh/${keyName}`, 'SUCCESS', `size=${keyContent.length}`);
    sendResponse(res, 200, keyContent, 'text/plain');
  } catch (err) {
    auditLog(auth.ip, `/keys/ssh/${keyName}`, 'ERROR', err.message);
    sendResponse(res, 500, { error: 'Failed to read key' });
  }
}

function handleGetApiKey(req, res, auth, service) {
  const keyPath = path.join(KEYS_DIR, service, 'api-key.txt');

  // Security: prevent path traversal
  if (service.includes('..') || service.includes('/')) {
    auditLog(auth.ip, `/keys/api/${service}`, 'REJECTED', 'path_traversal_attempt');
    sendResponse(res, 400, { error: 'Invalid service name' });
    return;
  }

  // Check if key exists
  if (!fs.existsSync(keyPath)) {
    auditLog(auth.ip, `/keys/api/${service}`, 'NOT_FOUND');
    sendResponse(res, 404, { error: 'API key not found' });
    return;
  }

  // Read and return key
  try {
    const keyContent = fs.readFileSync(keyPath, 'utf8').trim();
    auditLog(auth.ip, `/keys/api/${service}`, 'SUCCESS');
    sendResponse(res, 200, { service, api_key: keyContent });
  } catch (err) {
    auditLog(auth.ip, `/keys/api/${service}`, 'ERROR', err.message);
    sendResponse(res, 500, { error: 'Failed to read API key' });
  }
}

function handleListKeys(req, res, auth) {
  try {
    const sshKeys = fs.readdirSync(path.join(KEYS_DIR, 'ssh'))
      .filter(f => !f.endsWith('.pub'));

    const apiServices = fs.readdirSync(KEYS_DIR)
      .filter(f => f !== 'ssh' && fs.statSync(path.join(KEYS_DIR, f)).isDirectory());

    auditLog(auth.ip, '/keys/list', 'SUCCESS');
    sendResponse(res, 200, {
      ssh_keys: sshKeys,
      api_services: apiServices
    });
  } catch (err) {
    auditLog(auth.ip, '/keys/list', 'ERROR', err.message);
    sendResponse(res, 500, { error: 'Failed to list keys' });
  }
}

function handleAudit(req, res, auth) {
  // Read last 100 lines of audit log
  try {
    const logContent = fs.readFileSync(AUDIT_LOG, 'utf8');
    const lines = logContent.split('\n').filter(l => l.trim()).slice(-100);

    auditLog(auth.ip, '/audit', 'SUCCESS');
    sendResponse(res, 200, {
      total_entries: lines.length,
      recent_entries: lines
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      sendResponse(res, 200, { total_entries: 0, recent_entries: [] });
    } else {
      auditLog(auth.ip, '/audit', 'ERROR', err.message);
      sendResponse(res, 500, { error: 'Failed to read audit log' });
    }
  }
}

// ============================================================================
// REQUEST ROUTER
// ============================================================================

function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  log(`${req.method} ${pathname} from ${req.socket.remoteAddress}`);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    sendResponse(res, 200, {});
    return;
  }

  // Authenticate
  const auth = authenticate(req);
  if (!auth.allowed) {
    auditLog(req.socket.remoteAddress, pathname, 'FORBIDDEN', auth.reason);
    sendResponse(res, 403, { error: 'Forbidden', reason: auth.reason });
    return;
  }

  // Route requests
  if (pathname === '/health') {
    handleHealth(req, res, auth);
  } else if (pathname === '/keys/list') {
    handleListKeys(req, res, auth);
  } else if (pathname === '/audit') {
    handleAudit(req, res, auth);
  } else if (pathname.startsWith('/keys/ssh/')) {
    const keyName = pathname.split('/keys/ssh/')[1];
    handleGetSshKey(req, res, auth, keyName);
  } else if (pathname.startsWith('/keys/api/')) {
    const service = pathname.split('/keys/api/')[1];
    handleGetApiKey(req, res, auth, service);
  } else {
    auditLog(auth.ip, pathname, 'NOT_FOUND');
    sendResponse(res, 404, { error: 'Endpoint not found' });
  }
}

// ============================================================================
// SERVER STARTUP
// ============================================================================

const server = http.createServer(handleRequest);

server.listen(PORT, HOST, () => {
  log(`🔐 Key Server started on ${HOST}:${PORT}`);
  log(`📁 Keys directory: ${KEYS_DIR}`);
  log(`🔒 Auth config: ${AUTH_CONFIG}`);
  log(`📝 Audit log: ${AUDIT_LOG}`);
  log('');
  log('Available endpoints:');
  log('  GET  /health              - Server health check');
  log('  GET  /keys/list           - List available keys');
  log('  GET  /keys/ssh/:name      - Get SSH private key');
  log('  GET  /keys/api/:service   - Get API key for service');
  log('  GET  /audit               - View audit log (last 100 entries)');
  log('');
  log('🚀 Ready to serve keys!');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log(`Port ${PORT} is already in use`, 'ERROR');
  } else {
    log(`Server error: ${err.message}`, 'ERROR');
  }
  process.exit(1);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  log('SIGTERM received, shutting down gracefully...', 'INFO');
  server.close(() => {
    log('Server closed', 'INFO');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  log('SIGINT received, shutting down...', 'INFO');
  server.close(() => {
    log('Server closed', 'INFO');
    process.exit(0);
  });
});
