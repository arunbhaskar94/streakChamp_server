import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import CryptoJS from 'crypto-js';

// local libs (unchanged names) - keep these as separate modules to improve testability
import { showLogs } from './lib/logs.js';
import {
  authenticateRequest,
  guestExpiryGuard,
  authAbuseGuard,
  questionAbuseGuard
} from './lib/guards.js';

import {
  filterQuestionsAndRecord,
  saveDeletedUserData,
  getUserByDevice,
  findExistingGuestUser,
  getQuestionsFromDatabase,
  updateUserLoginData
} from './res/local_file_functions.js';

import authRoutes from './routes/auth.js';
import bubbleRoutes  from './routes/bubble.js';
import chapterRoutes  from './routes/chapter.js';
import mockRoutes  from './routes/mock.js';
import pyqsRoutes  from './routes/pyqs.js';
import reelsRoutes from './routes/reels.js';
import updateRoutes from './routes/updateData.js';
import { db, auth, admin, rtDb} from './lib/firebase.js';
import {
 updateAllRanks,dailyHpMaintenance, deleteUnwantedUsers, 
 loadInvalidQuestionReport,validateQuestionBankAll } from './res/Timer_functions.js';
import { pingRateAllowed } from './lib/rateLimiter.js';
import { safeReadJSON, safeWriteJSON } from './lib/fileStore.js';
import {
  blockedUsersStore,
  suspectedUsersStore,
  userLoginDataStore
} from './lib/firestoreStore.js';


import pingRouteFactory from './routes/ping.js';

// -----------------------------
// Config / constants
// -----------------------------
let PORT = Number(process.env.PORT) || 8080;
let actualKey = process.env.SECRET_KEY;
let REELS_COUNT = 5;
let SUMMARY_RECENT_LIMIT = 20;
let ONE_MINUTE = 60 * 1000;
let ONE_DAY_IN_MS = 86400000;
let SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
let THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;
let LEADERBOARD_REELS = 'leaderboardReels';
let LEADERBOARD_MOCK = 'leaderboardMock';
let LEADERBOARD_COMBINED = 'leaderboardCombined';

let APP_ROOT = process.cwd();



let questionBank = [];
let mockIndex = {};
let PYQs_data = {};
let invalidQuestionOverrides = {};


// -----------------------------
// Helpers
// -----------------------------
async function ensureDir(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
    return true;
  } catch (err) {
    showLogs(`Failed to ensure dir ${dirPath}: ${err.message}`);
    return false;
  }
}

async function ensureFile(filePath, defaultContent = '{}') {
  try {
    let dir = path.dirname(filePath);
    await ensureDir(dir);
    try {
      await fs.access(filePath);
    } catch {
      await fs.writeFile(filePath, defaultContent, 'utf8');
      showLogs(`Created file: ${filePath}`);
    }
    return true;
  } catch (err) {
    showLogs(`Error ensuring file ${filePath}: ${err.message}`);
    return false;
  }
}

async function readJsonSafe(filePath, fallback) {
  try {
    let raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    showLogs(`Failed to read/parse ${filePath}: ${err.message}`);
    return fallback;
  }
}

// === Backwards-compatible alias for invalidQuestionOverridesData ===
let invalidQuestionOverridesData;

if (typeof invalidQuestionOverrides !== 'undefined') {
  // if your in-memory variable is named invalidQuestionOverrides
  invalidQuestionOverridesData = invalidQuestionOverrides;
} else if (typeof invalidQuestionOverridesFile !== 'undefined') {
  // if you have a file path variable for it, try to read it (fs must be imported)
  try {
    let raw = fs.readFileSync(invalidQuestionOverridesFile, 'utf8');
    invalidQuestionOverridesData = JSON.parse(raw);
  } catch (err) {
    console.warn('[server.js] Could not read invalidQuestionOverridesFile — using empty array', err);
    invalidQuestionOverridesData = [];
  }
} else {
  // last-resort safe default to avoid crashes
  console.warn('[server.js] Warning: invalidQuestionOverrides / invalidQuestionOverridesFile not found — using empty array');
  invalidQuestionOverridesData = [];
}



