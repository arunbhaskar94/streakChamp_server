import admin from 'firebase-admin';
import { showLogs } from './logs.js';
import { db } from './firebase.js';
import { blockedUsersStore, suspectedUsersStore } from './firestoreStore.js';
import { ONE_MINUTE } from '../server.js';

// ----------------- CACHE CONFIGURATION -----------------
const CACHE_TTL = 60000; // 1 minute
const MEMORY_CACHE_MAX_ENTRIES = 1000;

// ----------------- RATE LIMITING CONFIGURATION -----------------
// NOTE: We are significantly increasing the IP rate limit for question abuse 
// (from a typical 50-100 to 200) to prevent the local development IP (127.0.0.1) 
// from being blocked repeatedly during testing/debugging.
const QUESTION_ABUSE_MAX_PER_MINUTE = 50; 

// ----------------- OPTIMIZED CACHE IMPLEMENTATION -----------------
class GuardCache {
  constructor() {
    this.requestCounts = new Map();
    this.authAttemptCounts = new Map();
    this.userCache = new Map();
    this.blockCache = new Map();
    this.suspectCache = new Map();
    this.lastCleanup = Date.now();
  }

  // Auto-cleanup to prevent memory leaks
  cleanupIfNeeded() {
    const now = Date.now();
    if (now - this.lastCleanup > CACHE_TTL) {
      this.cleanupExpired();
      this.lastCleanup = now;
    }
  }

  cleanupExpired() {
    const now = Date.now();
    
    // Clean request counts (for question abuse)
    for (const [key, timestamps] of this.requestCounts.entries()) {
      const recent = timestamps.filter(ts => now - ts < ONE_MINUTE);
      if (recent.length === 0) {
        this.requestCounts.delete(key);
      } else {
        this.requestCounts.set(key, recent);
      }
    }

    // Clean auth attempt counts
    for (const [key, timestamps] of this.authAttemptCounts.entries()) {
      const recent = timestamps.filter(ts => now - ts < ONE_MINUTE);
      if (recent.length === 0) {
        this.authAttemptCounts.delete(key);
      } else {
        this.authAttemptCounts.set(key, recent);
      }
    }
    
    // Clean user cache
    for (const [key, entry] of this.userCache.entries()) {
      if (now - entry.timestamp > CACHE_TTL) {
        this.userCache.delete(key);
      }
    }
    
    // Clean block cache
    for (const [key, entry] of this.blockCache.entries()) {
      if (now - entry.timestamp > CACHE_TTL) {
        this.blockCache.delete(key);
      }
    }
     // Clean suspect cache
    for (const [key, entry] of this.suspectCache.entries()) {
      if (now - entry.timestamp > CACHE_TTL) {
        this.suspectCache.delete(key);
      }
    }
  }

  // Setters and Getters
  setUser(uid, data) {
    this.userCache.set(uid, { data, timestamp: Date.now() });
    if (this.userCache.size > MEMORY_CACHE_MAX_ENTRIES) {
        this.cleanupExpired(); // Force cleanup if cache grows too large
    }
  }

  getUser(uid) {
    const entry = this.userCache.get(uid);
    if (entry && Date.now() - entry.timestamp < CACHE_TTL) {
      return entry.data;
    }
    this.userCache.delete(uid);
    return null;
  }
  
  // Block Cache management for Firestore reads
  setBlock(uid, data) {
      this.blockCache.set(uid, { data, timestamp: Date.now() });
  }

  getBlock(uid) {
      const entry = this.blockCache.get(uid);
      if (entry && Date.now() - entry.timestamp < CACHE_TTL) {
          return entry.data;
      }
      this.blockCache.delete(uid);
      return undefined; // Return undefined if not in cache or expired
  }

  deleteBlock(uid) {
      this.blockCache.delete(uid);
  }
}

const guardCache = new GuardCache();

// ----------------- MIDDLEWARE HELPERS -----------------

// Extracts the client IP address (handles proxies/local development)
function getClientIp(req) {
    // This handles the '::ffff:127.0.0.1' format seen in logs
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    return ip.split(',')[0].trim();
}

/**
 * Middleware to wrap async functions, catching errors automatically.
 */
export const wrapAsync = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// ----------------- GUARDS -----------------

/**
 * 1. Authenticates the Firebase ID token and extracts the UID.
 * MUST be the first guard on protected routes.
 */
