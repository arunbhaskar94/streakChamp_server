// /api/connect-ping.js
// Backend endpoint for client connectivity checks and device mapping
// Handles client authentication, rate limiting, and anomaly detection

const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const MAX_PINGS_PER_WINDOW = 10;
const ANOMALY_THRESHOLD = 4; // Suspected events before blocking
const IP_CHANGE_THRESHOLD = 1000 * 60 * 60 * 24; // 24 hours for IP change consideration
import { showLogs } from '../lib/logs.js'
class ConnectPingService {
  constructor(admin, userLoginDataStore, suspectedUsersStore, blockedUsersStore) {
    this.admin = admin;
    this.userLoginDataStore = userLoginDataStore;
    this.suspectedUsersStore = suspectedUsersStore;
    this.blockedUsersStore = blockedUsersStore;
    this.rateLimitCache = new Map(); // In production, use Redis instead
  }

  /**
   * Extract client IP from request headers
   */
  getClientIp(req) {
    const forwardedFor = req.headers['x-forwarded-for'];
    const realIp = req.headers['x-real-ip'];
    
    if (forwardedFor) {
      return forwardedFor.split(',')[0].trim();
    }
    if (realIp) {
      return realIp;
    }
    return req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown';
  }

  /**
   * Verify Firebase ID token and return decoded claims
   */
  async verifyAuthToken(token) {
    if (!token) return { verified: false, uid: null };
    
    try {
      const decoded = await this.admin.auth().verifyIdToken(token);
      return { verified: true, uid: decoded.uid };
    } catch (error) {
      showLogs('Auth token verification failed:', error.message);
      return { verified: false, uid: null };
    }
  }

  /**
   * Rate limit check by device ID and IP
   */
  isRateLimited(deviceId, clientIp) {
    const now = Date.now();
    const key = `${deviceId}-${clientIp}`;
    
    const window = this.rateLimitCache.get(key);
    
    // Clean old entries
    if (window && now - window.startTime > RATE_LIMIT_WINDOW_MS) {
      this.rateLimitCache.delete(key);
      return false;
    }
    
    if (!window) {
      this.rateLimitCache.set(key, {
        startTime: now,
        count: 1
      });
      return false;
    }
    
    window.count++;
    return window.count > MAX_PINGS_PER_WINDOW;
  }

