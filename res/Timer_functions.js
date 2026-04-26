import fsSync from 'fs';
import path from 'path';
import fs from 'fs/promises';
import { showLogs } from '../lib/logs.js';
import CryptoJS from 'crypto-js';
import { safeReadJSON, safeWriteJSON } from '../lib/fileStore.js';
import { db, rtDb, admin, auth } from '../lib/firebase.js';
import { actualKey, invalidQuestionOverrides, ONE_DAY_IN_MS, SEVEN_DAYS_MS, THREE_MONTHS_MS, SUMMARY_RECENT_LIMIT, questionBank } from '../server.js';
import { saveDeletedUserData } from './local_file_functions.js';
import { userLoginDataStore } from '../lib/firestoreStore.js';

showLogs("🔹 Server maintenance module loading...");

const randomInt = (min, max) => {
  const result = Math.floor(Math.random() * (max - min + 1)) + min;
  showLogs(`🔹 randomInt called: min=${min}, max=${max}, result=${result}`);
  return result;
};

function _normalizeString(s) {
  showLogs(`🔹 _normalizeString called with:`, s);
  if (s === undefined || s === null) return '';
  const result = String(s).trim().replace(/\s+/g, ' ').toLowerCase();
  showLogs(`🔹 _normalizeString result:`, result);
  return result;
}

const timestampToMs = (timestamp) => {
  showLogs(`🔹 timestampToMs called with:`, timestamp);
  if (timestamp instanceof admin.firestore.Timestamp) {
    const result = timestamp.toMillis();
    showLogs(`🔹 timestampToMs converted Firestore Timestamp to:`, result);
    return result;
  }
  showLogs(`🔹 timestampToMs returning as-is:`, timestamp);
  return timestamp; // Return as is if not a Timestamp object
};