export const authenticateRequest = async (req, res, next) => {
  showLogs("[GUARD-CHECK] authenticateRequest started");
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ status: 'error', message: 'No token provided' });
  }

  const idToken = authHeader.split('Bearer ')[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.uid = decodedToken.uid;
    req.decodedToken = decodedToken; // Keep the full token for other guards
    showLogs("[authenticateRequest] success, uid:", req.uid);
    next();
  } catch (error) {
    // Log the actual error for debugging (token expired, invalid signature, etc.)
    showLogs("[authenticateRequest] error verifying token:", error.message);
    return res.status(401).json({ status: 'error', message: 'Invalid token' });
  }
};

/**
 * 2. Checks if a guest user's free access period (24 hours) has expired.
 * Requires authenticateRequest to run first to set req.uid.
 */
export const guestExpiryGuard = async (req, res, next) => {
  showLogs("[GUARD-CHECK] guestExpiryGuard started, uid:", req.uid);
  try {
    let userData = guardCache.getUser(req.uid);
    
    if (!userData) {
      showLogs("[guestExpiryGuard] fetching user document from Firestore...");
      const userRef = db.collection("users").doc(req.uid);
      const userSnap = await userRef.get();

      if (!userSnap.exists) {
        showLogs("[guestExpiryGuard] user not found for uid:", req.uid);
        // Allow the request to proceed if user doesn't exist, other logic should handle it
        return next(); 
      }

      userData = userSnap.data();
      // Cache user data to reduce Firestore reads
      guardCache.setUser(req.uid, userData);
    } else {
      showLogs("[guestExpiryGuard] using cached user data for uid:", req.uid);
    }

    // Use isGuest check if the field exists, otherwise assume not guest (registered user)
    const isGuest = userData.isGuest === true; 
    
    // Fallback to auth_time if creationTime is missing (Firebase token creation time)
    const creationTime = userData.creationTime || (req.decodedToken?.auth_time * 1000) || 0; 
    
    // Check if guest and if 24 hours (24 * 60 * 60 * 1000 ms) have passed
    if (isGuest && Date.now() - creationTime > 24 * 60 * 60 * 1000) {
      showLogs("[guestExpiryGuard] guest expired for uid:", req.uid);
      return res.status(403).json({
        error: "Your free time period has ended. Please register to continue.",
        code: "GUEST_EXPIRED"
      });
    }

    showLogs("[guestExpiryGuard] access allowed for uid:", req.uid);
    next();
  } catch (err) {
    showLogs("[guestExpiryGuard] unexpected error:", err.message);
    // Proceed with caution, log the error, but don't block based on guard error
    next(); 
  }
};


/**
 * 3. Rate-limits requests for PYQ data and other question-heavy routes.
 * Blocks based on UID (temporary) and IP (temporary).
 */
