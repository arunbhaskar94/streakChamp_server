import express from "express";
import fsSync from 'fs';
import path from 'path';
import { showLogs } from '../lib/logs.js';
import CryptoJS from 'crypto-js';
import { safeReadJSON, safeWriteJSON } from '../lib/fileStore.js';
import { db, auth, rtDb, admin } from '../lib/firebase.js';
import {getQuestionsFromDatabase } from '../res/local_file_functions.js';
import { PYQs_data } from '../server.js'
const router = express.Router();

const timestampToMs = (timestamp) => {
  if (timestamp instanceof admin.firestore.Timestamp) {
    return timestamp.toMillis();
  }
  return timestamp; // Return as is if not a Timestamp object
};

router.get('/PYQs', async (req, res) => {
  showLogs('📥 GET /PYQs called.');
  if (!PYQs_data || Object.keys(PYQs_data).length === 0) {
    showLogs('❌ PYQs data not loaded yet. Returning 503.');
    return res.status(503).json({ error: 'PYQs not loaded yet. Try again shortly.' });
  }
  try {
    // Load PYQs data from your PYQs_data.json file
    const PYQsData = Object.keys(PYQs_data).map(PYQId => ({
      id: PYQId,
      title: PYQs_data[PYQId].title,
      description: PYQs_data[PYQId].description,
      totalQuestions: PYQs_data[PYQId].totalQuestions,
      time: PYQs_data[PYQId].time,
      passingPercentage: PYQs_data[PYQId].passingPercentage,
      testAddedDate: PYQs_data[PYQId].testAddedDate,
      instructions: PYQs_data[PYQId].instructions
    }));

    showLogs(`✅ Fetched ${PYQsData.length} PYQs from PYQs_data.json.`);
    res.json(PYQsData);
  } catch (error) {
    showLogs("❌ Error fetching PYQs:", error.message);
    res.status(500).json({ error: `Failed to retrieve PYQs: ${error.message}` });
  }
});

router.get("/PYQs/:PYQ_id/questions", async (req, res) => {
  const PYQId = req.params.PYQ_id;
  const whatClicked = req.query.whatClicked; // e.g. "startTest" / "resumeTest" / "reviewTest"
  const uid = req.query.uid; // the user's UID sent from the client
  showLogs(`📥 GET /PYQs/${PYQId}/questions called with whatClicked: ${whatClicked} and uid: ${uid}.`);

  try {
    if (!uid) {
      showLogs("❌ No UID provided. Returning 400.");
      return res.status(400).json({ error: "No UID provided" });
    }
    if (!whatClicked) {
      showLogs("❌ No whatClicked parameter provided. Returning 400.");
      return res.status(400).json({ error: "No whatClicked parameter provided" });
    }

    // --- FIX: Check for existing response FIRST ---
    showLogs(`⏳ Checking for existing response for user ${uid} on PYQ ${PYQId}.`);
    const responseRef = db.collection("PYQs").doc(PYQId).collection("Responses").doc(uid);
    const responseSnap = await responseRef.get();
    const hasExistingResponse = responseSnap.exists;

    // --- 1) If starting a test, check/deduct tokens ONLY if no existing response ---
    if (whatClicked === "startTest" && !hasExistingResponse) {
      const userDocRef = db.collection("users").doc(uid);
      const userSnap = await userDocRef.get();
      
      if (!userSnap.exists) {
        showLogs(`❌ User ${uid} not found. Returning 404.`);
        return res.status(404).json({ error: "User not found" });
      }
      
      const userData = userSnap.data();
      const tokens = typeof userData.tokens === "number" ? userData.tokens : 0;
      showLogs(`ℹ️ User ${uid} has ${tokens} tokens.`);

      if (tokens < 20) {
        showLogs(`❌ Insufficient tokens for user ${uid}. Returning 402.`);
        return res.status(402).json({ error: "Insufficient tokens. Earn more to start the test." });
      }

      // Deduct 20 tokens and update Firestore
      const newTokenCount = tokens - 20;
      await userDocRef.set({ tokens: newTokenCount }, { merge: true });
      showLogs(`✅ Deducted 20 tokens from ${uid}. Remaining = ${newTokenCount}`);
    } else if (whatClicked === "startTest" && hasExistingResponse) {
      showLogs(`ℹ️ User ${uid} already has a response for PYQ ${PYQId}. Skipping token deduction.`);
    }

    // --- 2) Fetch questions from PYQs_data.json ---
    const PYQ = PYQs_data[PYQId];
    if (!PYQ) {
      showLogs(`❌ PYQ ${PYQId} not found. Returning 404.`);
      return res.status(404).json({ error: "PYQ not found" });
    }

    // Format the questions for the response
    const formattedQuestions = PYQ.questions.map(q => ({
      id: q.id,
      imageUrl: q.imageUrl,
      correctAnswer: q.correctAnswer
    }));

    showLogs(`✅ Questions fetched for PYQ ${PYQId}. Returning ${formattedQuestions.length} questions.`);
    return res.json({ questions: formattedQuestions });
  } catch (err) {
    showLogs(`❌ GET /PYQs/${req.params.PYQ_id}/questions →`, err);
    return res.status(500).json({ error: `Server error: ${err.message}` });
  }
});