export async function deleteUnwantedUsers() {
  showLogs("🔹 deleteUnwantedUsers function started");
  try {
    const adminUid = 'bKfDQMvjQLWoNoShAlyu8mXh8Nz1';
    showLogs(`🔹 Admin UID configured: ${adminUid}`);

    // only allow the configured admin to run this
    const callerUid = adminUid;
    showLogs(`🔹 Caller UID: ${callerUid}`);

    const cutoffMs = Date.now() - (5 * ONE_DAY_IN_MS); // 3 days
    showLogs(`🔐 Admin cleanup started by ${callerUid}. Deleting all users inactive since ${new Date(cutoffMs).toISOString()}`);

    // Query all users without filtering by isGuest
    showLogs("🔹 Querying all users from Firestore...");
    const usersSnap = await db.collection('users').get();
    showLogs(`🔹 Users snapshot size: ${usersSnap.size}`);
    
    if (usersSnap.empty) {
      showLogs('ℹ️ No users found in Firestore.');
      return showLogs('Admin cleanup finished - no users found');
    }

    const archiveBase = path.resolve(process.cwd(), 'user_deletions_archive');
    showLogs(`🔹 Archive base path: ${archiveBase}`);
    
    if (!fsSync.existsSync(archiveBase)) {
      showLogs("🔹 Creating archive directory...");
      fsSync.mkdirSync(archiveBase, { recursive: true });
      showLogs("✅ Archive directory created");
    }

    const results = { checked: 0, candidates: 0, deleted: [], errors: [] };
    showLogs("🔹 Results tracker initialized");

    function archiveAndRemoveServerFilesForUid(uid, destDir) {
      showLogs(`🔹 archiveAndRemoveServerFilesForUid called for UID: ${uid}, destDir: ${destDir}`);
      const candidatesDirs = [
        logsDir,
        path.join(process.cwd(), 'PYQs'),
        path.join(process.cwd(), 'user_files'),
        path.join(process.cwd(), 'uploads'),
        path.join(process.cwd(), 'data')
      ];
      showLogs(`🔹 Candidate directories:`, candidatesDirs);
      
      try { 
        fsSync.mkdirSync(destDir, { recursive: true }); 
        showLogs(`✅ Destination directory created: ${destDir}`);
      } catch (e) { 
        showLogs(`❌ Failed to create destination directory: ${e.message}`);
      }

      for (const dir of candidatesDirs) {
        showLogs(`🔹 Processing directory: ${dir}`);
        try {
          if (!fsSync.existsSync(dir)) {
            showLogs(`ℹ️ Directory doesn't exist, skipping: ${dir}`);
            continue;
          }
          
          const walk = (d) => {
            showLogs(`🔹 Walking directory: ${d}`);
            const entries = fsSync.readdirSync(d, { withFileTypes: true });
            showLogs(`🔹 Found ${entries.length} entries in ${d}`);
            
            for (const ent of entries) {
              const full = path.join(d, ent.name);
              showLogs(`🔹 Processing entry: ${full}`);
              
              if (ent.isDirectory()) {
                showLogs(`🔹 Entry is directory, recursing...`);
                walk(full);
                continue;
              }
              
              if (ent.name.includes(uid)) {
                showLogs(`🔹 Found file matching UID: ${full}`);
                const rel = path.relative(process.cwd(), full);
                const destPath = path.join(destDir, rel);
                showLogs(`🔹 Destination path: ${destPath}`);
                
                try {
                  fsSync.mkdirSync(path.dirname(destPath), { recursive: true });
                  showLogs(`✅ Created destination directory structure`);
                  
                  fsSync.copyFileSync(full, destPath);
                  showLogs(`✅ File copied to archive`);
                  
                  try { 
                    fsSync.unlinkSync(full); 
                    showLogs(`✅ Original file deleted: ${full}`);
                  } catch (e) { 
                    showLogs('⚠️ Failed to delete original file:', `Failed to delete file ${full}: ${e.message}`); 
                  }
                  
                  showLogs(`📦 Archived & removed server file: ${full} → ${destPath}`);
                } catch (e) {
                  showLogs('❌ Archive copy failed:', `archive copy failed for ${full}: ${e.message}`);
                }
              }
            }
          };
          walk(dir);
        } catch (err) {
          showLogs('❌ Archive traversal failed:', `archive traversal failed for ${dir}: ${err.message}`);
        }
      }
    }

    showLogs(`🔹 Starting user processing loop for ${usersSnap.size} users...`);
    for (const doc of usersSnap.docs) {
      results.checked++;
      const uid = doc.id;
      const data = doc.data() || {};
      
      showLogs(`🔹 Processing user ${results.checked}/${usersSnap.size}: ${uid}`);

      let lastActiveMs = 0;
      if (data.lastActive) lastActiveMs = timestampToMs(data.lastActive);
      else if (data.updatedAt) lastActiveMs = timestampToMs(data.updatedAt);
      else if (data.lastLogin) lastActiveMs = Number(data.lastLogin) || 0;
      else if (data.creationTime) lastActiveMs = Number(data.creationTime) || 0;

      if (!lastActiveMs) lastActiveMs = 0;
      
      showLogs(`🔹 User ${uid} last active: ${new Date(lastActiveMs).toISOString()}, cutoff: ${new Date(cutoffMs).toISOString()}`);

      if (lastActiveMs <= cutoffMs) {
        results.candidates++;
        showLogs(`🛠 Candidate for deletion: ${uid} (lastActive: ${new Date(lastActiveMs).toISOString()})`);

        // 1) Backup Firestore + RTDB + subcollections
        showLogs(`🔹 Starting backup process for ${uid}...`);
        try {
          const saved = await saveDeletedUserData(uid);
          if (!saved.success) {
            showLogs(`⚠️ saveDeletedUserData returned failure for ${uid}`);
          } else {
            showLogs(`✅ Firestore+RTDB snapshot saved for ${uid}`);
          }
        } catch (err) {
          showLogs(`❌ saveDeletedUserData threw for ${uid}: ${err.message || err}`);
        }

        // 2) Archive server files
        showLogs(`🔹 Starting server file archiving for ${uid}...`);
        try {
          const destDir = path.join(archiveBase, uid, `${Date.now()}`);
          showLogs(`🔹 Archive destination: ${destDir}`);
          archiveAndRemoveServerFilesForUid(uid, destDir);
          showLogs(`✅ Server file archiving completed for ${uid}`);
        } catch (err) {
          showLogs(`⚠️ Archive failure for ${uid}: ${err.message || err}`);
        }

        // 3) Delete ranking docs
        showLogs(`🔹 Starting ranking document deletion for ${uid}...`);
        try {
          const lbs = ['leaderboardReels', 'leaderboardMock', 'leaderboardCombined', 'bubbleGame'];
          showLogs(`🔹 Deleting from leaderboards:`, lbs);
          for (const lb of lbs) {
            try {
              showLogs(`🔹 Deleting from leaderboard: ${lb}`);
              await db.collection('ranking').doc(lb).collection('users').doc(uid).delete().catch(() => { });
              showLogs(`✅ Deleted from leaderboard: ${lb}`);
            } catch (e) {
              showLogs('⚠️ Failed to delete ranking:', `Failed to delete ranking ${lb} doc for ${uid}: ${e.message || e}`);
            }
          }
          showLogs(`✅ Ranking document deletion completed for ${uid}`);
        } catch (err) {
          showLogs('⚠️ Ranking deletion failed:', `ranking deletion failed for ${uid}: ${err.message || err}`);
        }

        // 4) Delete Realtime DB entry
        showLogs(`🔹 Starting Realtime Database deletion for ${uid}...`);
        try {
          await rtDb.ref(`users/${uid}`).remove().catch(e => {
            showLogs('⚠️ RTDB remove failed:', `RTDB remove failed for ${uid}: ${e.message || e}`);
          });
          showLogs(`✅ Realtime Database deletion completed for ${uid}`);
        } catch (err) {
          showLogs('⚠️ RTDB deletion threw:', `RTDB deletion threw for ${uid}: ${err.message || err}`);
        }

        // 5) Delete Firestore user doc
        showLogs(`🔹 Starting Firestore user document deletion for ${uid}...`);
        try {
          await db.collection('users').doc(uid).delete().catch(e => {
            showLogs('⚠️ Firestore delete failed:', `Firestore delete user doc failed for ${uid}: ${e.message || e}`);
          });
          showLogs(`✅ Firestore user document deletion completed for ${uid}`);
        } catch (err) {
          showLogs('⚠️ Firestore deletion threw:', `Firestore deletion threw for ${uid}: ${err.message || err}`);
        }

        // 6) Delete Auth user
        showLogs(`🔹 Starting Auth user deletion for ${uid}...`);
        try {
          await auth.deleteUser(uid).catch(e => {
            showLogs('⚠️ Auth delete failed:', `auth.deleteUser failed for ${uid}: ${e.message || e}`);
          });
          showLogs(`✅ Auth user deletion completed for ${uid}`);
        } catch (err) {
          showLogs('⚠️ Auth deletion threw:', `auth.deleteUser threw for ${uid}: ${err.message || err}`);
        }

        // 7) Sanitize userLoginDataFile
        showLogs(`🔹 Starting userLoginData sanitization for ${uid}...`);
        try {
          const allUserLoginData = await userLoginDataStore.readAll();
          showLogs(`🔹 Retrieved ${Object.keys(allUserLoginData).length} user login data entries`);
          let changed = false;
          
          for (const [key, data] of Object.entries(allUserLoginData)) {
            if (data && data.uid === uid) {
              showLogs(`🔹 Found user ${uid} in login data with key: ${key}, deleting...`);
              await userLoginDataStore.delete(key);
              changed = true;
              showLogs(`✅ Deleted user login data entry: ${key}`);
            }
          }
          
          if (changed) {
            showLogs(`✅ Removed user ${uid} from userLoginData in Firestore`);
          } else {
            showLogs(`ℹ️ User ${uid} not found in userLoginData`);
          }
        } catch (err) {
          showLogs('⚠️ Failed to sanitize userLoginData:', `Failed to sanitize userLoginData in Firestore for ${uid}: ${err.message || err}`);
        }

        results.deleted.push(uid);
        showLogs(`✅ Completed deletion workflow for ${uid}`);
      } else {
        showLogs(`ℹ️ User ${uid} is active, skipping deletion`);
      }
    }

    showLogs(`🔚 Admin cleanup finished. Checked=${results.checked}, Candidates=${results.candidates}, Deleted=${results.deleted.length}`);
    showLogs(`📊 Deleted users:`, results.deleted);
    return showLogs('✅ Admin cleanup finished successfully');
  } catch (err) {
    showLogs('❌ Admin cleanup failed:', err);
    showLogs('❌ Error stack:', err.stack);
    return showLogs(err.message || String(err));
  }
}

