import express from "express";
import fsSync from 'fs';
import path from 'path';
import { showLogs } from '../lib/logs.js';
import CryptoJS from 'crypto-js';
import { safeReadJSON, safeWriteJSON } from '../lib/fileStore.js';
import { db, auth, rtDb, admin } from '../lib/firebase.js';
import { filterQuestionsAndRecord } from '../res/local_file_functions.js'
import { invalidQuestionOverrides, mockIndex, questionBank, actualKey } from '../server.js';


const router = express.Router();

const timestampToMs = (timestamp) => {
  if (timestamp instanceof admin.firestore.Timestamp) {
    return timestamp.toMillis();
  }
  return timestamp; // Return as is if not a Timestamp object
};


router.get('/', async (req, res) => {
  try {
    // Load mockIndex from mock.json and prepare response with totalQuestions
    const mocksData = Object.keys(mockIndex).map(mockId => ({
      id: mockId,
      totalQuestions: mockIndex[mockId].length,
      questionIDs: mockIndex[mockId], // optional: include IDs if needed
    }));

    showLogs(`✅ Fetched ${mocksData.length} mock tests from mock.json.`);
    res.json(mocksData);
  } catch (error) {
    showLogs("❌ Error fetching mocks:", error.message);
    res.status(500).json({ error: `Failed to retrieve mock tests: ${error.message}` });
  }
});

router.get("/:mock_id/questions", async (req, res) => {
  try {
    const mockId = req.params.mock_id;
    const whatClicked = req.query.whatClicked; // e.g. "startTest" / "resumeTest" / "reviewTest"
    const uid = req.query.uid; // the user’s UID sent from the client

    if (!uid) {
      return res.status(400).json({ error: "No UID provided" });
    }
    if (!whatClicked) {
      return res
        .status(400)
        .json({ error: "No whatClicked parameter provided" });
    }

    // --- 1) If starting a test, check/deduct tokens ---
    if (whatClicked === "startTest") {
      // Read the user’s current token count from Firestore: users/{uid}/tokens
      const userDocRef = db.collection("users").doc(uid);
      const userSnap = await userDocRef.get();

      if (!userSnap.exists) {
        return res.status(404).json({ error: "User not found" });
      }
      const userData = userSnap.data();
      const tokens = typeof userData.tokens === "number" ? userData.tokens : 0;

      if (tokens < 20) {
        // Not enough tokens: tell the client to earn more
        return res
          .status(402) // 402 Payment Required (or 400)
          .json({ error: "Insufficient tokens. Earn more to start the test." });
      }

      // Deduct 20 tokens and update Firestore
      const newTokenCount = tokens - 20;
      await userDocRef.set({ tokens: newTokenCount }, { merge: true });
      showLogs(`✅ Deducted 20 tokens from ${uid}. Remaining = ${newTokenCount}`);
    }
    // If whatClicked is "resumeTest" or "reviewTest", we skip token deduction and just return questions.

    // --- 2) Fetch & decrypt the questions from local JSON files ---
    const mockQuestionIDs = mockIndex[mockId];

    if (!mockQuestionIDs || mockQuestionIDs.length === 0) {
      return res.status(404).json({ error: "No question IDs found for this mock in mock.json" });
    }

    const decryptedMockQuestions = [];
    for (const qid of mockQuestionIDs) {
      const questionEntry = questionBank.find(q => q.QuestionID === qid);

      if (!questionEntry) {
        showLogs(`⚠️ Question ID '${qid}' not found in question_data.json.`);
        continue; // Skip to the next question ID
      }

      try {
        // Decrypt the cipherText using the global actualKey
        const bytes = CryptoJS.AES.decrypt(questionEntry.cipherText, actualKey);
        const jsonString = bytes.toString(CryptoJS.enc.Utf8);
        const parsed = JSON.parse(jsonString);
        let currentQuestionID = questionEntry.QuestionID;
        //showLogs(currentQuestionID);
        let optionsHindi = [parsed.OptionA, parsed.OptionB, parsed.OptionC, parsed.OptionD].filter(Boolean);
        let answerHindi = parsed.Answer ?? '';
        let optionsEng = [parsed.OptionA_Eng, parsed.OptionB_Eng, parsed.OptionC_Eng, parsed.OptionD_Eng].filter(Boolean);
        let answerEng = parsed.Answer_Eng ?? '';

        const override = invalidQuestionOverrides[questionEntry.QuestionID];
        if (override) {
          if (override.hindi) {
            if (Array.isArray(override.hindi.options) && override.hindi.options.length) optionsHindi = override.hindi.options.slice();
            if (override.hindi.answer) answerHindi = override.hindi.answer;
          }
          if (override.english) {
            if (Array.isArray(override.english.options) && override.english.options.length) optionsEng = override.english.options.slice();
            if (override.english.answer) answerEng = override.english.answer;
          }
        }

        // then push object using optionsHindi/answerHindi/optionsEng/answerEng

        // finally push using the resolved variables (NOT parsed.* directly)
        decryptedMockQuestions.push({
          questionID: currentQuestionID,
          subject: parsed.Subject,
          chapter: parsed.Chapter,
          // Hindi content
          questionHindi: parsed.Question ?? '',
          optionsHindi: optionsHindi,
          answerHindi: answerHindi,
          // English content
          questionEng: parsed.Question_Eng ?? '',
          optionsEng: optionsEng,
          answerEng: answerEng,
        });
      } catch (decryptErr) {
        showLogs(`⚠️ Failed to decrypt/parse question ID '${qid}' for mock ${mockId}:`, decryptErr.message);
        // Continue to the next question even if one fails
      }
    }

    if (decryptedMockQuestions.length === 0) {
      return res
        .status(500)
        .json({
          error:
            "No valid questions found or decrypted for this mock. Check actualKey or data format.",
        });
    }

    // 3) Return decrypted questions
    const filteredMockQuestions = filterQuestionsAndRecord(decryptedMockQuestions);

    if (!filteredMockQuestions.length) {
      // nothing valid to send after filtering — surface a clear error so caller can inspect buggy_questions.json
      return res.status(500).json({
        error: 'No valid questions to return after validation. See buggy_questions.json for questionIDs that failed exact-match checks.'
      });
    }

    return res.json({ questions: filteredMockQuestions });
  } catch (err) {
    showLogs(`❌ GET /mocks/${req.params.mock_id}/questions →`, err);
    return res.status(500).json({ error: `Server error: ${err.message}` });
  }
});

