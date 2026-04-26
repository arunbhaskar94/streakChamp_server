import express from "express";
import fsSync from 'fs';
import path from 'path';
import { showLogs } from '../lib/logs.js';
import CryptoJS from 'crypto-js';
import { safeReadJSON, safeWriteJSON } from '../lib/fileStore.js';
import { db, auth, rtDb, admin } from '../lib/firebase.js';
import {getQuestionsFromDatabase } from '../res/local_file_functions.js'
const router = express.Router();

router.post('/getBubbleQuestions', async (req, res) => {
  const requestId = `${req.uid || 'anon'}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  showLogs(`[${requestId}] /getBubbleQuestions start`);

  try {
    const userId = req.uid;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized. No user.' });
    }

    const { userWantToAttempt, count = 50 } = req.body || {};
    const maxCount = Math.max(1, Number(count) || 50);

    if (!Array.isArray(userWantToAttempt) || userWantToAttempt.length === 0) {
      showLogs(`[${requestId}] No selections - returning empty array`);
      return res.json({ questions: [] });
    }

    // 🔥 Use the global function
    const questions = await getQuestionsFromDatabase(userWantToAttempt, maxCount, userId);

    showLogs(`[${requestId}] Final prepared questions count=${questions.length}`);
    return res.json({ questions });
  } catch (err) {
    showLogs(`[${requestId}] ERROR in /getBubbleQuestions: ${err.stack || err}`);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.post('/bubble-session/submit', async (req, res) => {
  const uid = req.uid;
  const payload = req.body;

  showLogs('/api/bubble-session/submit - incoming payload:', JSON.stringify(payload || {}));

  if (!payload) {
    return res.status(400).json({ error: 'Missing payload. Expected { sessionSummary, answers }.' });
  }

  if (!payload.sessionSummary || !Array.isArray(payload.answers)) {
    if (payload.questionId) {
      try {
        const userRef = db.collection('users').doc(uid);
        const answerDoc = {
          questionId: payload.questionId,
          chosenOption: payload.chosenOption,
          isCorrect: !!payload.isCorrect,
          timeTaken: payload.timeTaken,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        };
        await userRef.collection('bubbleAnswers').add(answerDoc);
        return res.json({ success: true, message: 'Single answer recorded (fallback).' });
      } catch (err) {
        showLogs('Error saving single answer fallback', err);
        return res.status(500).json({ error: 'Failed to save single answer', detail: err.message });
      }
    }

    return res.status(400).json({
      error: 'Invalid payload. Expected { sessionSummary: {...}, answers: [...] }. Received different shape.',
      receivedKeys: Object.keys(payload)
    });
  }

  const { sessionSummary = {}, answers = [] } = payload;
  const sessionScore = Number(sessionSummary.score || 0);
  const sessionLevel = Number(sessionSummary.level || 0);
  const xpGained = Number(sessionSummary.xpGained || 0);

  try {
    const userRef = db.collection('users').doc(uid);
    const rankingRef = db.collection('ranking').doc('bubbleGame').collection('users').doc(uid);

    await db.runTransaction(async (t) => {
      const userSnap = await t.get(userRef);
      const userData = userSnap.exists ? userSnap.data() : {};

      const oldXp = Number(userData.xp || 0);
      const oldScore = Number(userData.score || 0);
      const oldLevel = Number(userData.level || 0);

      const newXp = oldXp + xpGained;
      const newLevel = sessionLevel || oldLevel;
      const newHighScore = Math.max(oldScore, sessionScore);

      // Update user profile aggregates
      t.set(userRef, {
        bubbleXp: newXp,
        bubbleLevel: newLevel,
        bubbleScorescore: newHighScore,
        lastPlayed: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      // Mirror data into leaderboard collection
      t.set(rankingRef, {
        uid,
        bubbleXp: newXp,
        bubbleLevel: newLevel,
        bubbleScorescore: newHighScore,
        displayName: userData.displayName || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      // Store session details
      const sessionDocRef = userRef.collection('bubbleSessions').doc();
      t.set(sessionDocRef, {
        score: sessionScore,
        xpGained,
        level: newLevel,
        totalQuestions: sessionSummary.totalQuestions || answers.length,
        totalCorrect: sessionSummary.totalCorrect || answers.filter(a => a.isCorrect).length,
        startedAt: new Date(sessionSummary.startedAt || Date.now()),
        endedAt: new Date(sessionSummary.endedAt || Date.now()),
        answers,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return res.json({ success: true, message: 'Session + leaderboard updated.' });
  } catch (err) {
    showLogs('Error in /api/bubble-session/submit', err);
    return res.status(500).json({ error: 'Failed to save session', detail: err.message });
  }
});

router.post('/open-daily-chest', async (req, res) => {
  const uid = req.uid;

  try {
    const userRef = db.collection('users').doc(uid);
    await db.runTransaction(async (t) => {
      const uSnap = await t.get(userRef);
      const userData = uSnap.exists ? uSnap.data() : {};
      const lastOpenedMs = userData.lastDailyChest ? (userData.lastDailyChest.toMillis ? userData.lastDailyChest.toMillis() : Number(userData.lastDailyChest)) : 0;
      const nowMs = Date.now();

      const MS_24H = 24 * 60 * 60 * 1000;
      if (lastOpenedMs && (nowMs - lastOpenedMs) < MS_24H) {
        const nextOpenAt = new Date(lastOpenedMs + MS_24H).toISOString();
        throw { code: 'TOO_EARLY', message: 'Chest already opened recently', nextOpenAt };
      }

      // determine reward (server decides)
      const possible = [20, 30, 50, 80, 120];
      const rewardXp = possible[Math.floor(Math.random() * possible.length)];

      const oldXp = Number(userData.xp || 0);
      const newXp = oldXp + rewardXp;

      t.set(userRef, {
        xp: newXp,
        lastDailyChest: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      // optionally record chest claim event
      const eventRef = db.collection('analytics').doc();
      t.set(eventRef, {
        uid, event: 'daily_chest_claim', rewardXp, ts: admin.firestore.FieldValue.serverTimestamp()
      });
      // transaction completes
      res.json({ success: true, rewardXp, newTotalXp: newXp });
    });
  } catch (err) {
    if (err && err.code === 'TOO_EARLY') {
      return res.status(429).json({ error: err.message, nextOpenAt: err.nextOpenAt });
    }
    showLogs('Error handing /api/open-daily-chest', err);
    return res.status(500).json({ error: 'Failed to open chest' });
  }
});

export default router;