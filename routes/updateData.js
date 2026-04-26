import express from "express";
import { showLogs } from "../lib/logs.js";
import {
  filterQuestionsAndRecord,
  saveDeletedUserData,
  getUserByDevice,
  findExistingGuestUser,
  getQuestionsFromDatabase,
  updateUserLoginData,
} from "../res/local_file_functions.js";
import { db, auth, admin, rtDb } from "../lib/firebase.js";
const router = express.Router();

/* Middleware: Ensure not guest */
async function ensureNotGuest(req, res, next) {
  try {
    showLogs("[ensureNotGuest] 🚀 Starting check...");

    const uid =
      req.uid ||
      (req.user && req.user.uid) ||
      (req.query && req.query.uid) ||
      (req.body && req.body.uid);

    if (!uid) {
      showLogs("[ensureNotGuest] ❌ Missing UID");
      return res.status(400).json({ error: "UID missing" });
    }

    const userDocRef = db.collection("users").doc(uid);
    const snap = await userDocRef.get();

    if (!snap.exists) {
      showLogs(`[ensureNotGuest] ⚠️ No Firestore doc found for ${uid}`);
      req.userDoc = null;
      req.user = { uid }; // Always set req.user
      return next();
    }

    const data = snap.data();
    req.userDoc = data;
    req.user = { uid, ...data }; // Always attach uid

    if (data.isGuest || data.guest) {
      showLogs(`[ensureNotGuest] ❌ Guest account detected: ${uid}`);
      return res.status(403).json({
        success: false,
        error: "Guest accounts cannot change profile. Please complete account registration.",
      });
    }

    showLogs(`[ensureNotGuest] ✅ User passed check: ${uid}`);
    return next();
  } catch (err) {
    console.error("Guest-check failed", err);
    showLogs("❌ Guest-check failed:", err.message);
    return res.status(500).json({
      success: false,
      error: "Server failure during guest check",
    });
  }
}

/* === ROUTES === */

/* Update username */
router.post("/update-username", ensureNotGuest, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { newUsername } = req.body;

    showLogs(`[update-username] 🔔 Request received for ${uid}`);

    if (!newUsername || typeof newUsername !== "string") {
      showLogs(`[update-username] ❌ Invalid newUsername: ${newUsername}`);
      return res.status(400).json({ success: false, error: "Invalid newUsername" });
    }

    // Update Auth displayName
    await admin.auth().updateUser(uid, { displayName: newUsername });
    showLogs(`[update-username] ✅ Updated Auth displayName for ${uid}`);

    // Update Firestore
    const userRef = db.collection("users").doc(uid);
    await userRef.set({ displayName: newUsername }, { merge: true });
    showLogs(`[update-username] ✅ Updated Firestore for ${uid}`);

    // Update RTDB
    try {
      await rtDb.ref(`users/${uid}/`).set({ username: newUsername });
      showLogs(`[update-username] ✅ Updated RTDB for ${uid}`);
    } catch (err) {
      showLogs("[update-username] ❌ RTDB write failed:", err.message);
    }

    return res.json({ success: true, message: "Username updated" });
  } catch (err) {
    console.error("update-username error", err);
    showLogs("❌ update-username error:", err.message);
    return res.status(500).json({ success: false, error: "Failed to update username" });
  }
});

/* Update email */
router.post("/update-email", ensureNotGuest, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { newEmail } = req.body;

    showLogs(`[update-email] 🔔 Request received for ${uid}`);

    if (!newEmail || typeof newEmail !== "string") {
      showLogs(`[update-email] ❌ Invalid newEmail: ${newEmail}`);
      return res.status(400).json({ success: false, error: "Invalid newEmail" });
    }

    // Update Auth email
    await admin.auth().updateUser(uid, { email: newEmail });
    showLogs(`[update-email] ✅ Updated Auth email for ${uid}`);

    // Update Firestore
    const userRef = db.collection("users").doc(uid);
    await userRef.set({ email: newEmail }, { merge: true });
    showLogs(`[update-email] ✅ Updated Firestore for ${uid}`);

    return res.json({ success: true, message: "Email updated" });
  } catch (err) {
    console.error("update-email error", err);
    showLogs("❌ update-email error:", err.message);

    const code = err.code || "";
    if (code === "auth/email-already-exists") {
      showLogs(`[update-email] ⚠️ Email already in use for ${req.user.uid}`);
      return res.status(409).json({ success: false, error: "Email already in use" });
    }
    return res.status(500).json({ success: false, error: "Failed to update email" });
  }
});

