import express from "express";
import fsSync from 'fs';
import path from 'path';
import { showLogs } from '../lib/logs.js';
import CryptoJS from 'crypto-js';
import { safeReadJSON, safeWriteJSON } from '../lib/fileStore.js';
import { db, auth, rtDb, admin } from '../lib/firebase.js';
import {getQuestionsFromDatabase } from '../res/local_file_functions.js'
import fs from 'fs/promises';
import {LEADERBOARD_REELS, LEADERBOARD_COMBINED} from '../server.js';
const router = express.Router();
import { fileURLToPath } from 'url';
import { buggyQuestionsStore } from '../lib/firestoreStore.js';

// Provide __filename / __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

router.post('/update-user-rank', async (req, res) => {
  showLogs("🔹 Received /update-user-rank request.");
  const { userId, leaderboardType, score, timeAccuracy, displayName } = req.body; // Added leaderboardType

  if (!userId || !leaderboardType || score === undefined || timeAccuracy === undefined) {
    showLogs("⚠️ /update-user-rank: Invalid data received:", { userId, leaderboardType, score, timeAccuracy, displayName });
    return res.status(400).json({ status: 'error', message: 'Invalid data received.' });
  }

  // Validate leaderboardType
  const validLeaderboardTypes = ['leaderboardReels', 'leaderboardMock', 'leaderboardCombined'];
  if (!validLeaderboardTypes.includes(leaderboardType)) {
    showLogs(`⚠️ /update-user-rank: Invalid leaderboardType: ${leaderboardType}`);
    return res.status(400).json({ status: 'error', message: 'Invalid leaderboard type.' });
  }

  try {
    const leaderboardRef = db.collection('ranking').doc(leaderboardType).collection('users').doc(userId); // Use the global db instance
    const userDoc = await leaderboardRef.get();

    if (!userDoc.exists) {
      showLogs(`⚠️ /update-user-rank: User not found in ${leaderboardType} collection for userId: ${userId}.`);
      return res.status(404).json({ status: 'error', message: `User not found in ${leaderboardType} collection.` });
    }

    const updateData = {
      displayName: displayName,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      TimeAccuracy: parseFloat(timeAccuracy),
    };

    if (leaderboardType === 'leaderboardReels') {
      updateData.reelScore = parseFloat(score);
    } else if (leaderboardType === 'leaderboardMock') {
      updateData.MockScore = parseFloat(score);
    } else if (leaderboardType === 'leaderboardCombined') {
      updateData.totalScore = parseFloat(score);
    }

    await leaderboardRef.set(updateData, { merge: true }); // Use set with merge to create/update
    showLogs(`✅ /update-user-rank: Rank updated successfully for userId: ${userId} in ${leaderboardType}.`);
    res.json({ status: 'success', message: 'Rank updated successfully.' });
  } catch (error) {
    showLogs("❌ /update-user-rank: Error updating rank data:", error.message, error);
    return res.status(500).json({ status: 'error', message: `Failed to update rank data: ${error.message}`, error: error.message });
  }
});