router.get('/:mock_id/responses/:user_id',  async (req, res) => {
  try {
    const { mock_id, user_id } = req.params;
    const docRef = db.collection("mocks").doc(mock_id).collection("Responses").doc(user_id);
    const docSnap = await docRef.get();
    if (docSnap.exists) {
      const data = docSnap.data();
      showLogs(data)
      // Convert any Firestore Timestamps to milliseconds for consistency with frontend
      if (data.updatedAt) {
        data.updatedAt = timestampToMs(data.updatedAt);
      }
      if (data.submittedAt) {
        data.submittedAt = timestampToMs(data.submittedAt);
      }
      showLogs(`✅ User responses fetched for user ${user_id} on mock ${mock_id}.`);
      res.json(data);
    } else {
      showLogs(`⚠️ User responses not found for user ${user_id} on mock ${mock_id}.`);
      res.status(404).json({ error: "User responses not found" });
    }
  } catch (error) {
    showLogs(`❌ Error fetching user responses for ${user_id} on mock ${mock_id}:`, error);
    res.status(500).json({ error: `Failed to retrieve user responses: ${error.message}` });
  }
});

router.post('/mock-attempts',  async (req, res) => {
  const userId = req.uid;

  try {
    const mockAttemptsRef = db.collection('users').doc(userId).collection('mockAttempts');
    const snapshot = await mockAttemptsRef.get();

    const mockAttemptsList = [];
    snapshot.forEach(doc => {
      const mockData = doc.data();
      mockAttemptsList.push({
        id: doc.id, // The mockID is the document ID
        Totalcorrect: mockData['Total correct'] || 0,
        Totalwrong: mockData['Total wrong'] || 0,
        TotaltimeTaken: mockData['Total time taken'] || 0,
        Totalunattempted: mockData['Total unattempted'] || 0,
        attempteddate: mockData['attempted date'] || 'N/A'
      });
    });

    // Sort by attempteddate for consistent trending on frontend
    // Assuming 'attempted date' is a string parsable by Date or comparable directly
    mockAttemptsList.sort((a, b) => {
      const dateA = new Date(a.attempteddate);
      const dateB = new Date(b.attempteddate);
      return dateA - dateB;
    });

    return res.status(200).json(mockAttemptsList);
  } catch (error) {
    showLogs("Error fetching mock attempts:", error);
    return res.status(500).json({ message: `Internal server error: ${error.message}` });
  }
});