// -----------------------------
// App & middleware
// -----------------------------
let app = express();
app.use(cors({
  origin: [
    'https://streakchamp.vercel.app',
    'http://127.0.0.1:5501'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With' , 'X-Fetch-Type'], 
  credentials: true
}));
app.use(express.json());


let wrapAsync = (fn) => (req, res, next) => {
  try {
    let r = fn(req, res, next);
    if (r && typeof r.then === 'function') r.catch(next);
  } catch (err) {
    next(err);
  }
};


app.get('/', (req, res) => {
  showLogs('✅ Server is running successfully!');
  res.send('✅ Server is running successfully!');
});

const connectPingHandler = pingRouteFactory(admin, userLoginDataStore, suspectedUsersStore, blockedUsersStore);
app.post('/connect-ping', connectPingHandler);


app.get('/health', (req, res) => {
  // Minimal response; avoid heavy checks to keep it fast.
  const payload = { ok: true, uptimeSec: Math.floor(process.uptime()), ts: Date.now() };
  res.set('Cache-Control', 'no-store, max-age=0');
  return res.status(200).json(payload);
});


app.get('/secure-imgs/*',
  wrapAsync(authenticateRequest),
  wrapAsync(guestExpiryGuard),
  wrapAsync(authAbuseGuard),
  wrapAsync(questionAbuseGuard),
  (req, res) => {
    const filename = req.params[0]; 
    showLogs('Received request for secure image:', filename);

    const filePath = path.join(APP_ROOT, filename);
    showLogs(`Secure image request for ${filename} at ${filePath}`);

    if (!fsSync.existsSync(filePath)) {
      showLogs(`File not found: ${filePath}`);
      return res.status(404).json({ error: 'not found' });
    }

    showLogs(`Serving secure image file: ${filePath}`);
    res.setHeader('Cache-Control', 'private, max-age=3600'); // private cache
    return res.sendFile(filePath);
  }
);


// server.js (New/Modified Code)

// Wrap the common guards for cleaner use
app.use(
    wrapAsync(authenticateRequest),
    wrapAsync(guestExpiryGuard),
    
)

// Apply the guards to question-heavy routes
app.use('/chapter', wrapAsync(questionAbuseGuard), chapterRoutes);
app.use('/bubble', wrapAsync(questionAbuseGuard), bubbleRoutes);
app.use('/mocks', wrapAsync(questionAbuseGuard), mockRoutes);
app.use('/pyqs', wrapAsync(questionAbuseGuard), pyqsRoutes);
app.use('/reels', wrapAsync(questionAbuseGuard), reelsRoutes);

// The 'updateUser' route likely only needs Authentication and Guest Check,
// but NOT the questionAbuseGuard (unless it also fetches questions)
app.use('/updateUser', wrapAsync(authenticateRequest), wrapAsync(guestExpiryGuard), updateRoutes);

// Your AUTH routes (e.g., login, register) should ONLY use the AuthAbuseGuard.
// They must NOT use authenticateRequest because the token isn't yet available.
// NOTE: Assuming your authRoutes is mounted at '/auth' or similar.
app.use('/auth', wrapAsync(authAbuseGuard), authRoutes);
// custom middleware registration happens after files are ensured in init()

// -----------------------------
// Business logic (example: streak update)
// -----------------------------



const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// -----------------------------
// Init: ensure files, load data, register middleware & static routes, start server
// -----------------------------

(async function init() {
  try {

    let base = APP_ROOT;
    let [qDataRaw, mDataRaw, pyqDataRaw] = await Promise.all([
      readJsonSafe(path.join(base, 'server questions data', 'question_data.json'), []),
      readJsonSafe(path.join(base, 'server questions data', 'mock.json'), {}),
      readJsonSafe(path.join(base, 'server questions data', 'PYQs_data.json'), {})
    ]);

    questionBank = Array.isArray(qDataRaw) ? qDataRaw : [];
    questionBankData = questionBank;
    mockIndex = (mDataRaw && typeof mDataRaw === 'object') ? mDataRaw : {};
    PYQs_data = (pyqDataRaw && typeof pyqDataRaw === 'object') ? pyqDataRaw : {};

    showLogs(`Loaded ${questionBank.length} questions and ${Object.keys(mockIndex).length} mocks.`);
    showLogs(`Loaded PYQs_data entries: ${Object.keys(PYQs_data).length}`);

    
    // Example small route - expand into modular router files as needed
    app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

    // Start server
    app.listen(PORT, () => showLogs(`✅ Server running on port ${PORT}`));

  } catch (err) {
    showLogs(`Init error: ${err && err.message}`);
    process.exit(1);
  }
})();


  async function updateUserStreak(userId) {
    if (!db) throw new Error('Firestore not initialized');
    let now = Date.now();
    let userRef = db.collection('users').doc(userId);
    let highestRef = db.collection('ranking').doc('highestStreakUsers').collection('users').doc(userId);
  
    showLogs(`Updating streak for ${userId} at ${new Date(now).toISOString()}`);
  
    let userDoc = await userRef.get();
    let data = userDoc.exists ? userDoc.data() : {};
  
    let lastLogin = data.lastLogin ?? 0;
    let currentStreakDays = data.currentStreakDays ?? 0;
    let currentStreakScore = data.currentStreakScore ?? 0;
    let highestStreakDays = data.highestStreakDays ?? 0;
    let highestStreakScore = data.highestStreakScore ?? 0;
  
    let withinContinueWindow = (now - lastLogin) < (ONE_DAY_IN_MS * 2) && (now - lastLogin) > (ONE_DAY_IN_MS * 0.5);
  
    if (withinContinueWindow) {
      currentStreakDays += 1;
      currentStreakScore += 100;
      if (currentStreakDays === 7) currentStreakScore += 300;
      if (currentStreakDays === 30) currentStreakScore += 700;
    } else {
      currentStreakDays = 1;
      currentStreakScore = 100;
    }
  
    if (currentStreakDays > highestStreakDays) {
      highestStreakDays = currentStreakDays;
      highestStreakScore = currentStreakScore;
    }
  
    await userRef.set({
      lastLogin: now,
      currentStreakDays,
      currentStreakScore,
      highestStreakDays,
      highestStreakScore
    }, { merge: true });
  
    await highestRef.set({ uid: userId, highestStreakDays, highestStreakScore }, { merge: true });
  
    showLogs(`Streak updated for ${userId}`);
    return { currentStreakDays, highestStreakDays };
  }


app.get('/check-user-status', async (req, res) => {
  showLogs("🔹 Received request at /check-user-status");
  let authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    showLogs("❌ Unauthorized: no or bad Authorization header");
    return res.status(401).json({
      status: "no-auth",
      message: "No token provided or token format invalid."
    });
  }

  let token = authHeader.split(' ')[1];
  try {
    showLogs("🔹 Verifying Firebase ID token...");
    let decodedToken = await auth.verifyIdToken(token);
    showLogs(`✅ Token verified for user: ${decodedToken.uid}`);

    // Wrap every Firestore call in its own try/catch so you know exactly where it fails:
    let userDoc;
    try {
      showLogs("🔹 Fetching user document from Firestore...");
      userDoc = await db.collection('users').doc(decodedToken.uid).get();
      if (!userDoc.exists) {
        showLogs(`❌ No user doc for ${decodedToken.uid}`);
        return res.status(404).json({ status: "not-found", message: "User not found." });
      }
    } catch (fsErr) {
      showLogs("❌ Firestore read error:", fsErr);
      // log full stack and properties
      // showLogs(fsErr.stack || fsErr);
      return res.status(500).json({ status: "error", message: "Firestore read failed", error: fsErr.toString() });
    }

    let userData = userDoc.data();
    let isGuest = userData.isGuest;
    let creation = userData.creationTime || decodedToken.auth_time * 1000;
    let emailVerified = decodedToken.email_verified;
    let ageHours = (Date.now() - new Date(creation).getTime()) / (1000 * 3600);

    // Guest‑to‑full upgrade
    if (isGuest && emailVerified && decodedToken.email && !decodedToken.email.includes('guest')) {
      showLogs(`🔄 Converting guest→full for ${decodedToken.uid}`);
      try {
        await db.collection('users').doc(decodedToken.uid).set({ isGuest: false }, { merge: true });
        isGuest = false;
        showLogs("✅ isGuest flag updated in Firestore");
      } catch (updateErr) {
        showLogs("❌ Firestore update error:", updateErr);
        //showLogs(updateErr.stack || updateErr);
        // but we’ll continue, since it’s not fatal for status check
      }
    }

    // Main auth logic
    if (emailVerified) {
      showLogs("🔹 Email is verified");
      if (isGuest && ageHours > 24) {
        showLogs("⚠️ Guest session expired (>24h)");
        return res.json({ status: "guest-login-required", data: userData });
      } else {
        return res.json({ status: "authenticated", data: userData });
      }
    } else {
      showLogs("🔹 Email is NOT verified");
      if (ageHours > 24) {
        showLogs("⚠️ Session expired (>24h) for unverified user");
        return res.json({
          status: isGuest ? "guest-login-required" : "email-verification-required",
          data: isGuest ? undefined : userData
        });
      } else {
        showLogs("🔹 Session still valid (<24h) despite unverified email");
        return res.json({ status: "authenticated", data: userData });
      }
    }

  } catch (error) {
    // THE BIG CATCH: log absolutely everything
    showLogs("❌ Unhandled error in /check-user-status:");
    // showLogs("Full error object:", error);
    //showLogs("Stack trace:", error.stack);
    // if it's a FirebaseAuthError, it has code + details:
    //if (error.code) showLogs("Error.code:", error.code);
    //if (error.details) showLogs("Error.details:", error.details);

    return res.status(500).json({
      status: "error",
      message: "Internal server error during user status check",
     error: process.env.NODE_ENV === 'development' ? error : { message: 'Internal error' }
    });
  }
});