router.post('/submit-answer', async (req, res) => {
  showLogs("🔹 Received /submit-answer");
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    showLogs("❌ Missing auth");
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }
  const token = authHeader.split(' ')[1];

  let {
    firestoreDocId,
    questionID,
    category,
    subject,
    chapter,
    elapsedTime,
    answerTrueOrNot,
    chosenOption
  } = req.body;

  showLogs("🔹 Payload recieved for this : ", questionID);

  // Basic validation
  if (!firestoreDocId || !category || !chapter || typeof answerTrueOrNot !== 'boolean') {
    showLogs("❌ Bad payload");
    return res.status(400).json({ status: 'error', message: 'Bad payload' });
  }
  const ms = parseFloat(elapsedTime);
  if (isNaN(ms)) {
    showLogs("❌ Bad time");
    return res.status(400).json({ status: 'error', message: 'Invalid elapsedTime' });
  }

  const timeSec = Math.round(ms);
  showLogs(ms, timeSec)
  try {
    const { uid } = await auth.verifyIdToken(token);
    showLogs("✅ UID:", uid);

    const userRef = db.collection('users').doc(uid);
    const attemptRef = userRef.collection('reelsAttempts').doc(firestoreDocId);
    const rankingReelsRef = db
      .collection('ranking').doc(LEADERBOARD_REELS)
      .collection('users').doc(uid);
    const rankingCombinedRef = db
      .collection('ranking').doc(LEADERBOARD_COMBINED)
      .collection('users').doc(uid);
    const chapterAnalysisRef = userRef.collection('analysis').doc(chapter);

    // Everything in one transaction on the *user* subtree
    await db.runTransaction(async tx => {
      const uSnap = await tx.get(userRef);
      const chSnap = await tx.get(chapterAnalysisRef);
      const uData = uSnap.data() || {};

      // enforce tokens
      let tokens = uData.tokens || 0;
      if (!answerTrueOrNot && tokens < 1) {
        throw new Error('Not enough tokens');
      }

      // compute new aggregates
      const uCorr = (uData.TotalcorrectReels || 0) + (answerTrueOrNot ? 1 : 0);
      const uWrong = (uData.TotalwrongReels || 0) + (answerTrueOrNot ? 0 : 1);
      const uTime = (uData.TotaltimeTakenReels || 0) + timeSec;
      const uTimeC = (uData.TotaltimeforCorrectReelsQuestions || 0) + (answerTrueOrNot ? timeSec : 0);
      const uTimeW = (uData.TotaltimeforWrongReelsQuestions || 0) + (answerTrueOrNot ? 0 : timeSec);
      tokens += answerTrueOrNot ? 0.5 : -1;

      tx.update(userRef, {
        TotalcorrectReels: uCorr,
        TotalwrongReels: uWrong,
        TotaltimeTakenReels: uTime,
        TotaltimeforCorrectReelsQuestions: uTimeC,
        TotaltimeforWrongReelsQuestions: uTimeW,
        tokens
      });

      // log the individual attempt
      tx.set(attemptRef, {
        questionID,
        isAttempted: true,
        wasCorrect: answerTrueOrNot,
        chosenOption,
        timeTakenSec: timeSec,
        attemptedAt: admin.firestore.FieldValue.serverTimestamp(),
        subject,
        chapter
      }, { merge: true });

      // update chapter analysis
      const chData = chSnap.exists ? chSnap.data() : {};
      const chCorrect = (chData.totalCorrect || 0) + (answerTrueOrNot ? 1 : 0);
      const chWrong = (chData.totalWrong || 0) + (answerTrueOrNot ? 0 : 1);
      const chTimeC = (chData.timeTakenInCorrect || 0) + (answerTrueOrNot ? timeSec : 0);
      const chTimeW = (chData.timeTakenInWrong || 0) + (answerTrueOrNot ? 0 : timeSec);
      const chTotalT = (chData.totalTimeTaken || 0) + timeSec;

      tx.set(chapterAnalysisRef, {
        totalCorrect: chCorrect,
        totalWrong: chWrong,
        timeTakenInCorrect: chTimeC,
        timeTakenInWrong: chTimeW,
        totalTimeTaken: chTotalT
      }, { merge: true });
    });

    showLogs("✅ User aggregates & attempt saved");

    // Fetch updated user stats for leaderboards
    const updatedUser = (await userRef.get()).data();
    const {
      TotalcorrectReels = 0, TotalwrongReels = 0,
      TotaltimeTakenReels = 0, TotaltimeforCorrectReelsQuestions = 0,
      TotalcorrectMocks = 0, TotalwrongMocks = 0,
      TotaltimeTakenMocks = 0, TotaltimeforCorrectMockQuestions = 0
    } = updatedUser;

    // Reels leaderboard
    const totalReelAttempts = TotalcorrectReels + TotalwrongReels;
    const reelScore = totalReelAttempts
      ? (TotalcorrectReels / totalReelAttempts)
      : 0;
    const timeAccuracy = TotaltimeTakenReels
      ? (TotaltimeforCorrectReelsQuestions / TotaltimeTakenReels)
      : 0;
    await rankingReelsRef.set({
      reelScore,
      displayName: updatedUser.displayName || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      TimeAccuracy: timeAccuracy
    }, { merge: true });

    // Combined leaderboard
    const totalMockAttempts = TotalcorrectMocks + TotalwrongMocks;
    const totalCorrectAll = TotalcorrectReels + TotalcorrectMocks;
    const totalAttemptsAll = totalReelAttempts + totalMockAttempts;
    const totalScore = totalAttemptsAll
      ? (totalCorrectAll / totalAttemptsAll)
      : 0;
    const combinedTimeAccuracy = (TotaltimeforCorrectReelsQuestions + TotaltimeforCorrectMockQuestions)
      / (TotaltimeTakenReels + TotaltimeTakenMocks || 1);


    await rankingCombinedRef.set({
      totalScore,
      displayName: updatedUser.displayName || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      TimeAccuracy: combinedTimeAccuracy
    }, { merge: true });

    showLogs("✔️ Leaderboards updated");
    res.json({ status: 'success' });
  }
  catch (err) {
    showLogs("❌ /submit-answer error:", err);
    const code = err.message === 'Not enough tokens' ? 402 : 500;
    res.status(code).json({ status: 'error', message: err.message });
  }
});

