import express from "express";
import fsSync from 'fs';
import path from 'path';
import { showLogs } from '../lib/logs.js';
import CryptoJS from 'crypto-js';
import { safeReadJSON, safeWriteJSON } from '../lib/fileStore.js';
import { db, auth, rtDb, admin } from '../lib/firebase.js';
import {getQuestionsFromDatabase } from '../res/local_file_functions.js'
const router = express.Router();

router.get("/chapter-tests/questions", async (req, res) => {
  showLogs('🔵 [START] /chapter-tests/questions');
  try {
    const { subject, chapter, whatClicked, uid } = req.query;
    if (!uid || !subject || !chapter || !whatClicked) {
      return res.status(400).json({ error: "Missing subject, chapter, whatClicked, or UID." });
    }

    // 1) If starting a test, deduct tokens
    if (whatClicked === "startTest") {
      const userDocRef = db.collection("users").doc(uid);
      const userSnap = await userDocRef.get();
      if (!userSnap.exists) return res.status(404).json({ error: "User not found" });

      const userData = userSnap.data();
      const tokens = typeof userData.tokens === "number" ? userData.tokens : 0;
      const TOKENS_PER_CHAPTER_TEST = 5;

      if (tokens < TOKENS_PER_CHAPTER_TEST) {
        return res.status(402).json({ error: `Insufficient tokens. Need ${TOKENS_PER_CHAPTER_TEST}.` });
      }

      await userDocRef.set({ tokens: tokens - TOKENS_PER_CHAPTER_TEST }, { merge: true });
      showLogs(`✅ Deducted ${TOKENS_PER_CHAPTER_TEST} tokens from ${uid}.`);
    }

    // 2) Fetch questions using the global function
const selections = [{ subject, chapters: [chapter] }];
showLogs(`Fetching questions for ${subject} - ${chapter}...`);
    const questions = await getQuestionsFromDatabase(selections, Math.ceil(20), uid); // you can tune count logic

    if (!questions.length) {
      return res.status(404).json({ error: "No questions available for this chapter." });
    }

    showLogs(`✅ Fetched ${questions.length} questions for ${subject} - ${chapter}.`);
    return res.json({ questions });
  } catch (err) {
    showLogs(`❌ GET /chapter-tests/questions →`, err);
    return res.status(500).json({ error: `Server error: ${err.message}` });
  } finally {
    showLogs('🔵 [END] /chapter-tests/questions');
  }
});

router.post('/chapter-analysis', async (req, res) => {
  const userId = req.uid;

  try {
    const analysisRef = db.collection('users').doc(userId).collection('analysis');
    const snapshot = await analysisRef.get();

    const chapterAnalysisDict = {};
    snapshot.forEach(doc => {
      const chapterData = doc.data();
      const chapterName = doc.id; // The chapter name is the document ID
      chapterAnalysisDict[chapterName] = {
        timeTakenInCorrect: chapterData.timeTakenInCorrect || 0,
        timeTakenInWrong: chapterData.timeTakenInWrong || 0,
        totalCorrect: chapterData.totalCorrect || 0,
        totalTimeTaken: chapterData.totalTimeTaken || 0,
        totalWrong: chapterData.totalWrong || 0
      };
    });
    return res.status(200).json(chapterAnalysisDict);
  } catch (error) {
    showLogs("Error fetching chapter analysis:", error);
    return res.status(500).json({ message: `Internal server error: ${error.message}` });
  }
});

export default router;