router.get('/PYQs/:PYQ_id/responses/:user_id', async (req, res) => {
  const { PYQ_id, user_id } = req.params;
  showLogs(`📥 GET /PYQs/${PYQ_id}/responses/${user_id} called.`);
  try {
    const docRef = db.collection("PYQs").doc(PYQ_id).collection("Responses").doc(user_id);
    const docSnap = await docRef.get();
    
    if (docSnap.exists) {
      const data = docSnap.data();
      // Convert any Firestore Timestamps to milliseconds
      if (data.updatedAt) {
        data.updatedAt = timestampToMs(data.updatedAt);
      }
      if (data.submittedAt) {
        data.submittedAt = timestampToMs(data.submittedAt);
      }
      showLogs(`✅ User responses fetched for user ${user_id} on PYQ ${PYQ_id}.`);
      res.json(data);
    } else {
      showLogs(`⚠️ User responses not found for user ${user_id} on PYQ ${PYQ_id}. Returning 404.`);
      res.status(404).json({ error: "User responses not found" });
    }
  } catch (error) {
    showLogs(`❌ Error fetching user responses for ${user_id} on PYQ ${PYQ_id}:`, error);
    res.status(500).json({ error: `Failed to retrieve user responses: ${error.message}` });
  }
});

router.post('/PYQs-attempts', async (req, res) => {
  const userId = req.uid;
  showLogs(`📥 POST /PYQs-attempts called for user ${userId}.`);

  try {
    const PYQAttemptsRef = db.collection('users').doc(userId).collection('PYQAttempts');
    const snapshot = await PYQAttemptsRef.get();
    showLogs(`⏳ Fetching all PYQ attempts for user ${userId}.`);

    const PYQAttemptsList = [];
    snapshot.forEach(doc => {
      const PYQData = doc.data();
      PYQAttemptsList.push({
        id: doc.id,
        Totalcorrect: PYQData['Total correct'] || 0,
        Totalwrong: PYQData['Total wrong'] || 0,
        TotaltimeTaken: PYQData['Total time taken'] || 0,
        Totalunattempted: PYQData['Total unattempted'] || 0,
        attempteddate: PYQData['attempted date'] || 'N/A'
      });
    });

    // Sort by attempteddate
    PYQAttemptsList.sort((a, b) => {
      const dateA = new Date(a.attempteddate);
      const dateB = new Date(b.attempteddate);
      return dateA - dateB;
    });

    showLogs(`✅ Successfully fetched ${PYQAttemptsList.length} PYQ attempts for user ${userId}.`);
    return res.status(200).json(PYQAttemptsList);
  } catch (error) {
    showLogs("❌ Error fetching PYQ attempts:", error);
    return res.status(500).json({ message: `Internal server error: ${error.message}` });
  }
});

router.post('/PYQs/:PYQ_id/responses/:user_id/progress', async (req, res) => {
  const { PYQ_id, user_id } = req.params;
  showLogs(`📥 POST /PYQs/${PYQ_id}/responses/${user_id}/progress called.`);
  try {
    const data = req.body;
    
    if (!data) {
      showLogs("⚠️ Progress save: Request body is empty. Returning 400.");
      return res.status(400).json({ error: "Request body must be JSON" });
    }

    const docRef = db.collection("PYQs").doc(PYQ_id).collection("Responses").doc(user_id);

    // Use server timestamp for accuracy
    data.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    await docRef.set(data, { merge: true });
    showLogs(`✅ Progress saved successfully for user ${user_id} on PYQ ${PYQ_id}.`);
    res.json({ message: "Progress saved successfully" });
  } catch (error) {
    showLogs(`❌ Error saving progress for user ${user_id} on PYQ ${PYQ_id}:`, error);
    res.status(500).json({ error: `Failed to save progress: ${error.message}` });
  }
});