router.post('/report-question', async (req, res) => {
  showLogs("🔹 Received request at /report-question (Firestore-based)");
  try {
    const { questionID, category, firestoreDocId, chapter, remarks } = req.body || {};

    // Basic validation
    if (!questionID || !category || !firestoreDocId || !chapter) {
      showLogs("⚠️ /report-question: Missing required fields (questionID, category, firestoreDocId, chapter).");
      return res.status(400).json({ status: 'error', message: 'Missing required fields.' });
    }

    // authenticateRequest middleware should have set req.uid; fallback to token decode if you want
    const userId = req.uid || null;

    const reportedAt = new Date().toISOString();
    const ip = req.ip || req.headers['x-forwarded-for'] || null;

    // Build the report data
    const reportData = {
      originalQuestionID: questionID,
      firestoreDocId,
      category,
      chapter,
      reportedAt,
      lastReportedAt: reportedAt,
      userId,
      remarks: remarks || null,
      ip,
      status: 'pending',
      count: 1,
      reporters: userId ? [userId] : []
    };

    // Read existing reports from Firestore
    const existingReports = await buggyQuestionsStore.readAll();
    showLogs(`📊 Existing reports count: ${Object.keys(existingReports).length}`);

    // Try to find an existing report for same doc/category/chapter
    let existingReportId = null;
    let existingReport = null;
    
    for (const [docId, report] of Object.entries(existingReports)) {
      if (report.firestoreDocId === firestoreDocId && 
          report.category === category && 
          report.chapter === chapter) {
        existingReportId = docId;
        existingReport = report;
        break;
      }
    }

    if (existingReportId && existingReport) {
      // Update existing report
      showLogs(`🔄 Updating existing report: ${existingReportId}`);
      const updatedReport = {
        ...existingReport,
        count: (existingReport.count || 1) + 1,
        lastReportedAt: reportedAt
      };

      if (remarks) {
        updatedReport.remarks = existingReport.remarks ? 
          `${existingReport.remarks} | ${remarks}` : remarks;
      }

      if (userId) {
        if (!Array.isArray(updatedReport.reporters)) updatedReport.reporters = [];
        if (!updatedReport.reporters.includes(userId)) {
          updatedReport.reporters.push(userId);
        }
      }

      // Update the existing report in Firestore
      await buggyQuestionsStore.write(updatedReport, existingReportId);
      showLogs(`✅ Updated existing report in Firestore: ${existingReportId}`);
    } else {
      // Create new report - use firestoreDocId as the document ID for easy lookup
      const newReportId = `${firestoreDocId}_${category}_${chapter}`.replace(/[\/\.]/g, '_');
      showLogs(`🆕 Creating new report with ID: ${newReportId}`);
      await buggyQuestionsStore.write(reportData, newReportId);
      showLogs(`✅ New report saved to Firestore with ID: ${newReportId}`);
    }

    return res.json({ status: 'success', message: 'Question reported successfully.' });
  } catch (err) {
    showLogs('❌ /report-question (Firestore) error:', err && err.message ? err.message : err);
    return res.status(500).json({ 
      status: 'error', 
      message: `Failed to save report: ${err && err.message ? err.message : String(err)}` 
    });
  }
});