export async function loadInvalidQuestionReport() {
  showLogs("🔹 loadInvalidQuestionReport function started");
  try {
    const rptPath = path.resolve(process.cwd(), './local created files/invalid_questions_report.json');
    showLogs(`🔹 Looking for report file at: ${rptPath}`);
    
    const raw = await fs.readFile(rptPath, 'utf8');
    showLogs(`✅ Report file found and read, size: ${raw.length} bytes`);
    
    const report = JSON.parse(raw);
    showLogs(`🔹 Report parsed, errors array length: ${Array.isArray(report.errors) ? report.errors.length : 'N/A'}`);
    
    if (Array.isArray(report.errors)) {
      let overrideCount = 0;
      for (const e of report.errors) {
        if (!e.QuestionID) {
          showLogs(`⚠️ Skipping error entry without QuestionID:`, e);
          continue;
        }
        showLogs(`🔹 Processing error for QuestionID: ${e.QuestionID}, language: ${e.language}`);
        invalidQuestionOverrides[e.QuestionID] = invalidQuestionOverrides[e.QuestionID] || {};
        // Store minimal useful fields: optionsRaw and answerRaw
        invalidQuestionOverrides[e.QuestionID][e.language] = {
          options: Array.isArray(e.optionsRaw) ? e.optionsRaw.filter(Boolean) : (e.optionsRaw || []),
          answer: e.answerRaw ?? ''
        };
        overrideCount++;
        showLogs(`✅ Added override for ${e.QuestionID}[${e.language}]`);
      }
      showLogs(`✅ Loaded ${overrideCount} invalid-question override entries from ${rptPath}`);
    } else {
      showLogs(`⚠️ Report does not contain errors array`);
    }
  } catch (err) {
    showLogs(`ℹ️ No invalid_questions_report.json loaded (ok if none): ${err.message}`);
  }
}

