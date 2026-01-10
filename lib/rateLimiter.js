// lib/rateLimiter.js
import { showLogs } from './logs.js';

const pingAttempts = new Map();
const PING_WINDOW_MS = 60 * 1000;
const PING_MAX_PER_WINDOW = 30;

showLogs('⏱️ rateLimiter module loaded with settings:', {
  PING_WINDOW_MS,
  PING_MAX_PER_WINDOW
});

export function pingRateLimiterKey(deviceId, ip) {
  const key = `${deviceId || 'no-device'}__${ip || 'no-ip'}`;
  showLogs('🔑 pingRateLimiterKey generated:', key);
  return key;
}

export function pingRateAllowed(deviceId, ip) {
  showLogs('🔍 pingRateAllowed called:', { deviceId, ip });
  try {
    const key = pingRateLimiterKey(deviceId, ip);
    const now = Date.now();
    
    showLogs('⏰ current time:', now);
    showLogs('🗺️ pingAttempts map size:', pingAttempts.size);
    
    const existingAttempts = pingAttempts.get(key) || [];
    showLogs('📊 existing attempts for key:', existingAttempts.length);
    
    const arr = existingAttempts.filter(ts => now - ts < PING_WINDOW_MS);
    showLogs('📈 recent attempts within window:', arr.length);
    
    arr.push(now);
    pingAttempts.set(key, arr);
    
    const allowed = arr.length <= PING_MAX_PER_WINDOW;
    showLogs('✅ pingRateAllowed result:', { 
      attempts: arr.length, 
      maxAllowed: PING_MAX_PER_WINDOW, 
      allowed 
    });
    
    return allowed;
  } catch (e) {
    showLogs('❌ pingRateAllowed error:', e && e.message ? e.message : String(e));
    return true; // fail open
  }
}