// Add to server.js or your routes
app.get('/get-user-data', async (req, res) => {
    showLogs("🔹 Received request at /get-entire-user-data");
  let authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    showLogs("❌ Unauthorized access. No token provided or token format invalid.");
    return res.status(401).json({ status: 'error', message: 'Unauthorized access. No token provided.' });
  }

  let token = authHeader.split(' ')[1];

  try {
    let decodedToken = await auth.verifyIdToken(token);
    let userId = decodedToken.uid;
    showLogs(`✅ Token verified for user: ${userId}`);

    let userDoc = await db.collection('users').doc(userId).get();

    // Ranking documents
    let leaderboardReelsDoc = await db.collection('ranking').doc("leaderboardReels").collection("users").doc(userId).get();
    let leaderboardMockDoc = await db.collection('ranking').doc("leaderboardMock").collection("users").doc(userId).get();
    let leaderboardCombinedDoc = await db.collection('ranking').doc("leaderboardCombined").collection("users").doc(userId).get();
    let leaderboardBubbleDoc = await db.collection('ranking').doc("bubbleGame").collection("users").doc(userId).get();

    if (!userDoc.exists) {
      showLogs(`❌ User data not found for user ID ${userId}.`);
      return res.status(404).json({ status: 'error', message: 'User data not found.' });
    }

    let userData = userDoc.data();
    let rankingReelsData = leaderboardReelsDoc.exists ? leaderboardReelsDoc.data() : {};
    let rankingMockData = leaderboardMockDoc.exists ? leaderboardMockDoc.data() : {};
    let rankingCombinedData = leaderboardCombinedDoc.exists ? leaderboardCombinedDoc.data() : {};
    let rankingBubbleData = leaderboardBubbleDoc.exists ? leaderboardBubbleDoc.data() : {};

    let totalCorrectReels = userData.TotalcorrectReels || 0;
    let totalWrongReels = userData.TotalwrongReels || 0;
    let totalCorrectMocks = userData.TotalcorrectMocks || 0;
    let totalWrongMocks = userData.TotalwrongMocks || 0;
    let hp = userData.hp || 0;
    let lastDailyChest = userData.lastDailyChest || 0;
    let lastPlayed = userData.lastPlayed || 0;
    let level = userData.level || 0;
    let score = userData.score || 0;
    let xp = userData.xp || 0;
    let streaks = currentStreakDays || 0;

    let userFilteredData = {
      hp: hp,
      xp: xp,
      lastPlayed: lastPlayed,
      lastDailyChest: lastDailyChest,
      level: level,
      score: score,
      displayName: userData.displayName || 'Unknown',
      email: decodedToken.email || 'N/A',
      emailVerified: decodedToken.email_verified || false,
      creationTime: userData.creationTime || null,
      tokens: userData.tokens || 0,
      isGuest: userData.isGuest || false,
      streaks: streaks,
      // Reel Stats
      TotalcorrectReels: totalCorrectReels,
      TotalwrongReels: totalWrongReels,
      TotaltimeTakenReels: userData.TotaltimeTakenReels || 0,
      TotaltimeforCorrectReelsQuestions: userData.TotaltimeforCorrectReelsQuestions || 0,
      TotaltimeforWrongReelsQuestions: userData.TotaltimeforWrongReelsQuestions || 0,

      // Mock Stats
      TotalUnattemptedMocks: userData.TotalUnattemptedMocks || 0,
      TotalcorrectMocks: totalCorrectMocks,
      TotalwrongMocks: totalWrongMocks,
      TotaltimeTakenMocks: userData.TotaltimeTakenMocks || 0,
      TotaltimeforCorrectMockQuestions: userData.TotaltimeforCorrectMockQuestions || 0,
      TotaltimeforWrongMockQuestions: userData.TotaltimeforWrongMockQuestions || 0,

      // Ranking Data
      rankingReels: {
        reelScore: rankingReelsData.reelScore || 0,
        TimeAccuracy: rankingReelsData.TimeAccuracy || 0,
        rankInReels: rankingReelsData.rankInReels || 0,
      },
      rankingMock: {
        MockScore: rankingMockData.MockScore || 0,
        TimeAccuracy: rankingMockData.TimeAccuracy || 0,
        rankInMocks: rankingMockData.rankInMocks || 0,
      },
      rankingCombined: {
        totalScore: rankingCombinedData.totalScore || 0,
        TimeAccuracy: rankingCombinedData.TimeAccuracy || 0,
        rankCombined: rankingCombinedData.rankCombined || 0,
      },
      rankingBubble: {
        xp: rankingBubbleData.xp || 0,
        level: rankingBubbleData.level || 0,
        score: rankingBubbleData.bubbleScore || 0,
        updatedAt: rankingBubbleData.updatedAt || null,
        rankInBubble: rankingBubbleData.rankInBubble || 0
      }
    };

    res.json({ status: 'success', data: userFilteredData });
  } catch (error) {
    showLogs('❌ Error fetching user data:', error);
    res.status(500).json({
      status: 'error',
      message: `Failed to retrieve user data: ${error.message}`,
      error: error.message
    });
  }
});