router.post('/:mock_id/responses/:user_id/progress',  async (req, res) => {
  try {
    const { mock_id, user_id } = req.params;
    const data = req.body;
    if (!data) {
      showLogs("⚠️ Progress save: Request body is empty.");
      return res.status(400).json({ error: "Request body must be JSON" });
    }
    showLogs(data)
    const docRef = db.collection("mocks").doc(mock_id).collection("Responses").doc(user_id);

    // Use server timestamp for accuracy
    data.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    await docRef.set(data, { merge: true });
    showLogs(`✅ Progress saved successfully for user ${user_id} on mock ${mock_id}.`);
    res.json({ message: "Progress saved successfully" });
  } catch (error) {
    showLogs(`❌ Error saving progress for user ${user_id} on mock ${mock_id}:`, error);
    res.status(500).json({ error: `Failed to save progress: ${error.message}` });
  }
});

router.post('/:mock_id/responses/:user_id/submit',  async (req, res) => {
  // 1) Pull params in outer scope so both try & catch can see them
  const { mock_id, user_id } = req.params;
  const data = req.body;

  showLogs(`🔔 Submit handler entered for mock_id=${mock_id}, user_id=${user_id}`);

  if (!data) {
    showLogs("⚠️ Test submission: Request body is empty.");
    return res.status(400).json({ error: "Request body must be JSON" });
  }
  showLogs('📥 Request body received:', data, '-------data end here -------');

  try {
    // 2) Quick save of the “response” doc
    const userResponseDocRef = db
      .collection("mocks").doc(mock_id)
      .collection("Responses").doc(user_id);

    showLogs('🔁 Saving quick response summary to:', userResponseDocRef.path);
    await userResponseDocRef.set({
      totalTimeTaken: data.totalTimeTaken,
      totalQuestions: data.totalQuestions,
      totalAttempted: data.totalAttempted,
      totalCorrect: data.totalCorrect,
      isTestSubmitted: true,
      isPaused: false,
      submittedAt: admin.firestore.FieldValue.serverTimestamp(),
      currentTimerProgress: data.currentTimerProgress,
      name: data.name
    }, { merge: true });
    showLogs(`✅ Quick response saved for user ${user_id} on mock ${mock_id}.`);

    // 3) Save or delete incorrect questions
    const userIncorrectDocRef = db
      .collection("users").doc(user_id)
      .collection("incorrect_responses").doc(mock_id);

    const incorrectData = data.incorrectQuestionsData || {};
    showLogs('ℹ️ incorrectQuestionsData length:', Object.keys(incorrectData).length);
    if (Object.keys(incorrectData).length) {
      showLogs('🔁 Saving incorrect questions to:', userIncorrectDocRef.path);
      await userIncorrectDocRef.set(incorrectData, { merge: true });
      showLogs(`✅ Incorrect questions saved for user ${user_id}.`);
    } else {
      showLogs('🧹 No incorrect questions - deleting doc if exists:', userIncorrectDocRef.path);
      await userIncorrectDocRef.delete();
      showLogs(`✅ No incorrect questions—deleted doc (if existed).`);
    }

    // 4) Now run your stats+analysis transaction
    showLogs('🔐 Starting Firestore transaction for stats + leaderboard updates...');
    await db.runTransaction(async (transaction) => {
      showLogs('🔁 Inside transaction: preparing refs');

      // a) Prepare all refs
      const userRef = db.collection("users").doc(user_id);
      const mockRef = db.collection("mocks").doc(mock_id);
      const attemptRef = userRef.collection("mockAttempts").doc(mock_id); // Existing ref for mockAttempts

      // Leaderboard refs
      const leaderboardMockRef = db.collection("ranking").doc("leaderboardMock").collection("users").doc(user_id);
      const leaderboardCombinedRef = db.collection("ranking").doc("leaderboardCombined").collection("users").doc(user_id);

      // gather unique chapter IDs
      const chapters = Array.from(
        new Set((data.attemptedQuestions || []).map(q => q.chapter).filter(Boolean))
      );
      const chapterRefs = chapters.map(ch =>
        userRef.collection("analysis").doc(ch)
      );

      showLogs('📚 Chapters found:', chapters);

      // b) Do ALL reads first via Promise.all
      showLogs('📡 Performing transaction reads for user, mock, leaderboards and chapter snapshots...');
      const [
        userSnap,
        mockSnap,
        currentLeaderboardMockSnap,
        currentLeaderboardCombinedSnap,
        ...chapterSnaps
      ] = await Promise.all([
        transaction.get(userRef),
        transaction.get(mockRef),
        transaction.get(leaderboardMockRef),
        transaction.get(leaderboardCombinedRef),
        ...chapterRefs.map(ref => transaction.get(ref))
      ]);
      showLogs('✅ Transaction reads complete.');

      const userData = userSnap.data() || {};
      showLogs('🧾 userData snapshot:', userData);

      const existingAttemptSnap = await transaction.get(attemptRef); // Check for existing attempt to determine 'first submission'
      const wasPreviouslySub = existingAttemptSnap.exists;
      showLogs(`📊 Was previously submitted? ${wasPreviouslySub}`);

      // c) UPDATE cumulative stats & mock.attemptedCount if first submission for this specific mock
      if (!wasPreviouslySub) {
        showLogs('🔼 First-time submission — updating cumulative user stats.');
        transaction.update(userRef, {
          TotalcorrectMocks: (userData.TotalcorrectMocks || 0) + data.totalCorrect,
          TotalwrongMocks: (userData.TotalwrongMocks || 0) + (data.totalAttempted - data.totalCorrect),
          TotaltimeTakenMocks: (userData.TotaltimeTakenMocks || 0) + data.totalTimeTaken,
          TotalUnattemptedMocks: (userData.TotalUnattemptedMocks || 0) + (data.totalQuestions - data.totalAttempted),
          TotaltimeforCorrectMockQuestions: (userData.TotaltimeforCorrectMockQuestions || 0) + (data.timeTakenForCorrectMockQuestions || 0),
          TotaltimeforWrongMockQuestions: (userData.TotaltimeforWrongMockQuestions || 0) + (data.timeTakenForWrongMockQuestions || 0)
        });
        showLogs('✅ Cumulative user stats queued to update in transaction.');
      } else {
        showLogs('ℹ️ Not first submission — skipping cumulative increment of user stats & mock attemptedCount.');
      }

      // d) SAVE mockAttempts summary (as requested by user for users/uid/mockAttempts/{mockID})
      const today = new Date().toISOString().slice(0, 10);
      showLogs(`📅 Saving attempt summary for ${today} to ${attemptRef.path}`);
      transaction.set(attemptRef, {
        "Total correct": data.totalCorrect,
        "Total wrong": data.totalAttempted - data.totalCorrect,
        "Total time taken": data.totalTimeTaken,
        "Total unattempted": data.totalQuestions - data.totalAttempted,
        "attempted date": today,
        submittedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      showLogs('✅ Attempt summary queued to save.');

      // e) SAVE each question (unchanged from original code)
      showLogs(`✍️ Saving ${ (data.attemptedQuestions || []).length } attempted questions under ${attemptRef.path}/questions`);
      (data.attemptedQuestions || []).forEach(q => {
        const qRef = attemptRef.collection('questions').doc(q.firestoreDocId);
        transaction.set(qRef, {
          isAttempted: true,
          wasCorrect: q.wasCorrect,
          chosenOption: q.chosenOption,
          timeTakenSec: q.timeTakenSec,
          attemptedAt: admin.firestore.FieldValue.serverTimestamp(),
          subject: q.subject || '',
          chapter: q.chapter || '',
          questionID: q.questionID
        }, { merge: true });
        showLogs(`  ➤ Question queued: ${q.questionID} -> ${qRef.path} (wasCorrect: ${q.wasCorrect})`);
      });
      showLogs('✅ All question writes queued in transaction.');

      // f) UPDATE per-chapter analysis using the snapshots (unchanged from original code)
      showLogs('📈 Updating per-chapter analysis...');
      (data.attemptedQuestions || []).forEach(q => {
        if (!q.chapter) {
          showLogs(`⚠️ Skipping chapter analysis for question ${q.questionID} due to missing chapter.`);
          return;
        }
        const idx = chapters.indexOf(q.chapter);
        const snap = chapterSnaps[idx];
        const oldData = snap.data() || {};
        const chapterRef = chapterRefs[idx];
        transaction.set(chapterRef, {
          totalCorrect: (oldData.totalCorrect || 0) + (q.wasCorrect ? 1 : 0),
          totalWrong: (oldData.totalWrong || 0) + (q.wasCorrect ? 0 : 1),
          totalTimeTaken: (oldData.totalTimeTaken || 0) + q.timeTakenSec,
          timeTakenInCorrect: (oldData.timeTakenInCorrect || 0) + (q.wasCorrect ? q.timeTakenSec : 0),
          timeTakenInWrong: (oldData.timeTakenInWrong || 0) + (q.wasCorrect ? 0 : q.timeTakenSec)
        }, { merge: true });
        showLogs(`  ➤ Chapter analysis queued for chapter "${q.chapter}" (question ${q.questionID}).`);
      });
      showLogs('✅ Chapter analysis writes queued.');

      // g) Leaderboard updates (New additions based on your request)
      showLogs('🏆 Calculating leaderboard metrics...');

      // Calculate MockScore and TimeAccuracy for leaderboardMock
      const mockScore = data.totalAttempted > 0 ? (data.totalCorrect / data.totalAttempted) : 0;
      const totalTimeAttemptedForMock = (data.timeTakenForCorrectMockQuestions || 0) + (data.timeTakenForWrongMockQuestions || 0);
      const mockTimeAccuracy = totalTimeAttemptedForMock > 0 ? (data.timeTakenForCorrectMockQuestions || 0) / totalTimeAttemptedForMock : 0;

      showLogs(`  • mockScore=${mockScore.toFixed(4)}, mockTimeAccuracy=${mockTimeAccuracy.toFixed(4)}`);
      transaction.set(leaderboardMockRef, {
        MockScore: parseFloat(mockScore.toFixed(2)),
        displayName: data.name,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        TimeAccuracy: parseFloat(mockTimeAccuracy.toFixed(2))
      }, { merge: true });
      showLogs(`✅ leaderboardMock queued to update at ${leaderboardMockRef.path}`);

      // Calculate combined scores for leaderboardCombined
      const totalCorrectReels = userData.TotalcorrectReels || 0;
      const totalWrongReels = userData.TotalwrongReels || 0;
      const timeTakenForCorrectReelQuestions = userData.TotaltimeforCorrectReelsQuestions || 0;
      const timeTakenForWrongReelQuestions = userData.TotaltimeforWrongReelsQuestions || 0;

      const totalCorrectCombined = (userData.TotalcorrectMocks || 0) + totalCorrectReels;
      const totalAttemptedCombined =
        (userData.TotalcorrectMocks || 0) + (userData.TotalwrongMocks || 0) +
        totalCorrectReels + totalWrongReels;

      const totalTimeTakenCorrectCombined = (userData.TotaltimeforCorrectMockQuestions || 0) + timeTakenForCorrectReelQuestions;
      const totalTimeTakenAttemptedCombined =
        (userData.TotaltimeforCorrectMockQuestions || 0) + (userData.TotaltimeforWrongMockQuestions || 0) +
        timeTakenForCorrectReelQuestions + timeTakenForWrongReelQuestions;

      const combinedScore = totalAttemptedCombined > 0 ? (totalCorrectCombined / totalAttemptedCombined) : 0;
      const combinedTimeAccuracy = totalTimeTakenAttemptedCombined > 0 ? (totalTimeTakenCorrectCombined / totalTimeTakenAttemptedCombined) : 0;

      showLogs(`  • combinedScore=${combinedScore.toFixed(4)}, combinedTimeAccuracy=${combinedTimeAccuracy.toFixed(4)}`);
      transaction.set(leaderboardCombinedRef, {
        totalScore: parseFloat(combinedScore.toFixed(2)),
        displayName: data.name,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        TimeAccuracy: parseFloat(combinedTimeAccuracy.toFixed(2))
      }, { merge: true });
      showLogs(`✅ leaderboardCombined queued to update at ${leaderboardCombinedRef.path}`);

      showLogs('🔁 Transaction work queued — ready to commit by Firestore.');
    });

    showLogs("✅ Firestore transaction complete.");

    res.json({ message: "Test submitted successfully" });
  } catch (error) {
    showLogs(`❌ Error submitting test for user ${user_id} on mock ${mock_id}:`);
    showLogs(error);
    res.status(500).json({ error: `Failed to submit test: ${error.message}` });
  }
});

router.delete('/:mock_id/responses/:user_id', async (req, res) => {
  try {
    const { mock_id, user_id } = req.params;
    const userResponseDocRef = db.collection("mocks").doc(mock_id).collection("Responses").doc(user_id);
    const userIncorrectDocRef = db.collection("users").doc(user_id).collection("incorrect_responses").doc(mock_id);
    const userMockAttemptDocRef = db.collection('users').doc(user_id).collection('mockAttempts').doc(mock_id);

    await userResponseDocRef.delete();
    showLogs(`✅ User response document deleted for user ${user_id} on mock ${mock_id}.`);
    await userIncorrectDocRef.delete();
    showLogs(`✅ User incorrect responses document deleted for user ${user_id} on mock ${mock_id}.`);

    // Also delete the mock attempt subcollection for the user
    // To delete a subcollection, you need to delete all documents within it first.
    // This is a common Firestore pattern for recursive deletes.
    const questionsSnapshot = await userMockAttemptDocRef.collection('questions').get();
    const batch = db.batch();
    questionsSnapshot.forEach(doc => {
      batch.delete(doc.ref);
    });
    await batch.commit(); // Delete all questions in the subcollection

    await userMockAttemptDocRef.delete(); // Delete the mock attempt document itself
    showLogs(`✅ User mock attempt data deleted for user ${user_id} on mock ${mock_id}.`);


    res.json({ message: "Previous responses deleted successfully" });
  } catch (error) {
    showLogs(`❌ Error deleting responses for user ${user_id} on mock ${mock_id}:`, error);
    res.status(500).json({ error: `Failed to delete previous responses: ${error.message}` });
  }
});

router.get('/toppers/:mockId', async (req, res) => {
  const startTime = Date.now();
  const mockId = req.params.mockId;

  showLogs(`🔍 Backend: Received request for mock ID: ${mockId}`);

  if (!mockId) {
    showLogs('🚫 Bad Request: mock_id missing');
    return res.status(400).json({ error: 'Mock ID is required.' });
  }

  try {
    const responsesCollectionRef = db.collection(`mocks`).doc(mockId).collection("Responses");
    showLogs(`🔍 Backend: Firestore path: mocks/${mockId}/Responses`);

    const firestoreQueryStartTime = Date.now();
    const snapshot = await responsesCollectionRef.get();
    const firestoreQueryEndTime = Date.now();
    showLogs(`📊 Backend: Firestore query time: ${firestoreQueryEndTime - firestoreQueryStartTime} ms`);

    if (snapshot.empty) {
      showLogs(`ℹ️ Backend: No docs for mocks/${mockId}/Responses`);
      return res.status(200).json([]); // Return empty array if no data
    }

    showLogs(`Backend: Found ${snapshot.size} response docs`);
    const allSubmitted = [];
    let submitted = 0, skipped = 0;

    snapshot.forEach(doc => {
      try {
        const data = doc.data();
        showLogs(`Backend: Processing doc ${doc.id}: isTestSubmitted=${data.isTestSubmitted}, totalQuestions=${data.totalQuestions}, name=${data.name}`);
        if (data.isTestSubmitted) {
          submitted++;
          allSubmitted.push({
            userId: doc.id,
            name: data.name ?? `guest_${doc.id.slice(0, 8)}`,
            totalQuestions: data.totalQuestions ?? 0,
            totalAttempted: data.totalAttempted ?? 0,
            totalCorrect: data.totalCorrect ?? 0,
            totalTimeTaken: data.totalTimeTaken ?? 0,
          });
          showLogs(`✔️ Backend: Included user ${doc.id}`);
        } else {
          skipped++;
          showLogs(`⏭️ Backend: Skipped user ${doc.id} (not submitted)`);
        }
      } catch (innerErr) {
        showLogs(`❌ Backend: Error processing doc ${doc.id}: ${innerErr.stack || innerErr}`);
        skipped++;
      }
    });

    showLogs(`Backend Summary: ${submitted} submitted, ${skipped} skipped`);
    const totalTime = Date.now() - startTime;
    showLogs(`⏱️ Backend Function total time: ${totalTime} ms`);

    // Send the processed data back to the frontend
    return res.status(200).json(allSubmitted);

  } catch (error) {
    const stack = error.stack || String(error);
    showLogs(`❗ Backend: Error fetching toppers data after ${Date.now() - startTime}ms:`, error);
    if (error.code) {
      showLogs(`❌ Backend Firestore (${error.code}):\n${stack}`);
      return res.status(500).json({ error: `Firestore error: ${error.message}` });
    } else {
      showLogs(`❌ Backend General Error:\n${stack}`);
      return res.status(500).json({ error: `Server error: ${error.message}` });
    }
  }
});

export default router;