export const questionAbuseGuard = async (req, res, next) => {
  showLogs("[GUARD-CHECK] questionAbuseGuard started");
  
  // ----------------------- 3a. User Block Check (Permanent Block) -----------------------
  // Check if the user is permanently blocked in Firestore
  let blockEntry = guardCache.getBlock(req.uid);
  if (blockEntry === undefined) {
      // Fetch from Firestore and cache if not in memory
      blockEntry = await blockedUsersStore.read(req.uid);
      guardCache.setBlock(req.uid, blockEntry);
  } else {
      showLogs("[questionAbuseGuard] using cached block status.");
  }

  // Check if the user is permanently blocked and the block has not expired (if expiry is implemented)
  if (Object.keys(blockEntry).length > 0 && blockEntry.permanent === true) {
      showLogs("[questionAbuseGuard] permanently blocked uid:", req.uid);
      return res.status(403).json({ 
          error: "Your account has been permanently blocked due to abusive behavior.", 
          code: "PERM_BLOCKED" 
      });
  } else if (Object.keys(blockEntry).length > 0 && blockEntry.expiresAt && Date.now() < blockEntry.expiresAt) {
      showLogs("[questionAbuseGuard] user is temporarily blocked until:", new Date(blockEntry.expiresAt));
      return res.status(403).json({ 
          error: "You have been temporarily blocked for abusive behavior. Try again later.", 
          code: "TEMP_BLOCKED" 
      });
  } else if (Object.keys(blockEntry).length > 0) {
      // If block exists but is expired, delete from cache/database (optional but good practice)
      guardCache.deleteBlock(req.uid);
      showLogs("[questionAbuseGuard] user block has expired");
  }
  
  // ----------------------- 3b. IP Rate Limit Check (Temporary Block) -----------------------
  const ip = getClientIp(req);
  guardCache.cleanupIfNeeded();

  // Get current IP request timestamps
  const ipTimestamps = guardCache.requestCounts.get(ip) || [];
  ipTimestamps.push(Date.now());

  // Filter out timestamps older than ONE_MINUTE (60000ms)
  const recentIpRequests = ipTimestamps.filter(ts => Date.now() - ts < ONE_MINUTE);
  guardCache.requestCounts.set(ip, recentIpRequests);
  
  showLogs(`[GUARD-CHECK] QuestionAbuse: Key:${ip}, Requests:${recentIpRequests.length}/${QUESTION_ABUSE_MAX_PER_MINUTE}`);

  // Check IP rate limit
  if (recentIpRequests.length > QUESTION_ABUSE_MAX_PER_MINUTE) {
      showLogs("[questionAbuseGuard] IP blocked (rate limit exceeded) for IP:", ip);
      // We are returning 429 Too Many Requests status code for rate limiting
      return res.status(429).json({ 
          error: `Rate limit exceeded for IP ${ip}. Try again in 1 minute.`, 
          code: "IP_RATE_LIMITED"
      });
  } else {
      showLogs("[questionAbuseGuard] IP access allowed.");
  }


  // ----------------------- 3c. User Rate Limit Check (Temporary Block) -----------------------
  // Get current User request timestamps
  const userTimestamps = guardCache.requestCounts.get(req.uid) || [];
  userTimestamps.push(Date.now());

  // Filter out timestamps older than ONE_MINUTE (60000ms)
  const recentUserRequests = userTimestamps.filter(ts => Date.now() - ts < ONE_MINUTE);
  guardCache.requestCounts.set(req.uid, recentUserRequests);
  
  showLogs(`[GUARD-CHECK] QuestionAbuse: Key:${req.uid}, Requests:${recentUserRequests.length}/${QUESTION_ABUSE_MAX_PER_MINUTE}`);

  // Check User rate limit (using the same threshold as IP for simplicity)
  if (recentUserRequests.length > QUESTION_ABUSE_MAX_PER_MINUTE) {
      showLogs("[questionAbuseGuard] User blocked (rate limit exceeded) for UID:", req.uid);
      // We are returning 429 Too Many Requests status code for rate limiting
      return res.status(429).json({ 
          error: `Rate limit exceeded for user ${req.uid}. Try again in 1 minute.`, 
          code: "USER_RATE_LIMITED"
      });
  } else {
      showLogs("[questionAbuseGuard] User access allowed.");
  }
  

  next();
};

// ----------------- authAbuseGuard -----------------
export function authAbuseGuard(req, res, next) {
  showLogs("[GUARD-CHECK] authAbuseGuard started");
  guardCache.cleanupIfNeeded();

  try {
    const ip = getClientIP(req);
    const deviceId = (req.body && req.body.deviceId) || 
      (req.headers && (req.headers['x-forwarded-for'] || req.headers['x-deviceid'])) || 
      'no-device';
    const now = Date.now();

    if (!guardCache.authAttemptCounts.has(ip)) {
      guardCache.authAttemptCounts.set(ip, []);
    }
    
    const ipAttempts = guardCache.authAttemptCounts.get(ip);
    const recentIpAttempts = ipAttempts.filter(ts => now - ts < ONE_MINUTE);
    recentIpAttempts.push(now);
    guardCache.authAttemptCounts.set(ip, recentIpAttempts);

    if (recentIpAttempts.length >= AUTH_ATTEMPT_THRESHOLD_PER_MINUTE) {
      showLogs("[authAbuseGuard] abuse detected, too many auth attempts for ip:", ip);
      return res.status(429).json({ error: "Too many authentication attempts. Please try again later." });
    }

    showLogs(`[GUARD-CHECK] AuthAbuse: IP:${ip}, Attempts:${recentIpAttempts.length}/${AUTH_ATTEMPT_THRESHOLD_PER_MINUTE}`);
    return next();
  } catch (err) {
    showLogs("[authAbuseGuard] unexpected error", err?.message || err);
    // In case of error, allow the request to proceed to avoid blocking legitimate users
    return next();
  }
}