app.get('/rankings', async (req, res) => {
  showLogs("🔹 Received request at /rankings");
  let leaderboardType = req.query.type || 'leaderboardCombined'; // Default to combined

  let validLeaderboardTypes = ['leaderboardReels', 'leaderboardMock', 'leaderboardCombined'];
  if (!validLeaderboardTypes.includes(leaderboardType)) {
    showLogs(`⚠️ /rankings: Invalid leaderboardType: ${leaderboardType}`);
    return res.status(400).json({ status: 'error', message: 'Invalid leaderboard type.' });
  }

  try {
    let collectionRef = db.collection("ranking").doc(leaderboardType).collection("users"); // Use the global db instance

    // Determine the field to order by based on type
    let orderByField;
    if (leaderboardType === 'leaderboardReels') {
      orderByField = 'reelScore';
    } else if (leaderboardType === 'leaderboardMock') {
      orderByField = 'MockScore';
    } else { // leaderboardCombined
      orderByField = 'totalScore';
    }

    // Fetch top 10 rankings ordered by score (desc), then timeAccuracy (asc)
    let rankingSnapshot = await collectionRef.orderBy(orderByField, 'desc').orderBy('TimeAccuracy', 'asc').limit(10).get();

    if (rankingSnapshot.empty) {
      showLogs(`⚠️ Query returned no rankings for ${leaderboardType}!`);
      return res.json({ rankings: [] });
    }

    let rankings = [];
    rankingSnapshot.forEach(doc => {
      let data = doc.data();
      let rankField;
      if (leaderboardType === 'leaderboardReels') {
        rankField = 'rankInReels';
      } else if (leaderboardType === 'leaderboardMock') {
        rankField = 'rankInMocks';
      } else {
        rankField = 'rankCombined';
      }

      // Only include documents that have a valid score (not 0 or undefined)
      if (data[orderByField] !== undefined && data[orderByField] !== 0) {
        rankings.push({
          userId: doc.id, // Include userId for client-side matching if needed
          rank: data[rankField] || 0, // Use the specific rank field
          displayName: data.displayName || "Anonymous",
          score: data[orderByField] ?? 0, // General score field
          TimeAccuracy: data.TimeAccuracy ?? 0
        });
      }
    });

    showLogs(`✅ Rankings fetched successfully for ${leaderboardType}:`, rankings.length > 0 ? rankings : "No valid rankings found.");
    res.json({ rankings });

  } catch (error) {
    showLogs("❌ /rankings: Error fetching rankings:", error);
    return res.status(500).json({ status: 'error', message: `Failed to retrieve rankings: ${error.message}`, error: error.message });
  }
});