export async function validateQuestionBankAll(batchSize = 1000) {
  showLogs("🔹 validateQuestionBankAll function started");
  const total = Array.isArray(questionBank) ? questionBank.length : 0;
  const errors = [];
  const reportPath = path.resolve(process.cwd(), './local created files/invalid_questions_report.json');

  showLogs(`🔎 Starting validation of ${total} questions (batchSize=${batchSize})`);

  for (let start = 0; start < total; start += batchSize) {
    const end = Math.min(start + batchSize, total);
    showLogs(`🔁 Validating questions ${start + 1} → ${end} ...`);

    for (let i = start; i < end; i++) {
      const qEntry = questionBank[i];
      showLogs(`🔹 Processing question ${i + 1}/${total}, QuestionID: ${qEntry?.QuestionID || 'unknown'}`);

      if (!qEntry) {
        showLogs(`❌ Question entry missing at index ${i}`);
        errors.push({ index: i, reason: 'Missing question entry', QuestionID: qEntry?.QuestionID || null });
        continue;
      }

      try {
        // decrypt
        if (!qEntry.cipherText) {
          showLogs(`❌ No cipherText present for question ${i}`);
          errors.push({ index: i, QuestionID: qEntry.QuestionID, reason: 'No cipherText present' });
          continue;
        }
        
        showLogs(`🔹 Decrypting question ${i}...`);
        const bytes = CryptoJS.AES.decrypt(qEntry.cipherText, actualKey);
        const jsonString = bytes.toString(CryptoJS.enc.Utf8);
        
        if (!jsonString) {
          showLogs(`❌ Decryption produced empty string for question ${i}`);
          errors.push({ index: i, QuestionID: qEntry.QuestionID, reason: 'Decryption produced empty string' });
          continue;
        }
        
        showLogs(`🔹 Parsing decrypted JSON for question ${i}...`);
        const parsed = JSON.parse(jsonString);
        showLogs(`✅ Successfully decrypted and parsed question ${i}`);

        // collect options (keep originals for reporting)
        const rawOptionsHindi = [parsed.OptionA, parsed.OptionB, parsed.OptionC, parsed.OptionD].filter(o => o !== undefined && o !== null);
        const rawOptionsEng = [parsed.OptionA_Eng, parsed.OptionB_Eng, parsed.OptionC_Eng, parsed.OptionD_Eng].filter(o => o !== undefined && o !== null);

        showLogs(`🔹 Hindi options (raw):`, rawOptionsHindi);
        showLogs(`🔹 English options (raw):`, rawOptionsEng);

        const normOptionsHindi = rawOptionsHindi.map(_normalizeString);
        const normOptionsEng = rawOptionsEng.map(_normalizeString);

        const ansHindiRaw = parsed.Answer;
        const ansEngRaw = parsed.Answer_Eng;
        const normAnsHindi = _normalizeString(ansHindiRaw);
        const normAnsEng = _normalizeString(ansEngRaw);

        showLogs(`🔹 Hindi answer: raw="${ansHindiRaw}", normalized="${normAnsHindi}"`);
        showLogs(`🔹 English answer: raw="${ansEngRaw}", normalized="${normAnsEng}"`);

        // Check Hindi answer presence (if provided)
        if (ansHindiRaw !== undefined && ansHindiRaw !== null && String(ansHindiRaw).trim() !== '') {
          const matchExactHindi = rawOptionsHindi.includes(ansHindiRaw);
          const matchNormHindi = normOptionsHindi.includes(normAnsHindi);
          showLogs(`🔹 Hindi answer check - exact match: ${matchExactHindi}, normalized match: ${matchNormHindi}`);

          if (!matchExactHindi && !matchNormHindi) {
            showLogs(`❌ Hindi answer validation failed for question ${i}`);
            errors.push({
              index: i,
              QuestionID: qEntry.QuestionID,
              language: 'hindi',
              answerRaw: ansHindiRaw,
              normalizedAnswer: normAnsHindi,
              optionsRaw: rawOptionsHindi,
              optionsNormalized: normOptionsHindi,
              reason: 'Answer not found in options (exact or normalized)'
            });
          } else {
            showLogs(`✅ Hindi answer validation passed for question ${i}`);
          }
        } else {
          showLogs(`ℹ️ No Hindi answer provided for question ${i}`);
        }

        // Check English answer presence (if provided)
        if (ansEngRaw !== undefined && ansEngRaw !== null && String(ansEngRaw).trim() !== '') {
          const matchExactEng = rawOptionsEng.includes(ansEngRaw);
          const matchNormEng = normOptionsEng.includes(normAnsEng);
          showLogs(`🔹 English answer check - exact match: ${matchExactEng}, normalized match: ${matchNormEng}`);

          if (!matchExactEng && !matchNormEng) {
            showLogs(`❌ English answer validation failed for question ${i}`);
            errors.push({
              index: i,
              QuestionID: qEntry.QuestionID,
              language: 'english',
              answerRaw: ansEngRaw,
              normalizedAnswer: normAnsEng,
              optionsRaw: rawOptionsEng,
              optionsNormalized: normOptionsEng,
              reason: 'Answer not found in options (exact or normalized)'
            });
          } else {
            showLogs(`✅ English answer validation passed for question ${i}`);
          }
        } else {
          showLogs(`ℹ️ No English answer provided for question ${i}`);
        }

      } catch (err) {
        showLogs(`❌ Exception processing question ${i}:`, err.message);
        errors.push({
          index: i,
          QuestionID: qEntry.QuestionID,
          reason: 'Exception during decrypt/parse/validate',
          error: err && err.message ? err.message : String(err)
        });
      }
    } // end inner for
  } // end batches

  // Write a report file so you can inspect offline
  showLogs(`📝 Writing validation report to: ${reportPath}`);
  try {
    const report = {
      generatedAt: new Date().toISOString(),
      totalQuestions: total,
      errorsCount: errors.length,
      errors
    };
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
    showLogs(`✅ Validation completed: ${errors.length} issues found. Report saved to ${reportPath}`);
    return { totalQuestions: total, errorsCount: errors.length, reportPath, errorsSummary: errors.slice(0, 30) };
  } catch (writeErr) {
    showLogs('❌ Failed to write report file:', writeErr);
    return { totalQuestions: total, errorsCount: errors.length, reportPath: null, writeError: writeErr.message };
  }
}