  /**
   * Generate device mapping key
   */
  generateMappingKey(deviceId, verifiedUid) {
    if (deviceId) return deviceId;
    if (verifiedUid) return `uid-${verifiedUid}`;
    return `anon-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Detect anomalies in user behavior
   */
  detectAnomalies(existingEntry, newEntry) {
    const anomalies = [];

    // Device reassigned to different UID
    if (existingEntry?.uid && newEntry.uid && existingEntry.uid !== newEntry.uid) {
      anomalies.push({
        type: 'device_reassigned_uid',
        previousUid: existingEntry.uid,
        newUid: newEntry.uid,
        timestamp: new Date().toISOString()
      });
    }

    // Significant IP change (only if previous IP exists and it's been a while)
    if (existingEntry?.lastSeenServerIp && 
        existingEntry.lastSeenServerIp !== newEntry.lastSeenServerIp &&
        existingEntry.lastSeenAt && 
        (Date.now() - existingEntry.lastSeenAt) < IP_CHANGE_THRESHOLD) {
      anomalies.push({
        type: 'suspicious_ip_change',
        from: existingEntry.lastSeenServerIp,
        to: newEntry.lastSeenServerIp,
        timestamp: new Date().toISOString()
      });
    }

    return anomalies;
  }

  /**
   * Handle suspected user escalation
   */
  async handleSuspectedUser(mappingKey, anomalies, clientIp) {
    try {
      const suspected = await this.suspectedUsersStore.read(mappingKey) || {
        count: 0,
        events: [],
        firstSeen: Date.now(),
        lastUpdated: Date.now()
      };

      suspected.count += 1;
      suspected.events.push(...anomalies);
      suspected.lastUpdated = Date.now();

      await this.suspectedUsersStore.write(suspected, mappingKey);

      // Escalate to blocked if threshold exceeded
      if (suspected.count >= ANOMALY_THRESHOLD) {
        const blockedEntry = {
          permanent: false,
          ips: [clientIp],
          devices: [mappingKey],
          since: Date.now(),
          reason: 'excessive_anomalies',
          suspectedEvents: suspected.events.length
        };
        await this.blockedUsersStore.write(blockedEntry, mappingKey);
        
        showLogs(`User ${mappingKey} blocked due to excessive anomalies`);
      }
    } catch (error) {
      showLogs('Failed to handle suspected user:', error);
    }
  }

  /**
   * Create or update user mapping
   */
  async updateUserMapping(mappingKey, existingEntry, verifiedData, clientData) {
    const now = Date.now();
    
    const newEntry = {
      deviceId: mappingKey,
      uid: verifiedData.uid || existingEntry?.uid || null,
      uidVerified: verifiedData.verified || false,
      lastSeenAt: now,
      lastSeenClientIp: clientData.reportedIp,
      lastSeenServerIp: clientData.serverIp,
      updatedAt: now,
      ...(existingEntry && { createdAt: existingEntry.createdAt || now }),
      ...(!existingEntry && { createdAt: now })
    };

    // Safely update email if provided and not already set
    if (clientData.email && !existingEntry?.email) {
      newEntry.email = String(clientData.email);
    } else if (existingEntry?.email) {
      newEntry.email = existingEntry.email;
    }

    // Preserve other existing fields
    const finalEntry = existingEntry 
      ? { ...existingEntry, ...newEntry }
      : newEntry;

    await this.userLoginDataStore.write(finalEntry, mappingKey);
    
    return {
      entry: finalEntry,
      created: !existingEntry,
      updated: !!existingEntry
    };
  }


  /**
   * Main connect-ping handler
   */
  async handleConnectPing(req, res) {
    const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    showLogs(`[${requestId}] Connect-ping request received`, {
      headers: req.headers,
      body: req.body
    });

    try {
      // 1. Extract and validate client information
      const clientIp = this.getClientIp(req);
      const deviceId = req.body?.deviceId ? String(req.body.deviceId) : null;
      const clientReportedIp = req.body?.ip ? String(req.body.ip) : null;
      const timestamp = req.body?.ts ? Number(req.body.ts) : Date.now();

      // 2. Verify authentication
      const authHeader = req.headers.authorization || '';
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();
      
      const authResult = await this.verifyAuthToken(token);
      const verifiedUid = authResult.uid || req.body?.uid || null;
      // 3. Rate limiting
      if (this.isRateLimited(deviceId, clientIp)) {
        showLogs(`[${requestId}] Rate limit exceeded for ${deviceId} from ${clientIp}`);
        return res.status(429).json({
          ok: false,
          error: 'rate_limit_exceeded',
          retryAfter: RATE_LIMIT_WINDOW_MS / 1000
        });
      }

      // 4. Generate mapping key and load existing data
      const mappingKey = this.generateMappingKey(deviceId, verifiedUid);
      const allUserData = await this.userLoginDataStore.readAll();
      const existingEntry = allUserData[mappingKey] || null;

      // 5. Update user mapping
      const clientData = {
        reportedIp: clientReportedIp,
        serverIp: clientIp,
        email: req.body?.email
      };

      const mappingResult = await this.updateUserMapping(
        mappingKey, 
        existingEntry, 
        authResult, 
        clientData
      );

      // 6. Detect and handle anomalies
      const anomalies = this.detectAnomalies(existingEntry, mappingResult.entry);
      
      if (anomalies.length > 0) {
        showLogs(`[${requestId}] Detected ${anomalies.length} anomalies for ${mappingKey}`);
        await this.handleSuspectedUser(mappingKey, anomalies, clientIp);
      }

      // 7. Send success response
      const response = {
        ok: true,
        requestId,
        deviceId: mappingKey,
        clientIp,
        clientReportedIp,
        uid: mappingResult.entry.uid,
        uidVerified: mappingResult.entry.uidVerified,
        mappingCreated: mappingResult.created,
        mappingUpdated: mappingResult.updated,
        timestamp: Date.now(),
        ...(anomalies.length > 0 && { anomalies })
      };

      showLogs(`[${requestId}] Connect-ping successful`, response);
      return res.json(response);

    } catch (error) {
      showLogs(`[${requestId}] Connect-ping error:`, error);
      
      return res.status(500).json({
        ok: false,
        error: 'internal_server_error',
        message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong',
        requestId
      });
    }
  }
}

// Export middleware factory
export default (admin, userLoginDataStore, suspectedUsersStore, blockedUsersStore) => {
  const service = new ConnectPingService(
    admin, 
    userLoginDataStore, 
    suspectedUsersStore, 
    blockedUsersStore
  );

  return async (req, res) => {
    return service.handleConnectPing(req, res);
  };
};