app.get("/check-verification", async (req, res) => {
  showLogs("🔹 Received /check-verification request.");
  let { uid } = req.query;

  if (!uid) {
    showLogs("⚠️ /check-verification: Validation Error: User ID is required.");
    return res.status(400).json({ message: "User ID is required" });
  }

  try {
    let user = await auth.getUser(uid); // Use the global auth instance
    showLogs(`✅ /check-verification: Fetched user data for uid: ${uid}. Email verified: ${user.emailVerified}`);
    return res.json({ verified: user.emailVerified });
  } catch (error) {
    showLogs(`❌ /check-verification: Error checking verification status for userId ${uid}:`, error.message);
    return res.status(500).json({ status: 'error', message: `Failed to check verification status: ${error.message}`, error: error.message });
  }
});



app.post('/all/leaderboard/:leaderboard_type', async (req, res) => {
  let userId = req.uid;
  let leaderboardType = req.params.leaderboard_type.toLowerCase();

  let firestoreCollectionName = "";
  switch (leaderboardType) {
    case "reels":
      firestoreCollectionName = "leaderboardReels";
      break;
    case "mock":
      firestoreCollectionName = "leaderboardMock";
      break;
    case "pyq":
      firestoreCollectionName = "leaderboardPYQ";
      break;
    case "combined":
      firestoreCollectionName = "leaderboardCombined";
      break;
    default:
      return res.status(400).json({ message: "Invalid leaderboard type specified." });
  }

  try {
    // The leaderboard document structure is /ranking/{leaderboardType}/users/{uid}
    let leaderboardDocRef = db.collection('ranking').doc(firestoreCollectionName).collection('users').doc(userId);
    let leaderboardDoc = await leaderboardDocRef.get();

    if (leaderboardDoc.exists) {
      let leaderboardData = leaderboardDoc.data();
      // Ensure expected fields are present
      return res.status(200).json({
        displayName: leaderboardData.displayName || 'N/A',
        reelScore: leaderboardData.reelScore || 0,
        MockScore: leaderboardData.MockScore || 0,
        totalScore: leaderboardData.totalScore || 0,
        TimeAccuracy: leaderboardData.TimeAccuracy || 0, // This is the calculated TimeAccuracy from the backend
        rankInReels: leaderboardData.rankInReels || 'N/A',
        rankInMocks: leaderboardData.rankInMocks || 'N/A',
        rankInCombined: leaderboardData.rankInCombined || 'N/A',
        updatedAt: leaderboardData.updatedAt ? leaderboardData.updatedAt.toDate() : null // Convert Firestore Timestamp to JS Date object
      });
    } else {
      return res.status(404).json({ message: `No ${leaderboardType} leaderboard data found for this user.` });
    }
  } catch (error) {
    showLogs(`Error fetching ${leaderboardType} leaderboard data:`, error);
    return res.status(500).json({ message: `Internal server error: ${error.message}` });
  }
});

