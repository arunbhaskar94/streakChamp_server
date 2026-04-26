import express from "express";
import { showLogs } from '../lib/logs.js'
import {
  filterQuestionsAndRecord,
  saveDeletedUserData,
  getUserByDevice,
  findExistingGuestUser,
  getQuestionsFromDatabase,
  updateUserLoginData
} from '../res/local_file_functions.js';
import { db, auth, admin, rtDb } from "../lib/firebase.js";
const router = express.Router();

router.post("/actual", async (req, res) => {
  showLogs("🔹 Received /auth/actual request.");
  showLogs("🔹 Request body:", JSON.stringify(req.body, null, 2));
  showLogs("🔹 Request IP:", req.ip || req.connection.remoteAddress);

  const { email, password, name, deviceId } = req.body;
  const ip = req.ip || req.connection.remoteAddress;

  showLogs(`🔹 Processing auth for - Email: ${email}, Name: ${name}, Device: ${deviceId}, IP: ${ip}`);

  if (!email || !password || !name || !deviceId) {
    showLogs("⚠️ /auth/actual: Missing fields (email, password, name, deviceId).");
    showLogs("⚠️ Received fields:", { email: !!email, password: !!password, name: !!name, deviceId: !!deviceId });
    return res.status(400).json({ message: "Fields cannot be empty" });
  }

  try {
    showLogs("🔹 Checking for existing guest user...");
    const existingGuest = await getUserByDevice(deviceId, ip);
    showLogs("🔹 Existing guest check result:", existingGuest ? `Found: ${existingGuest.uid}` : "No existing guest found");

    // ----------------- CASE 1: Upgrade existing guest -----------------
    if (existingGuest && existingGuest.isGuest) {
      showLogs(`🔄 Converting guest to full account for device ${deviceId}, user ${existingGuest.uid}`);
      showLogs(`🔄 Guest details:`, existingGuest);

      try {
        showLogs(`🔄 Updating Firebase Auth user ${existingGuest.uid}...`);
        await auth.updateUser(existingGuest.uid, {
          email,
          password,
          displayName: name,
          emailVerified: false
        });
        showLogs(`✅ Firebase Auth user updated successfully`);

        showLogs(`🔄 Updating Firestore user document...`);
        await db.collection("users").doc(existingGuest.uid).set({
          displayName: name,
          isGuest: false
        }, { merge: true });
        showLogs(`✅ Firestore user document updated`);

        showLogs(`🔄 Updating local login data...`);
        updateUserLoginData(deviceId, ip, existingGuest.uid, email, password, false);
        showLogs(`✅ Local login data updated`);

        showLogs(`🎉 Guest account upgrade completed successfully for ${existingGuest.uid}`);
        return res.json({
          message: "Guest account upgraded successfully",
          userId: existingGuest.uid
        });
      } catch (updateErr) {
        showLogs(`❌ /auth/actual: Error upgrading guest account: ${updateErr.message}`, updateErr);
        showLogs(`❌ Upgrade error details:`, updateErr.code, updateErr.stack);
        return res.status(500).json({
          message: `Error upgrading guest account: ${updateErr.message}`,
          error: updateErr.code || updateErr.message
        });
      }
    }

    // ----------------- CASE 2: Login existing user by email -----------------
    showLogs("🔹 Checking for existing user by email...");
    try {
      const user = await auth.getUserByEmail(email);
      showLogs(`✅ Found existing user by email: ${user.uid}, displayName: ${user.displayName}`);
      showLogs(`🔄 Starting login process for existing user ${user.uid}...`);

      try {
        showLogs(`🔄 Updating user login data...`);
        updateUserLoginData(deviceId, ip, user.uid, email, password, false);
        showLogs(`✅ User login data updated`);

        if (user.displayName !== name) {
          showLogs(`🔄 Updating display name from '${user.displayName}' to '${name}'...`);
          await auth.updateUser(user.uid, { displayName: name });
          showLogs(`✅ Display name updated`);
        }

        showLogs(`🔄 Updating Firestore user document...`);
        await db.collection("users").doc(user.uid).set({
          displayName: name,
          isGuest: false
        }, { merge: true });
        showLogs(`✅ Firestore user document updated`);

        showLogs(`🔄 Updating ranking documents...`);
        const updatedAt = admin.firestore.FieldValue.serverTimestamp();
        const rankingDocs = ["leaderboardReels", "leaderboardMock", "leaderboardCombined"];

        for (const lb of rankingDocs) {
          showLogs(`🔄 Updating ranking document: ${lb}`);
          await db.collection("ranking").doc(lb).collection("users").doc(user.uid).set({
            displayName: name,
            updatedAt: updatedAt
          }, { merge: true });
          showLogs(`✅ Ranking document ${lb} updated`);
        }

        showLogs(`🔄 Updating Realtime Database...`);
        await rtDb.ref(`users/${user.uid}/`).update({ username: name });
        showLogs(`✅ Realtime Database updated`);

        showLogs(`🎉 Login successful and all data updated for user ${user.uid}`);
        return res.json({
          message: "Login successful and data updated",
          userId: user.uid
        });
      } catch (innerErr) {
        showLogs(`❌ /auth/actual: Error updating existing user ${user.uid}: ${innerErr.message}`, innerErr);
        showLogs(`❌ Update error details:`, innerErr.code, innerErr.stack);
        return res.status(500).json({
          message: `Error updating user data: ${innerErr.message}`,
          error: innerErr.code || innerErr.message
        });
      }
    } catch (error) {
      // ----------------- CASE 3: Brand-new user (no guest, no email) -----------------
      if (error.code === "auth/user-not-found") {
        showLogs(`🆕 No guest for device ${deviceId}, and no existing user for email ${email}. Creating new account...`);
        showLogs(`🆕 Creating brand new user with name: ${name}`);

        try {
          showLogs(`🔄 Creating Firebase Auth user...`);
          const userRecord = await auth.createUser({
            email,
            password,
            displayName: name
          });
          const userId = userRecord.uid;
          const creationTime = Date.now();
          showLogs(`✅ Firebase Auth user created: ${userId}`);

          showLogs(`🔄 Creating Firestore user document...`);
          await db.collection("users").doc(userId).set({
            displayName: name,
            TotalcorrectReels: 0,
            TotalwrongReels: 0,
            TotaltimeTakenReels: 0,
            TotalUnattemptedMocks: 0,
            TotalcorrectMocks: 0,
            TotalwrongMocks: 0,
            TotaltimeTakenMocks: 0,
            TotaltimeforCorrectMockQuestions: 0,
            TotaltimeforWrongMockQuestions: 0,
            TotaltimeforCorrectReelsQuestions: 0,
            TotaltimeforWrongReelsQuestions: 0,
            creationTime: creationTime,
            isGuest: false,
            tokens: 100,
            hp: 1000,
            xp: 100,
            level: 1,
            score: 0,
            streaks: 0,
            deviceId: deviceId, // bind device at creation
            ip: ip
          });
          showLogs(`✅ Firestore user document created`);

          showLogs(`🔄 Creating ranking documents...`);
          const updatedAt = admin.firestore.FieldValue.serverTimestamp();

          await db.collection("ranking").doc("leaderboardReels").collection("users").doc(userId).set({
            reelScore: 0,
            displayName: name,
            updatedAt: updatedAt,
            TimeAccuracy: 0,
            rankInReels: 0
          });
          showLogs(`✅ leaderboardReels document created`);

          await db.collection("ranking").doc("leaderboardMock").collection("users").doc(userId).set({
            MockScore: 0,
            displayName: name,
            updatedAt: updatedAt,
            TimeAccuracy: 0,
            rankInMocks: 0
          });
          showLogs(`✅ leaderboardMock document created`);

          await db.collection("ranking").doc("leaderboardCombined").collection("users").doc(userId).set({
            totalScore: 0,
            displayName: name,
            updatedAt: updatedAt,
            TimeAccuracy: 0,
            rankCombined: 0
          });
          showLogs(`✅ leaderboardCombined document created`);

          showLogs(`🔄 Creating Realtime Database entry...`);
          await rtDb.ref(`users/${userId}/`).set({ username: name });
          showLogs(`✅ Realtime Database entry created`);

          showLogs(`🔄 Updating local login data...`);
          updateUserLoginData(deviceId, ip, userId, email, password, false);
          showLogs(`✅ Local login data updated`);

          showLogs(`🎉 New user registration completed successfully: ${userId}`);
          return res.json({
            message: "User registered and data saved successfully!",
            userId: userId
          });
        } catch (createErr) {
          showLogs(`❌ /auth/actual: Error creating user: ${createErr.message}`, createErr);
          showLogs(`❌ Creation error details:`, createErr.code, createErr.stack);
          return res.status(500).json({
            message: `Error creating user: ${createErr.message}`,
            error: createErr.code || createErr.message
          });
        }
      } else {
        showLogs(`❌ /auth/actual: Login failed: ${error.message}`, error);
        showLogs(`❌ Login error details:`, error.code, error.stack);
        return res.status(500).json({
          message: `Login failed: ${error.message}`,
          error: error.code || error.message
        });
      }
    }
  } catch (unexpectedErr) {
    showLogs(`❌ /auth/actual: Unexpected error: ${unexpectedErr.message}`, unexpectedErr);
    showLogs(`❌ Unexpected error details:`, unexpectedErr.code, unexpectedErr.stack);
    return res.status(500).json({
      message: `Unexpected error: ${unexpectedErr.message}`,
      error: unexpectedErr.code || unexpectedErr.message
    });
  }
});