export async function updateAllRanks() {
  showLogs("🔹 updateAllRanks function started (safe, corrected version)...");
  try {
    showLogs("🔹 Fetching all users from Firestore...");
    const usersSnapshot = await db.collection("users").get();
    showLogs(`🔹 Retrieved ${usersSnapshot.size} users from Firestore`);
    
    const usersData = [];

    usersSnapshot.forEach(doc => {
      const userId = doc.id;
      const d = doc.data() || {};
      showLogs(`🔹 Processing user ${userId}: ${d.displayName || 'Unknown'}`);

      // inside updateAllRanks user loop
      const totalPYQAttempts = Number(d.TotalcorrectPYQs || 0) + Number(d.TotalwrongPYQs || 0);
      const pyqScore = totalPYQAttempts > 0 ? parseFloat(((Number(d.TotalcorrectPYQs || 0) / totalPYQAttempts) * 100).toFixed(2)) : 0;
      showLogs(`🔹 User ${userId} PYQ score: ${pyqScore}`);

      // --- Reels ---
      const totalReelAttempts = Number(d.TotalcorrectReels || 0) + Number(d.TotalwrongReels || 0);
      const reelScore = totalReelAttempts > 0 ? parseFloat(((Number(d.TotalcorrectReels || 0) / totalReelAttempts) * 100).toFixed(2)) : 0;
      const reelTimeAccuracy = (Number(d.TotalcorrectReels || 0) > 0 && Number(d.TotaltimeforCorrectReelsQuestions || 0) > 0)
        ? parseFloat((Number(d.TotaltimeforCorrectReelsQuestions || 0) / Number(d.TotalcorrectReels || 0)).toFixed(2))
        : 0;
      showLogs(`🔹 User ${userId} Reels - score: ${reelScore}, time accuracy: ${reelTimeAccuracy}`);

      // --- Mocks ---
      const totalMockAttempts = Number(d.TotalcorrectMocks || 0) + Number(d.TotalwrongMocks || 0);
      const mockScore = totalMockAttempts > 0 ? parseFloat(((Number(d.TotalcorrectMocks || 0) / totalMockAttempts) * 100).toFixed(2)) : 0;
      const mockTimeAccuracy = (Number(d.TotalcorrectMocks || 0) > 0 && Number(d.TotaltimeforCorrectMockQuestions || 0) > 0)
        ? parseFloat((Number(d.TotaltimeforCorrectMockQuestions || 0) / Number(d.TotalcorrectMocks || 0)).toFixed(2))
        : 0;
      showLogs(`🔹 User ${userId} Mocks - score: ${mockScore}, time accuracy: ${mockTimeAccuracy}`);

      // --- Combined (reels + mocks) ---
      const totalCombinedCorrect = Number(d.TotalcorrectReels || 0) + Number(d.TotalcorrectMocks || 0);
      const totalCombinedWrong = Number(d.TotalwrongReels || 0) + Number(d.TotalwrongMocks || 0);
      const totalCombinedAttempted = totalCombinedCorrect + totalCombinedWrong;
      const totalCombinedCorrectTime = Number(d.TotaltimeforCorrectReelsQuestions || 0) + Number(d.TotaltimeforCorrectMockQuestions || 0);
      const combinedScore = totalCombinedAttempted > 0 ? parseFloat(((totalCombinedCorrect / totalCombinedAttempted) * 100).toFixed(2)) : 0;
      const combinedTimeAccuracy = totalCombinedCorrect > 0 ? parseFloat((totalCombinedCorrectTime / totalCombinedCorrect).toFixed(2)) : 0;
      showLogs(`🔹 User ${userId} Combined - score: ${combinedScore}, time accuracy: ${combinedTimeAccuracy}`);

      // --- Bubble: flexible calculation (attempt-based if available, otherwise fallbacks) ---
      const totalBubbleCorrect = Number(d.TotalcorrectBubbles || d.TotalcorrectBubble || 0);
      const totalBubbleWrong = Number(d.TotalwrongBubbles || d.TotalwrongBubble || 0);
      const totalBubbleAttempts = totalBubbleCorrect + totalBubbleWrong;
      let bubbleScore = 0;
      if (totalBubbleAttempts > 0) {
        bubbleScore = parseFloat(((totalBubbleCorrect / totalBubbleAttempts) * 100).toFixed(2));
      } else {
        // fallback to stored fields if present
        bubbleScore = Number(d.bubbleScore || d.score || 0);
      }
      showLogs(`🔹 User ${userId} Bubble - score: ${bubbleScore}, attempts: ${totalBubbleAttempts}`);

      // Bubble time accuracy - try multiple known fields
      const timeCorrectBubble = Number(d.TotaltimeforCorrectBubbleQuestions || d.TotaltimeforCorrectBubbles || d.timeCorrectBubble || 0);
      const timeWrongBubble = Number(d.TotaltimeforWrongBubbleQuestions || d.TotaltimeforWrongBubbles || d.timeWrongBubble || 0);
      const totalTimeBubbleAttempts = timeCorrectBubble + timeWrongBubble;
      const bubbleTimeAccuracy = totalTimeBubbleAttempts > 0 ? parseFloat((timeCorrectBubble / totalTimeBubbleAttempts).toFixed(2)) : 0;

      // xp/level/rawScore fallbacks
      const bubbleXp = Number(d.xp || d.bubbleXp || 0);
      const bubbleLevel = Number(d.level || d.bubbleLevel || 0);
      const bubbleRawScore = Number(d.score || d.bubbleRawScore || 0);

      usersData.push({
        uid: userId,
        displayName: d.displayName || "Unknown",
        // pyqs
        pyqScore,
        pyqTimeAccuracy: 0, // or compute if you track time accuracy for PYQs
        // reels
        reelScore,
        reelTimeAccuracy,
        // mocks
        mockScore,
        mockTimeAccuracy,
        // combined
        totalScore: combinedScore,
        combinedTimeAccuracy,
        // bubble
        bubbleScore,
        bubbleTimeAccuracy,
        xp: bubbleXp,
        level: bubbleLevel,
        bubbleRawScore
      });

      showLogs(`✅ User ${userId} metrics calculated and added to dataset`);
    });

    showLogs(`🔹 Calculated metrics for ${usersData.length} users. Preparing leaderboards...`);

    // --- PYQ leaderboard ---
    showLogs("🔹 Sorting users for PYQ leaderboard...");
    const sortedUsersByPyq = usersData.slice().sort((a, b) => {
      if (b.pyqScore !== a.pyqScore) return b.pyqScore - a.pyqScore;
      return a.pyqTimeAccuracy - b.pyqTimeAccuracy;
    });
    await updateLeaderboard('leaderboardPYQ', sortedUsersByPyq, 'pyqScore', 'pyqTimeAccuracy', 'rankInPYQs');

    // --- Reels leaderboard ---
    showLogs("🔹 Sorting users for Reels leaderboard...");
    const reelsLeaderboard = usersData.slice().sort((a, b) => {
      if (b.reelScore !== a.reelScore) return b.reelScore - a.reelScore;
      return a.reelTimeAccuracy - b.reelTimeAccuracy;
    });
    await updateLeaderboard('leaderboardReels', reelsLeaderboard, 'reelScore', 'reelTimeAccuracy', 'rankInReels');

    // --- Mock leaderboard ---
    showLogs("🔹 Sorting users for Mock leaderboard...");
    const mockLeaderboard = usersData.slice().sort((a, b) => {
      if (b.mockScore !== a.mockScore) return b.mockScore - a.mockScore;
      return a.mockTimeAccuracy - b.mockTimeAccuracy;
    });
    await updateLeaderboard('leaderboardMock', mockLeaderboard, 'mockScore', 'mockTimeAccuracy', 'rankInMocks');

    // --- Combined leaderboard ---
    showLogs("🔹 Sorting users for Combined leaderboard...");
    const combinedLeaderboard = usersData.slice().sort((a, b) => {
      if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
      return a.combinedTimeAccuracy - b.combinedTimeAccuracy;
    });
    // NOTE: elsewhere your code expects `rankCombined` when reading combined ranks (get-user-data). Use that key.
    await updateLeaderboard('leaderboardCombined', combinedLeaderboard, 'totalScore', 'combinedTimeAccuracy', 'rankCombined');

    // --- Bubble leaderboard (special fields) ---
    showLogs("🔹 Sorting users for Bubble leaderboard...");
    const bubbleLeaderboard = usersData.slice().sort((a, b) => {
      if (b.bubbleScore !== a.bubbleScore) return b.bubbleScore - a.bubbleScore;
      if (b.xp !== a.xp) return b.xp - a.xp; // more XP wins tie
      return b.level - a.level; // higher level wins further tie
    });
    await updateBubbleLeaderboard('bubbleGame', bubbleLeaderboard);

    showLogs("✅ Rank calculation and update completed successfully.");
  } catch (err) {
    showLogs("❌ Error in updateAllRanks():", err);
    showLogs("❌ Error stack:", err.stack);
  }
}