app.post('/api/notify', async (req, res) => {
  showLogs("🔹 Received request at /api/notify");
  let { toUid, fromUsername, message, chatId } = req.body;
  if (!toUid || !message) {
    showLogs("⚠️ /api/notify: Missing fields.");
    return res.status(400).send('Missing fields');
  }

  try {
    let userSnap = await db.doc(`users/${toUid}`).get(); // Use the global db instance
    let token = userSnap.data()?.fcmToken;
    if (!token) {
      showLogs(`⚠️ No FCM token for user ${toUid}. Cannot send notification.`);
      return res.sendStatus(204); // No content, but successful processing
    }

    let payload = {
      notification: {
        title: `New message from ${fromUsername}`,
        body: message.length > 50 ? message.slice(0, 47) + '…' : message,
        // Ensure this clickAction URL is correct for your web app
        clickAction: `https://streakchamp.vercel.app/?chat=${encodeURIComponent(chatId)}`
      },
      data: {
        chatId,
        sender: fromUsername
      }
    };

    // Uncomment the following line if you have Firebase Cloud Messaging (FCM) set up
    // and 'admin.messaging()' is properly initialized.
    // await admin.messaging().sendToDevice(token, payload);
    showLogs("FCM send call is commented out. Ensure Firebase Cloud Messaging is configured if needed.");
    res.sendStatus(200);

  } catch (err) {
    showLogs("❌ Error sending notification:", err);
    res.status(500).send(`Failed to send notification: ${err.message}`);
  }
});