router.post('/update-question-time', async (req, res) => {
  showLogs("🔹 Received request at /update-question-time");
  const authHeader = req.headers.authorization;

  const { questionID, elapsedTime, isCorrect, category, subject, chapter } = req.body;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    showLogs("⚠️ /update-question-time: Unauthorized access. No token provided.");
    return res.status(401).json({ status: 'error', message: 'Unauthorized access. No token provided.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decodedToken = await auth.verifyIdToken(token); // Use the global auth instance
    const userId = decodedToken.uid;
    showLogs("✅ Token verified. User ID:", userId);

    if (!questionID || elapsedTime === undefined || isCorrect === undefined || !category || !subject || !chapter) {
      showLogs("⚠️ /update-question-time: Invalid request. Missing data.");
      return res.status(400).json({ status: 'error', message: 'Invalid request. Missing data.' });
    }

    const userDocRef = db.collection('users').doc(userId); // Use the global db instance

    await db.runTransaction(async (transaction) => { // Use the global db instance
      const userDoc = await transaction.get(userDocRef);
      const userData = userDoc.data();

      let newTotalTimeTakenReels = (userData.TotaltimeTakenReels || 0) + parseFloat(elapsedTime);
      let newTotalTimeforCorrectReelsQuestions = (userData.TotaltimeforCorrectReelsQuestions || 0);
      let newTotalTimeforWrongReelsQuestions = (userData.TotaltimeforWrongReelsQuestions || 0);

      if (isCorrect) {
        newTotalTimeforCorrectReelsQuestions += parseFloat(elapsedTime);
      } else {
        newTotalTimeforWrongReelsQuestions += parseFloat(elapsedTime);
      }

      transaction.update(userDocRef, {
        TotaltimeTakenReels: newTotalTimeTakenReels,
        TotaltimeforCorrectReelsQuestions: newTotalTimeforCorrectReelsQuestions,
        TotaltimeforWrongReelsQuestions: newTotalTimeforWrongReelsQuestions,
      });
    });

    showLogs("✅ User document updated with question time data.");
    res.json({ status: 'success', message: 'Data updated successfully.' });

  } catch (error) {
    showLogs("❌ /update-question-time: Error processing request:", error);
    return res.status(500).json({ status: 'error', message: `Failed to update question time: ${error.message}`, error: error.message });
  }
});

router.post('/getReels', async (req, res) => {
  showLogs('--- /api/getReels Request Start ---');
  const selections = req.body.userWantToAttempt || [];
  const userId = req.userId;

  try {
    const data = await getQuestionsFromDatabase(selections, 10, userId);
    res.json(data);
  } catch (err) {
    showLogs('Error in /getReels:', err);
    res.status(500).json({ error: 'Failed to fetch reels' });
  }
  showLogs('--- /api/getReels Request End ---');
});

router.post('/handle-like-dislike', async (req, res) => {
  showLogs('🔵 [START] /handle-like-dislike');

  const { id, action, uid } = req.body;
  if (!id || !['like', 'dislike'].includes(action) || !uid) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const DATA_PATH = path.join(__dirname, '..', 'server questions data', 'question_data.json');
  const LOCK_PATH = DATA_PATH + '.lock';
  const TEMP_PATH = DATA_PATH + '.tmp';

  // simple lock implementation (file-based). waits up to timeoutMs
  async function acquireLock(timeoutMs = 5000, intervalMs = 80) {
    const start = Date.now();
    while (true) {
      try {
        // 'wx' will fail if file exists
        await fs.open(LOCK_PATH, 'wx');
        showLogs('🔒 lock acquired');
        return;
      } catch (err) {
        // file exists or other
        if (Date.now() - start > timeoutMs) {
          throw new Error('Timeout acquiring file lock');
        }
        await new Promise(r => setTimeout(r, intervalMs));
      }
    }
  }
  async function releaseLock() {
    try {
      await fs.unlink(LOCK_PATH);
      showLogs('🔓 lock released');
    } catch (err) {
      // ignore missing lock
      showLogs('⚠️ failed to remove lock file (may already be gone):', err && err.message);
    }
  }

  try {
    // Acquire lock to serialize read-modify-write
    await acquireLock(8000, 100);

    // Read file
    let raw;
    try {
      raw = await fs.readFile(DATA_PATH, 'utf8');
    } catch (err) {
      showLogs('❌ Failed to read data file:', err && err.message);
      await releaseLock();
      return res.status(500).json({ error: 'Failed to read questions data' });
    }

    // Parse safely and provide diagnostics on error
    let questions;
    try {
      questions = JSON.parse(raw);
    } catch (parseErr) {
      showLogs('❌ JSON.parse failed:', parseErr && parseErr.message);

      // try to detect numeric position from message
      const msg = String(parseErr && parseErr.message || '');
      let posMatch = msg.match(/position\s+(\d+)/i) || msg.match(/at position\s+(\d+)/i);
      let pos = posMatch ? Number(posMatch[1]) : null;

      // If position not found, attempt to parse by line/column pattern too
      if (!pos) {
        const posMatch2 = msg.match(/line\s+(\d+)\s+column\s+(\d+)/i);
        if (posMatch2) {
          // approximate position by scanning lines
          const lineNum = Number(posMatch2[1]);
          const columnNum = Number(posMatch2[2]);
          const lines = raw.split(/\r?\n/);
          pos = 0;
          for (let i = 0; i < Math.min(lines.length, lineNum - 1); i++) pos += lines[i].length + 1;
          pos += Math.max(0, columnNum - 1);
        }
      }

      // Dump small snippet around pos for debugging
      if (typeof pos === 'number' && !Number.isNaN(pos)) {
        const start = Math.max(0, pos - 120);
        const end = Math.min(raw.length, pos + 120);
        const snippet = raw.slice(start, end);
        showLogs('🔎 JSON parse error snippet (around pos ' + pos + '):\n' + snippet);

        // Also persist the broken file for offline inspection with timestamp
        const brokenPath = DATA_PATH + `.broken_${Date.now()}.json`;
        try {
          await fs.writeFile(brokenPath, raw, 'utf8');
          showLogs('📝 Wrote broken file snapshot to:', brokenPath);
        } catch (wErr) {
          showLogs('⚠️ Failed to write broken snapshot file:', wErr && wErr.message);
        }
      } else {
        showLogs('🔎 Could not determine error position from parser message. Raw message:', msg.slice(0,200));
      }

      await releaseLock();
      return res.status(500).json({ error: 'Corrupted JSON data file. Snapshot written for inspection.' });
    }

    // find question index
    const idx = questions.findIndex(q => q.QuestionID === id);
    if (idx === -1) {
      await releaseLock();
      return res.status(404).json({ error: 'Question not found' });
    }

    // modify metadata only
    const meta = questions[idx].metadata && typeof questions[idx].metadata === 'object' ? questions[idx].metadata : {};
    meta.likedBy = Array.isArray(meta.likedBy) ? meta.likedBy.slice() : [];
    meta.dislikedBy = Array.isArray(meta.dislikedBy) ? meta.dislikedBy.slice() : [];

    const hasLiked = meta.likedBy.includes(uid);
    const hasDisliked = meta.dislikedBy.includes(uid);

    if (action === 'like') {
      if (!hasLiked) {
        meta.likedBy.push(uid);
      }
      // remove from disliked
      meta.dislikedBy = meta.dislikedBy.filter(u => u !== uid);
    } else { // dislike
      if (!hasDisliked) {
        meta.dislikedBy.push(uid);
      }
      meta.likedBy = meta.likedBy.filter(u => u !== uid);
    }

    meta.likes = meta.likedBy.length;
    meta.dislikes = meta.dislikedBy.length;
    questions[idx].metadata = meta;

    // Atomic write: write to TEMP_PATH then rename
    try {
      await fs.writeFile(TEMP_PATH, JSON.stringify(questions, null, 2), 'utf8');
      await fs.rename(TEMP_PATH, DATA_PATH);
      showLogs('✅ Metadata update saved atomically');
    } catch (writeErr) {
      showLogs('❌ Failed to write / rename file:', writeErr && writeErr.message);
      // try to cleanup temp if exists
      try { await fs.unlink(TEMP_PATH); } catch (e) { /* ignore */ }
      await releaseLock();
      return res.status(500).json({ error: 'Failed to save updated metadata' });
    }

    // success
    await releaseLock();
    res.json({ id, likes: meta.likes, dislikes: meta.dislikes });

  } catch (err) {
    showLogs('❌ Error in handle-like-dislike:', err && err.message);
    // Try release lock in case of unexpected errors
    try { await fs.unlink(LOCK_PATH); } catch (e) { /* ignore */ }
    res.status(500).json({ error: 'Server error updating reaction' });
  } finally {
    showLogs('🔵 [END] /handle-like-dislike');
  }
});

export default router;