router.post("/guest", async (req, res) => {
  showLogs("🔹 Received /guest-auth request.");
  showLogs("🔹 Request body:", JSON.stringify(req.body, null, 2));
  showLogs("🔹 Request IP:", req.ip || req.connection.remoteAddress);

  const { type, deviceId, name } = req.body;
  const ip = req.ip || req.connection.remoteAddress;
  const UserFrontEndname = name;
  
  showLogs(`🔹 Processing guest auth - Type: ${type}, Device: ${deviceId}, Name: ${UserFrontEndname}, IP: ${ip}`);

  if (!type || !deviceId) {
    showLogs("⚠️ /guest-auth: Validation Error: Missing Type or Device ID.");
    showLogs("⚠️ Received fields:", { type: !!type, deviceId: !!deviceId, name: !!name });
    return res.status(400).json({ 
      success: false, 
      message: "Type and Device ID cannot be empty" 
    });
  }

  try {
    // Check if user already exists - ADD AWAIT HERE
    showLogs("🔹 Checking for existing guest user...");
    let existingUser;
    try {
      existingUser = await findExistingGuestUser(deviceId, ip); // ADDED AWAIT
      showLogs(`🔹 Existing guest check result:`, existingUser ? `Found: ${existingUser.uid}` : "No existing guest found");
    } catch (err) {
      showLogs("❌ Error checking existing guest user:", err.message);
      showLogs("❌ Check error details:", err.stack);
    }

    if (existingUser && existingUser.uid) { // ADDED uid CHECK
      showLogs(`✅ Returning existing guest user for device ${deviceId}`);
      showLogs(`✅ Existing user details:`, existingUser);
      return res.json({
        success: true,
        message: "Existing guest user",
        userId: existingUser.uid,
        email: existingUser.email || "guestUserId",
        password: existingUser.password || "guestUUID",
      });
    }

    // Rest of the guest creation code remains the same...
    showLogs(`🆕 No existing guest found, creating new guest user...`);
    const randomNumber = Math.floor(Math.random() * 100000000);
    const guestName = UserFrontEndname || `guest_${randomNumber}`;
    const email = `guest_${randomNumber}@example.com`;
    const password = `guestpass${randomNumber}`;
    
    showLogs(`🆕 Generated guest credentials - Name: ${guestName}, Email: ${email}`);

    let userRecord;
    try {
      showLogs(`🔄 Creating Firebase Auth user...`);
      userRecord = await auth.createUser({ 
        email, 
        password, 
        displayName: guestName 
      });
      showLogs(`✅ Firebase Auth user created successfully: ${userRecord.uid}`);
    } catch (err) {
      showLogs("❌ /guest-auth: Error creating Firebase user:", err.message);
      showLogs("❌ Firebase Auth error details:", err.code, err.stack);
      return res.status(500).json({ 
        success: false,
        message: "Error creating Firebase user", 
        error: err.message, 
        code: err?.errorInfo?.code || "auth/unknown-error" 
      });
    }

    const userId = userRecord.uid;
    const creationTime = Date.now();
    showLogs(`🆕 New guest user ID: ${userId}, Creation time: ${creationTime}`);

    // Firestore user data
    try {
      showLogs(`🔄 Creating Firestore user document...`);
      await db.collection("users").doc(userId).set({
        displayName: guestName,
        TotalcorrectReels: 0,
        TotalwrongReels: 0,
        TotaltimeTakenReels: 0,
        TotalUnattemptedMocks: 0,
        TotalcorrectMocks: 0,
        TotalwrongMocks: 0,
        TotaltimeTakenMocks: 0,
        TotaltimeforCorrectMockQuestions: 0,
        TotaltimeforWrongMockQuestions: 0,
        TotaltimeforCorrectReelsQuestions: 0,
        TotaltimeforWrongReelsQuestions: 0,
        creationTime,
        isGuest: true,
        tokens: 100,
        hp: 1000,
        xp: 100,
        level: 1,
        score: 0,
        streaks: 0,
        deviceId: deviceId,
  ip: ip,
      });
      showLogs(`✅ Firestore user document created successfully`);
    } catch (err) {
      showLogs("❌ Error writing Firestore user:", err.message);
      showLogs("❌ Firestore error details:", err.stack);
    }

    // Ranking docs
    showLogs(`🔄 Creating ranking documents...`);
    const updatedAt = admin.firestore.FieldValue.serverTimestamp();
    try {
      await db.collection("ranking").doc("leaderboardReels").collection("users").doc(userId).set({
        reelScore: 0,
        displayName: guestName,
        updatedAt,
        TimeAccuracy: 0,
        rankInReels: 0,
      });
      showLogs(`✅ leaderboardReels document created`);
    } catch (err) {
      showLogs("❌ Error writing leaderboardReels:", err.message);
      showLogs("❌ Leaderboard error details:", err.stack);
    }

    try {
      await db.collection("ranking").doc("leaderboardMock").collection("users").doc(userId).set({
        MockScore: 0,
        displayName: guestName,
        updatedAt,
        TimeAccuracy: 0,
        rankInMocks: 0,
      });
      showLogs(`✅ leaderboardMock document created`);
    } catch (err) {
      showLogs("❌ Error writing leaderboardMock:", err.message);
      showLogs("❌ Leaderboard error details:", err.stack);
    }

    try {
      await db.collection("ranking").doc("leaderboardCombined").collection("users").doc(userId).set({
        totalScore: 0,
        displayName: guestName,
        updatedAt,
        TimeAccuracy: 0,
        rankCombined: 0,
      });
      showLogs(`✅ leaderboardCombined document created`);
    } catch (err) {
      showLogs("❌ Error writing leaderboardCombined:", err.message);
      showLogs("❌ Leaderboard error details:", err.stack);
    }

    // RTDB user
    try {
      showLogs(`🔄 Creating Realtime Database entry...`);
      await rtDb.ref(`users/${userId}/`).set({ username: guestName });
      showLogs(`✅ Realtime Database entry created`);
    } catch (err) {
      showLogs("❌ Error writing to RTDB:", err.message);
      showLogs("❌ RTDB error details:", err.stack);
    }

   try {
      showLogs(`🔄 Updating local user login data...`);
      await updateUserLoginData(deviceId, ip, userId, email, password, true); // ADDED AWAIT
      showLogs(`✅ Local user login data updated`);
    } catch (err) {
      showLogs("❌ Error updating local userLoginData:", err.message);
      showLogs("❌ Local data error details:", err.stack);
    }

    showLogs(`🎉 Guest user creation completed successfully: ${userId}`);
    return res.json({
      success: true,
      message: "User registered and data saved successfully!",
      userId,
      email,
      password,
    });

  } catch (err) {
    showLogs("❌ /guest-auth: Unhandled Error:", err.message);
    showLogs("❌ Unhandled error details:", err.stack);
    return res.status(500).json({ 
      success: false, 
      message: "Unexpected server error", 
      error: err.message 
    });
  }
});

showLogs("🔹 Auth routes initialized successfully");
export default router;