app.post("/updateTokens", async (req, res) => {
  showLogs("🔹 Received updateTokens request:", req.body);
  const { userId, gameEvents } = req.body;

  // 1) Validate inputs
  if (
    !userId ||
    !Array.isArray(gameEvents) ||
    gameEvents.some(e => e !== "token" && e !== "ad")
  ) {
    showLogs("❌ Invalid game data received:", req.body);
    return res.status(400).json({ success: false, error: "Invalid game data" });
  }

  // 2) Tally events
  const tokenEventsCount = gameEvents.filter(e => e === "token").length;
  const adEventsCount = gameEvents.filter(e => e === "ad").length;

  // 3) Compute awards
  const randomBonus = Math.floor(Math.random() * 5) + 1;      // 1–5 multiplier
  const tokensFromToken = tokenEventsCount * randomBonus;
  const tokensFromAds = adEventsCount;                         // 1 token per ad
  const tokensAwarded = tokensFromToken + tokensFromAds;

  showLogs(
    `🔹 tokenEvents=${tokenEventsCount}, adEvents=${adEventsCount}, ` +
    `bonus=${randomBonus}, totalAward=${tokensAwarded}`
  );

  try {
    const newHp = randomInt(100, 500); // set hp to a random value 500-1500
    const tokensAwarded2 = (tokensAwarded * randomInt(1, 5))
    // 4) Persist
    const userDocRef = db.collection("users").doc(userId);
    await userDocRef.set({
      tokens: admin.firestore.FieldValue.increment(tokensAwarded2),
      hp: admin.firestore.FieldValue.increment(newHp),
    }, { merge: true });
    showLogs(`✅ Updated user ${userId} tokens by +${tokensAwarded2} and hp by + ${newHp}`);
    return res.json({ success: true, tokensAwarded2 });
  } catch (error) {
    showLogs(`❌ Error updating tokens for user ${userId}:`, error);
    return res.status(500).json({
      success: false,
      message: `Failed to update tokens: ${error.message}`,
    });
  }
});