router.post('/PYQs/:PYQ_id/responses/:user_id/submit', async (req, res) => {
  const rawPYQId = req.params.PYQ_id;
  const rawUserId = req.params.user_id;
  const data = req.body || {};
  showLogs(`📥 POST /PYQs/${rawPYQId}/responses/${rawUserId}/submit called.`);

  // Basic logging for debugging
  showLogs(`[submit] called - PYQ_id: ${rawPYQId} | user_id: ${rawUserId}`);
  showLogs(`[submit] incoming body keys: ${Object.keys(data).join(', ')}`);

  // sanitize / validate route params
  const sanitizeId = (id) => {
    if (id === undefined || id === null) return '';
    // trim & coerce to string
    const s = String(id).trim();
    // replace any slashes to avoid nested collection problems
    return s.replace(/\//g, '_');
  };

  const PYQ_id = sanitizeId(rawPYQId);
  const user_id = sanitizeId(rawUserId);

  if (!PYQ_id) {
    showLogs('❌ submit: invalid PYQ_id. Returning 400.');
    return res.status(400).json({ error: 'Invalid PYQ_id' });
  }
  if (!user_id) {
    showLogs('❌ submit: invalid user_id. Returning 400.');
    return res.status(400).json({ error: 'Invalid user_id' });
  }

  if (!data || typeof data !== 'object') {
    showLogs("⚠️ Test submission: Request body is empty or not an object. Returning 400.");
    return res.status(400).json({ error: "Request body must be JSON" });
  }

  try {
    // Save the response document (safe references)
    const userResponseDocRef = db.collection("PYQs").doc(PYQ_id).collection("Responses").doc(user_id);
    showLogs(`⏳ Saving user response to Firestore for user ${user_id} on PYQ ${PYQ_id}.`);

    await userResponseDocRef.set({
      totalTimeTaken: data.totalTimeTaken || 0,
      totalQuestions: data.totalQuestions || 0,
      totalAttempted: data.totalAttempted || 0,
      totalCorrect: data.totalCorrect || 0,
      isTestSubmitted: true,
      isPaused: false,
      submittedAt: admin.firestore.FieldValue.serverTimestamp(),
      currentTimerProgress: data.currentTimerProgress || 0,
      name: data.name || ''
    }, { merge: true });
    showLogs(`✅ Response saved for user ${user_id} on PYQ ${PYQ_id}.`);

    // Save incorrect questions if any
    const userIncorrectDocRef = db.collection("users").doc(user_id).collection("incorrect_responses").doc(PYQ_id);
    const incorrectData = data.incorrectQuestionsData || {};
    showLogs(`⏳ Checking for incorrect questions to save.`);
    
    if (Object.keys(incorrectData).length) {
      await userIncorrectDocRef.set(incorrectData, { merge: true });
      showLogs(`✅ Incorrect questions saved for ${user_id}`);
    } else {
      // if there is no incorrect data, remove existing doc to keep DB clean
      await userIncorrectDocRef.delete();
      showLogs(`✅ No incorrect questions—deleted doc (if existed).`);
    }

    // Update user stats and leaderboards (transaction)
    showLogs("⏳ Starting Firestore transaction to update user stats and leaderboards.");
    await db.runTransaction(async (transaction) => {
      const userRef = db.collection("users").doc(user_id);
      const PYQRef = db.collection("PYQs").doc(PYQ_id);
      const attemptRef = userRef.collection("PYQAttempts").doc(PYQ_id);
      
      const leaderboardPYQRef = db.collection("ranking").doc("leaderboardPYQ").collection("users").doc(user_id);
      const leaderboardCombinedRef = db.collection("ranking").doc("leaderboardCombined").collection("users").doc(user_id);

      // Read existing data snapshots
      const [userSnap, PYQSnap, currentLeaderboardPYQSnap, currentLeaderboardCombinedSnap] = await Promise.all([
        transaction.get(userRef),
        transaction.get(PYQRef),
        transaction.get(leaderboardPYQRef),
        transaction.get(leaderboardCombinedRef)
      ]);
      
      const userData = userSnap.exists ? userSnap.data() : {};
      const existingAttemptSnap = await transaction.get(attemptRef);
      const wasPreviouslySub = existingAttemptSnap.exists;
      showLogs(`ℹ️ Transaction: user ${user_id} has submitted this PYQ before? ${wasPreviouslySub}`);

      // If first submission of this PYQ, update cumulative stats (use set merge to be safe)
      if (!wasPreviouslySub) {
        showLogs('⏳ Transaction: First submission. Updating cumulative user stats.');
        const updateObj = {
          TotalcorrectPYQs: (userData.TotalcorrectPYQs || 0) + (data.totalCorrect || 0),
          TotalwrongPYQs: (userData.TotalwrongPYQs || 0) + ((data.totalAttempted || 0) - (data.totalCorrect || 0)),
          TotaltimeTakenPYQs: (userData.TotaltimeTakenPYQs || 0) + (data.totalTimeTaken || 0),
          TotalUnattemptedPYQs: (userData.TotalUnattemptedPYQs || 0) + ((data.totalQuestions || 0) - (data.totalAttempted || 0)),
          TotaltimeforCorrectPYQQuestions: (userData.TotaltimeforCorrectPYQQuestions || 0) + (data.timeTakenForCorrectPYQQuestions || 0),
          TotaltimeforWrongPYQQuestions: (userData.TotaltimeforWrongPYQQuestions || 0) + (data.timeTakenForWrongPYQQuestions || 0)
        };
        transaction.set(userRef, updateObj, { merge: true });
      }

      // Save PYQ attempt summary
      showLogs('⏳ Transaction: Saving PYQ attempt summary.');
      const today = new Date().toISOString().slice(0, 10);
      transaction.set(attemptRef, {
        "Total correct": data.totalCorrect || 0,
        "Total wrong": (data.totalAttempted || 0) - (data.totalCorrect || 0),
        "Total time taken": data.totalTimeTaken || 0,
        "Total unattempted": (data.totalQuestions || 0) - (data.totalAttempted || 0),
        "attempted date": today,
        submittedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      // Save individual questions - defensive
      showLogs('⏳ Transaction: Saving individual question data.');
      const attemptedQuestions = Array.isArray(data.attemptedQuestions) ? data.attemptedQuestions : [];
      for (const q of attemptedQuestions) {
        try {
          const rawId = q && q.firestoreDocId;
          const validId = (typeof rawId === 'string' && rawId.trim().length > 0) ? rawId.trim() : undefined;
          // create a question doc ref; if validId is undefined use auto-id
          const questionsColRef = attemptRef.collection('questions');
          const qRef = validId ? questionsColRef.doc(validId) : questionsColRef.doc();
          
          transaction.set(qRef, {
            isAttempted: true,
            wasCorrect: !!q.wasCorrect,
            chosenOption: q.chosenOption ?? null,
            timeTakenSec: q.timeTakenSec ?? 0,
            attemptedAt: admin.firestore.FieldValue.serverTimestamp(),
            subject: q.subject || '',
            chapter: q.chapter || '',
            questionID: q.questionID || null
          }, { merge: true });
        } catch (qErr) {
          showLogs(`⚠️ Skipping question record due to error for user ${user_id} on PYQ ${PYQ_id}: ${qErr && qErr.message ? qErr.message : qErr}`);
          // continue to next question
        }
      }

      // Leaderboard calculations (same as before) - kept defensive for numeric fields
      showLogs('⏳ Transaction: Updating leaderboard scores.');
      const PYQScore = (data.totalAttempted || 0) > 0 ? ((data.totalCorrect || 0) / (data.totalAttempted || 0)) : 0;
      const totalTimeAttemptedForPYQ = (data.timeTakenForCorrectPYQQuestions || 0) + (data.timeTakenForWrongPYQQuestions || 0);
      const PYQTimeAccuracy = totalTimeAttemptedForPYQ > 0 ? (data.timeTakenForCorrectPYQQuestions || 0) / totalTimeAttemptedForPYQ : 0;

      transaction.set(leaderboardPYQRef, {
        PYQScore: parseFloat(PYQScore.toFixed(2)),
        displayName: data.name || '',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        TimeAccuracy: parseFloat(PYQTimeAccuracy.toFixed(2)),
      }, { merge: true });

      // Combined leaderboard
      const totalCorrectReels = userData.TotalcorrectReels || 0;
      const totalWrongReels = userData.TotalwrongReels || 0;
      const timeTakenForCorrectReelQuestions = userData.TotaltimeforCorrectReelsQuestions || 0;
      const timeTakenForWrongReelQuestions = userData.TotaltimeforWrongReelsQuestions || 0;

      const totalCorrectCombined = (userData.TotalcorrectPYQs || 0) + totalCorrectReels;
      const totalAttemptedCombined = (userData.TotalcorrectPYQs || 0) + (userData.TotalwrongPYQs || 0) +
                                     totalCorrectReels + totalWrongReels;

      const totalTimeTakenCorrectCombined = (userData.TotaltimeforCorrectPYQQuestions || 0) + timeTakenForCorrectReelQuestions;
      const totalTimeTakenAttemptedCombined = (userData.TotaltimeforCorrectPYQQuestions || 0) + (userData.TotaltimeforWrongPYQQuestions || 0) +
                                               timeTakenForCorrectReelQuestions + timeTakenForWrongReelQuestions;

      const combinedScore = totalAttemptedCombined > 0 ? (totalCorrectCombined / totalAttemptedCombined) : 0;
      const combinedTimeAccuracy = totalTimeTakenAttemptedCombined > 0 ? (totalTimeTakenCorrectCombined / totalTimeTakenAttemptedCombined) : 0;

      transaction.set(leaderboardCombinedRef, {
        totalScore: parseFloat(combinedScore.toFixed(2)),
        displayName: data.name || '',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        TimeAccuracy: parseFloat(combinedTimeAccuracy.toFixed(2)),
      }, { merge: true });
      showLogs("✅ Transaction committed successfully.");
    }); // end transaction

    return res.json({ message: "Test submitted successfully" });

  } catch (error) {
    showLogs(`❌ Error submitting test for user ${user_id} on PYQ ${PYQ_id}:`);
    showLogs(error);
    return res.status(500).json({ error: `Failed to submit test: ${error.message}` });
  }
});

router.delete('/PYQs/:PYQ_id/responses/:user_id', async (req, res) => {
  const { PYQ_id, user_id } = req.params;
  showLogs(`📥 DELETE /PYQs/${PYQ_id}/responses/${user_id} called.`);
  try {
    const userResponseDocRef = db.collection("PYQs").doc(PYQ_id).collection("Responses").doc(user_id);
    const userIncorrectDocRef = db.collection("users").doc(user_id).collection("incorrect_responses").doc(PYQ_id);
    const userPYQAttemptDocRef = db.collection('users').doc(user_id).collection('PYQAttempts').doc(PYQ_id);

    showLogs(`⏳ Deleting user response document for user ${user_id} on PYQ ${PYQ_id}.`);
    await userResponseDocRef.delete();
    showLogs(`✅ User response document deleted for user ${user_id} on PYQ ${PYQ_id}.`);
    
    showLogs(`⏳ Deleting user incorrect responses document for user ${user_id} on PYQ ${PYQ_id}.`);
    await userIncorrectDocRef.delete();
    showLogs(`✅ User incorrect responses document deleted for user ${user_id} on PYQ ${PYQ_id}.`);

    showLogs(`⏳ Deleting user PYQ attempt data for user ${user_id} on PYQ ${PYQ_id}.`);
    // Delete the PYQ attempt subcollection
    const questionsSnapshot = await userPYQAttemptDocRef.collection('questions').get();
    const batch = db.batch();
    questionsSnapshot.forEach(doc => {
      batch.delete(doc.ref);
    });
    await batch.commit();

    await userPYQAttemptDocRef.delete();
    showLogs(`✅ User PYQ attempt data deleted for user ${user_id} on PYQ ${PYQ_id}.`);

    res.json({ message: "Previous responses deleted successfully" });
  } catch (error) {
    showLogs(`❌ Error deleting responses for user ${user_id} on PYQ ${PYQ_id}:`, error);
    res.status(500).json({ error: `Failed to delete previous responses: ${error.message}` });
  }
});


router.get('/pyq-toppers/:pyqId', async (req, res) => {
  const pyqId = req.params.pyqId;
  showLogs(`📥 GET /pyq-toppers/${pyqId} called.`);
  if (!pyqId) {
    showLogs('❌ PYQ ID is required. Returning 400.');
    return res.status(400).json({ error: 'PYQ ID is required.' });
  }

  try {
    const responsesRef = db.collection('PYQs').doc(pyqId).collection('Responses');
    showLogs(`⏳ Fetching submitted responses for leaderboard for PYQ ${pyqId}.`);
    const snapshot = await responsesRef.get();
    if (snapshot.empty) {
      showLogs(`⚠️ No submitted responses found for PYQ ${pyqId}.`);
      return res.status(200).json([]);
    }

    const all = [];
    snapshot.forEach(doc => {
      const d = doc.data();
      if (d.isTestSubmitted) {
        all.push({
          userId: doc.id,
          name: d.name ?? `guest_${doc.id.slice(0,8)}`,
          totalQuestions: d.totalQuestions ?? 0,
          totalAttempted: d.totalAttempted ?? 0,
          totalCorrect: d.totalCorrect ?? 0,
          totalTimeTaken: d.totalTimeTaken ?? 0
        });
      }
    });
    showLogs(`✅ Found ${all.length} submitted responses for leaderboard.`);
    return res.status(200).json(all);
  } catch (err) {
    showLogs('❌ Error in /api/pyq-toppers:', err);
    return res.status(500).json({ error: err.message });
  }
});


export default router;