/* Update password */
router.post("/update-password", ensureNotGuest, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { newPassword } = req.body;

    showLogs(`[update-password] 🔔 Request received for ${uid}`);

    if (!newPassword || typeof newPassword !== "string" || newPassword.length < 6) {
      showLogs(`[update-password] ❌ Invalid newPassword length`);
      return res.status(400).json({
        success: false,
        error: "Invalid new password (min 6 chars)",
      });
    }

    await admin.auth().updateUser(uid, { password: newPassword });
    showLogs(`[update-password] ✅ Password updated for ${uid}`);

    return res.json({ success: true, message: "Password updated" });
  } catch (err) {
    console.error("update-password error", err);
    showLogs("❌ update-password error:", err.message);
    return res.status(500).json({ success: false, error: "Failed to update password" });
  }
});



router.delete('/delete-account', ensureNotGuest, async (req, res) => {
    const uid = req.uid;
    try {
        showLogs(`[delete-account] 🔔 Starting deletion process for UID: ${uid}`);

        // 1. Save user data snapshot before deletion
        await saveDeletedUserData(uid);
        showLogs(`[delete-account] ✅ User data saved successfully for UID: ${uid}`);

        // 2. Delete user data from all collections
        await deleteUserDataFromAllCollections(uid);
        showLogs(`[delete-account] ✅ User data deleted from all collections for UID: ${uid}`);

        // 3. Delete user from Firebase Auth
        await auth.deleteUser(uid);
        showLogs(`[delete-account] ✅ User deleted from Firebase Auth for UID: ${uid}`);

        // 5. Send success response
        res.json({ success: true, message: "Account deleted successfully" });
    } catch (error) {
        showLogs(`[delete-account] ❌ Error during deletion process for UID: ${uid}`, error.message);
        res.status(500).json({ success: false, error: "Failed to delete account. Data not removed." });
    }
});


// Helper function to delete user data from all collections
async function deleteUserDataFromAllCollections(uid) {
    try {
        showLogs(`[deleteUserDataFromAllCollections] 🔔 Starting deletion for UID: ${uid}`);

        // 1. Delete from users collection
        try {
            await db.collection("users").doc(uid).delete();
            showLogs("✔ Deleted from 'users' collection");
        } catch (error) {
            console.error("❌ Error deleting from 'users' collection:", error.message);
        }

        // 2. Delete from ranking collections
        const leaderboards = ['leaderboardReels', 'leaderboardMock', 'leaderboardCombined', 'bubbleGame'];
        for (const lb of leaderboards) {
            try {
                await db.collection("ranking").doc(lb).collection("users").doc(uid).delete();
                showLogs(`✔ Deleted from 'ranking/${lb}/users'`);
            } catch (error) {
                console.error(`❌ Error deleting from 'ranking/${lb}/users':`, error.message);
            }
        }

        // 3. Delete from mocks responses
        try {
            const mocksSnapshot = await db.collection("mocks").get();
            for (const mockDoc of mocksSnapshot.docs) {
                try {
                    await mockDoc.ref.collection("Responses").doc(uid).delete();
                    showLogs(`✔ Deleted mock response for '${mockDoc.id}'`);
                } catch (error) {
                    console.error(`❌ Error deleting mock response for '${mockDoc.id}':`, error.message);
                }
            }
        } catch (error) {
            console.error("❌ Error retrieving mocks collection:", error.message);
        }

        // 4. Delete from PYQs responses
        try {
            const pyqsSnapshot = await db.collection("PYQs").get();
            for (const pyqDoc of pyqsSnapshot.docs) {
                try {
                    await pyqDoc.ref.collection("Responses").doc(uid).delete();
                    showLogs(`✔ Deleted PYQ response for '${pyqDoc.id}'`);
                } catch (error) {
                    console.error(`❌ Error deleting PYQ response for '${pyqDoc.id}':`, error.message);
                }
            }
        } catch (error) {
            console.error("❌ Error retrieving PYQs collection:", error.message);
        }

        // 5. Delete user's subcollections
        const userRef = db.collection("users").doc(uid);
        const collections = ['mockAttempts', 'incorrect_responses', 'analysis', 'reelsAttempts'];
        for (const coll of collections) {
            try {
                const snapshot = await userRef.collection(coll).get();
                const batch = db.batch();
                snapshot.docs.forEach(doc => batch.delete(doc.ref));
                await batch.commit();
                showLogs(`✔ Deleted documents from '${coll}'`);
            } catch (error) {
                console.error(`❌ Error deleting documents from '${coll}':`, error.message);
            }
        }

        // 6. Delete from Realtime Database
        try {
            await rtDb.ref(`users/${uid}`).remove();
            showLogs("✔ Deleted from Realtime Database");
        } catch (error) {
            console.error("❌ Error deleting from Realtime Database:", error.message);
        }

        showLogs(`[deleteUserDataFromAllCollections] ✅ Completed deletion for UID: ${uid}`);
    } catch (error) {
        console.error(`[deleteUserDataFromAllCollections] ❌ Unexpected error for UID: ${uid}`, error.message);
        throw error;
    }
}







export default router;