// Scheduled tasks configuration
const SCHEDULE = {
  DAILY: ONE_DAY_IN_MS,
  WEEKLY: SEVEN_DAYS_MS
};


function runDailyTasks() {
  showLogs("🔹 Triggering scheduled rank update...");
  updateAllRanks()
    .catch(error => showLogs("❌ Error during scheduled rank update:", error));

  dailyHpMaintenance()
    .catch(e => showLogs("warn", "dailyHpMaintenance startup failed", e.message));

  deleteUnwantedUsers()
    .catch(e => showLogs("warn", "delete unwanted users startup failed", e.message));
}

function runWeeklyTasks() {
  showLogs("🔹 Triggering loadInvalidQuestionReport...");
  loadInvalidQuestionReport()
    .catch(error => showLogs("❌ Error during loadInvalidQuestionReport:", error));

  setTimeout(() => {
    validateQuestionBankAll(1000)
      .then(res => showLogs("Auto-validate result summary:", res))
      .catch(err => showLogs("Auto-validate error:", err));
  }, 4000);
}

// Initialize intervals
setInterval(runDailyTasks, SCHEDULE.DAILY);
setInterval(runWeeklyTasks, SCHEDULE.WEEKLY);


showLogs("✅ Scheduled tasks initialized.");



export {
  actualKey,
  REELS_COUNT,
  questionBank,
  invalidQuestionOverrides,
  SUMMARY_RECENT_LIMIT,
  ONE_MINUTE,
  ONE_DAY_IN_MS,
  SEVEN_DAYS_MS,
  THREE_MONTHS_MS,
  LEADERBOARD_REELS,
  LEADERBOARD_MOCK,
  LEADERBOARD_COMBINED,
  questionBankData,
  mockIndex,
  PYQs_data,
  invalidQuestionOverridesData
}


/*
push git from this 


# Increase HTTP buffer (helps when pushing big packs)
git config --local http.postBuffer 524288000

# Force HTTP/1.1 (sometimes helps with proxy/timeouts)
git config --local http.version HTTP/1.1

# Reduce chances of disconnect due to slow networks
git config --global http.lowSpeedLimit 0
git config --global http.lowSpeedTime 999999



git status
git fetch --all
git pull origin main  # Replace 'main' with your branch name
git add .
git commit -m "Updated files with latest changes"
git push origin main




if you encounter any conflict then run >>> 


git status
git fetch --all
git pull origin main  # Replace 'main' with your branch name
git add .
git commit -m "Updated files with latest changes"
git push origin main
git add .
git commit -m "Resolved merge conflicts"
git push origin main



to delete everything 

cd streakchamp
git rm -r --cached .
git commit -m "Deleted all files"
git push origin main  # or the branch name



to upload current folder 

cd "D:/version 2.9 final - Copy/streakchapm 2.9/public"
git pull origin main --rebase  # Fetch latest changes and rebase
git add .                      # Stage all new and modified files
git commit -m "Added version 2.9 final files"  # Commit changes
git push origin main --force          # Push to GitHub
    


*/