export async function dailyHpMaintenance() {
  showLogs('🔁 Running dailyHpMaintenance job...');
  try {
    showLogs('🔹 Fetching all users from Firestore...');
    const usersSnapshot = await db.collection('users').get();
    showLogs(`🔹 Retrieved ${usersSnapshot.size} users from Firestore`);
    
    const nowMs = Date.now();
    showLogs(`🔹 Current time: ${new Date(nowMs).toISOString()}`);

    // We'll accumulate batch updates (Firestore batch) for incremental hp updates
    const batch = db.batch();
    let batchCounter = 0;
    let hpUpdateCount = 0;
    let deletionCount = 0;

    showLogs('🔹 Starting user processing loop...');
    for (const doc of usersSnapshot.docs) {
      const uid = doc.id;
      const data = doc.data() || {};
      showLogs(`🔹 Processing user ${uid}: ${data.displayName || 'Unknown'}`);

      // Determine lastActive in ms. Use lastActive -> updatedAt -> creationTime as fallback.
      let lastActiveMs = 0;
      if (data.lastActive) lastActiveMs = timestampToMs(data.lastActive);
      else if (data.updatedAt) lastActiveMs = timestampToMs(data.updatedAt);
      else if (data.creationTime) lastActiveMs = Number(data.creationTime) || timestampToMs(data.creationTime);
      else lastActiveMs = 0;

      const idleMs = nowMs - lastActiveMs;
      showLogs(`🔹 User ${uid} idle for ${Math.round(idleMs / (24 * 60 * 60 * 1000))} days`);

      // --- Delete inactive user (>= 90 days) but first save their data ---
      if (idleMs > THREE_MONTHS_MS) {
        deletionCount++;
        showLogs(`🗑️ User ${uid} idle >90 days — saving data then deleting.`);
        try {
          // 1) Save snapshot to deletedUsersData.json
          showLogs(`🔹 Saving user data before deletion...`);
          const saved = await saveDeletedUserData(uid);
          if (!saved.success) {
            showLogs(`⚠️ Warning: failed to fully save data for ${uid}. Proceeding with deletion attempt anyway.`);
          } else {
            showLogs(`✅ User data saved successfully`);
          }

          // 2) Delete Firestore user doc
          showLogs(`🔹 Deleting Firestore user document...`);
          await db.collection('users').doc(uid).delete().catch(e => {
            showLogs('⚠️ Firestore delete failed:', `Firestore delete user doc failed for ${uid}: ${e.message || e}`);
          });

          // 3) Delete associated ranking docs (best-effort)
          showLogs(`🔹 Deleting ranking documents...`);
          for (const lb of ['leaderboardReels', 'leaderboardMock', 'leaderboardCombined', 'bubbleGame']) {
            try {
              await db.collection('ranking').doc(lb).collection('users').doc(uid).delete().catch(() => { });
            } catch (e) {
              showLogs('⚠️ Failed to delete ranking:', `Failed to delete ranking ${lb} doc for ${uid}: ${e.message || e}`);
            }
          }

          // 4) Delete Realtime DB entry
          showLogs(`🔹 Deleting Realtime Database entry...`);
          await rtDb.ref(`users/${uid}`).remove().catch(e => {
            showLogs('⚠️ RTDB remove failed:', `RTDB remove failed for ${uid}: ${e.message || e}`);
          });

          // 5) Delete Auth user
          showLogs(`🔹 Deleting Auth user...`);
          await auth.deleteUser(uid).catch(e => {
            showLogs('⚠️ Auth delete failed:', `auth.deleteUser failed for ${uid}: ${e.message || e}`);
          });

          showLogs(`✅ Completed deletion (and backup) for user ${uid}`);
        } catch (err) {
          showLogs(`❌ Error while saving+deleting user ${uid}:`, err.message || err);
        }
        continue; // go to next user
      }

      // 2) If user was active in last 7 days -> increase HP randomly between 500-1000
      if (idleMs <= SEVEN_DAYS_MS) {
        hpUpdateCount++;
        const hpBoost = randomInt(500, 1000);
        showLogs(`🔹 User ${uid} active in last 7 days, boosting HP by ${hpBoost}`);

        const userRef = db.collection('users').doc(uid);
        batch.update(userRef, {
          hp: admin.firestore.FieldValue.increment(hpBoost),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        batchCounter++;
        // Commit in chunks of 400 to be safe (Firestore batch limit is 500)
        if (batchCounter >= 400) {
          showLogs('🔁 Committing intermediate batch for HP updates...');
          await batch.commit();
          showLogs('✅ Intermediate batch committed successfully');
          // create new batch
          batchCounter = 0;
        }
      } else {
        // idle between 7 days and 90 days: do nothing
        showLogs(`ℹ️ User ${uid} idle between 7-90 days, no action taken`);
        continue;
      }
    }

    // Final commit if any
    if (batchCounter > 0) {
      showLogs('🔁 Committing final batch for HP updates...');
      await batch.commit();
      showLogs('✅ Final batch committed successfully');
    }

    showLogs(`✅ dailyHpMaintenance completed. Users processed: ${usersSnapshot.size}, HP updates: ${hpUpdateCount}, Deletions: ${deletionCount}`);
  } catch (err) {
    showLogs('❌ dailyHpMaintenance failed:', err.message || err);
    showLogs('❌ Error stack:', err.stack);
  }
}

export async function updateLeaderboard(collectionName, sortedUsers, scoreKey, timeAccuracyKey, rankKey) {
  showLogs(`🔹 updateLeaderboard called for: ${collectionName}`);
  showLogs(`🔹 Processing ${sortedUsers.length} users, scoreKey: ${scoreKey}, rankKey: ${rankKey}`);
  
  const batch = db.batch();
  const leaderboardCollectionRef = db.collection('ranking').doc(collectionName).collection('users');

  for (let i = 0; i < sortedUsers.length; i++) {
    const user = sortedUsers[i];
    showLogs(`🔹 Updating leaderboard entry ${i + 1}/${sortedUsers.length}: ${user.uid} (${user.displayName})`);
    
    const userDocRef = leaderboardCollectionRef.doc(user.uid);

    const updateData = {
      displayName: user.displayName,
      [scoreKey]: user[scoreKey],
      TimeAccuracy: user[timeAccuracyKey],
      [rankKey]: i + 1,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    showLogs(`🔹 Leaderboard data for ${user.uid}:`, updateData);
    batch.set(userDocRef, updateData, { merge: true });
  }

  try {
    showLogs(`🔹 Committing batch for ${collectionName}...`);
    await batch.commit();
    showLogs(`✅ Leaderboard '${collectionName}' updated with ${sortedUsers.length} users.`);
  } catch (error) {
    showLogs(`❌ Error committing batch for ${collectionName} leaderboard:`, error);
    showLogs(`❌ Error details:`, error.message, error.stack);
  }
}

export async function updateBubbleLeaderboard(collectionName, sortedUsers) {
  showLogs(`🔹 updateBubbleLeaderboard called for: ${collectionName}`);
  showLogs(`🔹 Processing ${sortedUsers.length} users for bubble leaderboard`);
  
  const batch = db.batch();
  const leaderboardCollectionRef = db.collection('ranking').doc(collectionName).collection('users');

  for (let i = 0; i < sortedUsers.length; i++) {
    const user = sortedUsers[i];
    showLogs(`🔹 Updating bubble leaderboard entry ${i + 1}/${sortedUsers.length}: ${user.uid} (${user.displayName})`);
    
    const userDocRef = leaderboardCollectionRef.doc(user.uid);

    const updateData = {
      displayName: user.displayName,
      bubbleScore: user.bubbleScore,
      bubbleTimeAccuracy: user.bubbleTimeAccuracy,
      rankInBubble: i + 1,
      xp: user.xp,
      level: user.level,
      score: user.bubbleRawScore,      // keeps backward compatibility with any UI expecting 'score'
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    showLogs(`🔹 Bubble leaderboard data for ${user.uid}:`, updateData);
    batch.set(userDocRef, updateData, { merge: true });
  }

  try {
    showLogs(`🔹 Committing batch for ${collectionName}...`);
    await batch.commit();
    showLogs(`✅ Leaderboard '${collectionName}' updated with ${sortedUsers.length} users (bubble).`);
  } catch (error) {
    showLogs(`❌ Error committing batch for ${collectionName} leaderboard (bubble):`, error);
    showLogs(`❌ Error details:`, error.message, error.stack);
  }
}

showLogs("✅ Server maintenance module loaded successfully");