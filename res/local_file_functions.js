
import fsSync from 'fs';
import path from 'path';
import CryptoJS from 'crypto-js';
import { showLogs } from '../lib/logs.js'
import { db, rtDb } from '../lib/firebase.js';
import {  invalidQuestionOverrides, questionBank, actualKey } from '../server.js'
import { userLoginDataStore, usersIPStore, buggyQuestionsStore, deletedUsersStore } from '../lib/firestoreStore.js';
import reelsIndex from '../server questions data/reels_qid.js';

// ===== CONSTANTS & VARIABLES =====

function decryptEntry(entry) {
  showLogs('🔐 decryptEntry called with entry:', entry ? 'exists' : 'null');
  const { cipherText } = entry;
  showLogs('🔐 cipherText extracted:', cipherText ? `${cipherText.substring(0, 20)}...` : 'null');
  const dec = CryptoJS.AES.decrypt(cipherText, actualKey);
  showLogs('🔐 decryption result:', dec ? 'exists' : 'null');
  const utf8 = dec.toString(CryptoJS.enc.Utf8);
  showLogs('🔐 utf8 result:', utf8 ? `${utf8.substring(0, 50)}...` : 'null');
  if (!utf8) {
    showLogs('❌ Decryption failed - empty utf8');
    throw new Error('Decryption failed');
  }
  let parsed;
  try {
    parsed = JSON.parse(utf8);
    showLogs('🔐 JSON parse successful, keys:', Object.keys(parsed));
  } catch (parseErr) {
    showLogs('❌ JSON parse failed:', parseErr && parseErr.message ? parseErr.message : String(parseErr));
    throw new Error('Decryption failed - invalid JSON');
  }
  return parsed;
}





// Replace updateUserLoginData
export async function updateUserLoginData(deviceId, ip, uid, email, password, isGuest) {
  showLogs('👤 updateUserLoginData called:', { deviceId, ip, uid, email, isGuest, passwordLength: password ? password.length : 0 });
  
  const userLoginData = await userLoginDataStore.read(deviceId);
  showLogs('👤 existing userLoginData:', userLoginData);

  if (!userLoginData || Object.keys(userLoginData).length === 0) {
    showLogs('👤 creating new user login record');
    // create new record
    const newData = {
      uid,
      email,
      password: isGuest ? password : undefined,
      ips: [ip],
      isGuest,
      createdAt: Date.now()
    };
    showLogs('👤 new data to write:', newData);
    await userLoginDataStore.write(newData, deviceId);
    showLogs('✅ new user login data written successfully');
  } else {
    showLogs('👤 updating existing user login data');
    // Ensure ips exists
    if (!Array.isArray(userLoginData.ips)) {
      showLogs('👤 initializing empty ips array');
      userLoginData.ips = [];
    }

    // Update existing device data
    userLoginData.uid = uid;
    userLoginData.email = email;
    if (isGuest) {
      userLoginData.password = password;
    }
    userLoginData.isGuest = isGuest;

    // Add IP if not already present
    if (!userLoginData.ips.includes(ip)) {
      showLogs('👤 adding new IP to ips array:', ip);
      userLoginData.ips.push(ip);
    } else {
      showLogs('👤 IP already exists in array:', ip);
    }

    showLogs('👤 updated userLoginData to write:', userLoginData);
    await userLoginDataStore.write(userLoginData, deviceId);
    showLogs('✅ existing user login data updated successfully');
  }
}

// Replace getUserByDevice
export async function getUserByDevice(deviceId, ip) {
  showLogs('🔍 getUserByDevice called:', { deviceId, ip });
  
  // First try exact match
  const deviceData = await userLoginDataStore.read(deviceId);
  showLogs('🔍 deviceData from exact match:', deviceData);
  
  if (deviceData && 
      Array.isArray(deviceData.ips) && 
      deviceData.ips.includes(ip)) {
    showLogs('✅ Exact device match found');
    return deviceData;
  } else {
    showLogs('❌ No exact device match');
  }

  showLogs('🔍 falling back to IP-only match scan');
  // Then try IP match only - need to scan all
  const allUserData = await userLoginDataStore.readAll();
  showLogs('🔍 allUserData count:', Object.keys(allUserData).length);
  
  for (const [id, data] of Object.entries(allUserData)) {
    showLogs(`🔍 checking entry ${id}:`, data);
    if (data && 
        Array.isArray(data.ips) && 
        data.ips.includes(ip)) {
      showLogs(`✅ IP match found in entry: ${id}`);
      return data;
    }
  }

  showLogs('❌ No user found by device or IP');
  return null;
}

export async function findExistingGuestUser(deviceId, ip) {
  showLogs('🔍 findExistingGuestUser called:', { deviceId, ip });
  try {
    // Try exact deviceId match
    if (deviceId) {
      showLogs('🔍 trying exact deviceId match:', deviceId);
      const deviceData = await userLoginDataStore.read(deviceId);
      showLogs('🔍 deviceData from exact match:', deviceData);
      
      // Check if we have valid device data with uid
      if (deviceData && deviceData.uid) {
        // Accept if ips includes ip, or lastSeenServerIp matches ip, or no ips recorded
        const ipMatch = (ip && deviceData.ips && deviceData.ips.includes(ip));
        const serverIpMatch = (ip && deviceData.lastSeenServerIp === ip);
        const clientIpMatch = (ip && deviceData.lastSeenClientIp === ip);
        const noIps = !deviceData.ips || deviceData.ips.length === 0;
        
        showLogs('🔍 match conditions:', { ipMatch, serverIpMatch, clientIpMatch, noIps });
        
        if (noIps || ipMatch || serverIpMatch || clientIpMatch) {
          showLogs('✅ Exact device match accepted');
          return deviceData;
        } else {
          showLogs('❌ Exact device match rejected - no IP match');
        }
      } else {
        showLogs('❌ No device data found for deviceId or missing uid');
      }
    } else {
      showLogs('⚠️ No deviceId provided');
    }

    // Fall back: scan all entries for matching IP
    if (ip) {
      showLogs('🔍 falling back to IP scan across all entries');
      const allUserData = await userLoginDataStore.readAll();
      showLogs('🔍 total entries to scan:', Object.keys(allUserData).length);
      
      for (const [id, data] of Object.entries(allUserData)) {
        if (!data || !data.uid) {
          showLogs(`🔍 skipping invalid data for ${id}`);
          continue;
        }
        
        const ipMatch = (Array.isArray(data.ips) && data.ips.includes(ip));
        const serverIpMatch = (data.lastSeenServerIp && data.lastSeenServerIp === ip);
        const clientIpMatch = (data.lastSeenClientIp && data.lastSeenClientIp === ip);
        
        showLogs(`🔍 checking entry ${id}:`, { ipMatch, serverIpMatch, clientIpMatch });
        
        if (ipMatch || serverIpMatch || clientIpMatch) {
          showLogs(`✅ IP match found in entry: ${id}`);
          return data;
        }
      }
      showLogs('❌ No IP match found in any entry');
    } else {
      showLogs('⚠️ No IP provided for fallback scan');
    }

    showLogs('❌ No existing guest user found');
    return null;
  } catch (err) {
    showLogs('❌ [findExistingGuestUser] error', err && err.message ? err.message : String(err));
    return null;
  }
}

// Replace recordBuggyIds
export async function recordBuggyIds(ids) {
  showLogs('🐛 recordBuggyIds called with ids:', ids);
  try {
    const existing = await buggyQuestionsStore.read('current');
    showLogs('🐛 existing buggy ids:', existing);
    
    let buggyArray = Array.isArray(existing) ? existing : [];
    showLogs('🐛 current buggyArray:', buggyArray);
    
    const set = new Set(buggyArray);
    showLogs('🐛 initial set size:', set.size);
    
    for (const id of ids) {
      if (id !== undefined && id !== null && String(id).trim() !== '') {
        const stringId = String(id);
        set.add(stringId);
        showLogs(`🐛 added id to set: ${stringId}`);
      } else {
        showLogs(`🐛 skipped invalid id: ${id}`);
      }
    }

    showLogs('🐛 final set size:', set.size);
    const finalArray = Array.from(set);
    await buggyQuestionsStore.write(finalArray, 'current');
    showLogs(`✅ Recorded ${ids.length} buggy question id(s) (unique total: ${set.size})`);
  } catch (err) {
    showLogs('❌ recordBuggyIds error:', err && err.message ? err.message : String(err));
  }
}

export function filterQuestionsAndRecord(questions = []) {
  showLogs('🔍 filterQuestionsAndRecord called with questions count:', questions.length);
  const good = [];
  const buggyIds = [];

  for (const q of questions) {
    showLogs('🔍 processing question:', q);
    // support multiple naming variants
    const qid = q.questionID ?? q.questionId ?? q.questionId ?? q.questionId;
    showLogs('🔍 extracted qid:', qid);
    
    // options arrays may be in different fields depending on where they came from:
    const optsHindi = Array.isArray(q.optionsHindi) ? q.optionsHindi
      : (q.hindi && Array.isArray(q.hindi.options) ? q.hindi.options : []);
    const optsEng = Array.isArray(q.optionsEng) ? q.optionsEng
      : (q.english && Array.isArray(q.english.options) ? q.english.options : []);

    const ansHindi = q.answerHindi ?? (q.hindi && q.hindi.answer) ?? '';
    const ansEng = q.answerEng ?? (q.english && q.english.answer) ?? '';

    showLogs('🔍 hindi options/answer:', { optsHindi, ansHindi });
    showLogs('🔍 english options/answer:', { optsEng, ansEng });

    let matched = false;

    // Exact, case-sensitive matching (as you requested)
    if (ansHindi !== '' && optsHindi.includes(ansHindi)) {
      matched = true;
      showLogs('✅ Hindi answer matched in options');
    }
    if (!matched && ansEng !== '' && optsEng.includes(ansEng)) {
      matched = true;
      showLogs('✅ English answer matched in options');
    }

    if (matched) {
      showLogs('✅ Question is GOOD - adding to good array');
      good.push(q);
    } else {
      showLogs('❌ Question is BUGGY - answer not found in options');
      // record as buggy (use string)
      if (qid !== undefined && qid !== null) {
        buggyIds.push(String(qid));
        showLogs(`🐛 Added to buggyIds: ${qid}`);
      }
    }
  }

  showLogs('🔍 final good count:', good.length);
  showLogs('🔍 final buggyIds:', buggyIds);
  
  if (buggyIds.length) {
    showLogs('🔍 calling recordBuggyIds with:', buggyIds);
    recordBuggyIds(buggyIds);
  } else {
    showLogs('🔍 no buggy ids to record');
  }
  
  return good;
}

export async function getQuestionsFromDatabase(subjectsAndChapters, noOfQuestions, userId, opts = {}) {
  // opts: { allowFallback: boolean, debugLimitIds: number (optional) }
  const allowFallback = opts.allowFallback !== undefined ? Boolean(opts.allowFallback) : true;
  const REQ_COUNT = Number(noOfQuestions || 10);

  showLogs('🔵 getQuestionsFromDatabase called:', { subjectsAndChapters, noOfQuestions: REQ_COUNT, userId, allowFallback, opts });

  if (!Array.isArray(subjectsAndChapters) || subjectsAndChapters.length === 0) {
    showLogs('⚠️ subjectsAndChapters must be a non-empty array. Returning []');
    return [];
  }

  if (typeof reelsIndex === 'undefined' || typeof questionBank === 'undefined') {
    showLogs('❌ reelsIndex or questionBank not defined in scope');
    throw new Error('reelsIndex or questionBank not defined in scope');
  }

  // Build fast lookup map for questionBank
  const questionById = new Map();
  for (const q of questionBank) {
    if (q && q.QuestionID) questionById.set(q.QuestionID, q);
  }
  showLogs(`ℹ️ questionBank size: ${questionBank.length}; indexed: ${questionById.size}`);

  const ids = [];

  // helpers
  const normalize = s => String(s || '').trim();
  const normalizeKey = s => String(s || '').trim().toLowerCase();

  // try common separators for combined keys
  function findCombinedKey(subject, chap) {
    const subj = normalize(subject);
    const c = normalize(chap);
    const separators = [' - ', '-', ' : ', ':', ' — ', '—', ' – ', '–', ' / ', '/'];
    for (const sep of separators) {
      const candidate = `${subj}${sep}${c}`;
      if (reelsIndex[candidate]) {
        showLogs(`🔍 found combined key with separator "${sep}": ${candidate}`);
        return candidate;
      }
      // case-insensitive match
      const found = Object.keys(reelsIndex).find(k => k.toLowerCase() === candidate.toLowerCase());
      if (found) {
        showLogs(`🔍 found combined key case-insensitive: ${found}`);
        return found;
      }
    }
    showLogs(`❌ no combined key found for: ${subj} + ${c}`);
    return null;
  }

  // tolerant subject key finder (subject-only keys)
  function findSubjectKey(subject) {
    const subjNorm = normalizeKey(subject);
    showLogs(`🔍 finding subject key for: "${subject}" (normalized: "${subjNorm}")`);
    
    // exact
    let k = Object.keys(reelsIndex).find(x => normalizeKey(x) === subjNorm);
    if (k) {
      showLogs(`✅ exact subject key match: ${k}`);
      return k;
    }
    // includes / fuzzy
    k = Object.keys(reelsIndex).find(x => normalizeKey(x).includes(subjNorm) || subjNorm.includes(normalizeKey(x)));
    if (k) {
      showLogs(`✅ fuzzy subject key match: ${k}`);
    } else {
      showLogs(`❌ no subject key found for: ${subject}`);
    }
    return k || null;
  }

  // shuffle util (Fisher-Yates)
  function shuffle(arr) {
    showLogs('🔀 shuffling array of size:', arr.length);
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    showLogs('🔀 shuffle complete');
    return a;
  }

  // MAIN: collect IDs
  for (const entry of subjectsAndChapters) {
    showLogs('🔍 processing entry:', entry);
    const subject = normalize(entry.subject);
    const chapters = Array.isArray(entry.chapters) ? entry.chapters : [entry.chapter].filter(Boolean);

    if (!subject || chapters.length === 0) {
      showLogs('⚠️ skipping empty subject or chapters in entry:', entry);
      continue;
    }

    for (const chapRaw of chapters) {
      const chapter = normalize(chapRaw);
      showLogs(`🔎 resolving bucket for: subject="${subject}" chapter="${chapter}"`);

      // 1) try combined-key (fast path)
      const combinedKey = findCombinedKey(subject, chapter);
      if (combinedKey) {
        showLogs(`✅ combined-key matched -> "${combinedKey}"`);
        const pool = Array.isArray(reelsIndex[combinedKey]) ? reelsIndex[combinedKey] : [];
        showLogs(`📊 combined key pool size: ${pool.length}`);
        
        const avail = pool.filter(id => {
          const q = questionById.get(id);
          if (!q) {
            showLogs(`❌ question ${id} not found in questionBank`);
            return false;
          }
          const attemptedBy = Array.isArray(q.attemptedBy) ? q.attemptedBy : [];
          const hasUserAttempted = attemptedBy.includes(userId);
          if (hasUserAttempted) {
            showLogs(`⏩ skipping question ${id} - user already attempted`);
          }
          return !hasUserAttempted;
        });
        showLogs(`  • pool size: ${pool.length}, available after filter: ${avail.length}`);
        const chosen = shuffle(avail).slice(0, REQ_COUNT - ids.length);
        showLogs(`  • chosen ${chosen.length} questions from this bucket`);
        ids.push(...chosen);
        if (ids.length >= REQ_COUNT) {
          showLogs(`🎯 reached requested count: ${ids.length}/${REQ_COUNT}`);
          break;
        }
        continue;
      }

      // 2) try subject -> chapter nested lookup (if stored that way)
      const subjectKey = findSubjectKey(subject);
      if (subjectKey) {
        const bucketOrMap = reelsIndex[subjectKey];
        showLogs(`🔍 subjectKey "${subjectKey}" type:`, typeof bucketOrMap);
        
        // If bucketOrMap is an array, it may be that the key itself was subject+chapter collapsed; treat it as pool
        if (Array.isArray(bucketOrMap)) {
          showLogs(`ℹ️ subjectKey "${subjectKey}" points to an array (treating as pool)`);
          const avail = bucketOrMap.filter(id => {
            const q = questionById.get(id);
            if (!q) {
              showLogs(`❌ question ${id} not found in questionBank`);
              return false;
            }
            const attemptedBy = Array.isArray(q.attemptedBy) ? q.attemptedBy : [];
            const hasUserAttempted = attemptedBy.includes(userId);
            if (hasUserAttempted) {
              showLogs(`⏩ skipping question ${id} - user already attempted`);
            }
            return !hasUserAttempted;
          });
          showLogs(`  • pool size: ${bucketOrMap.length}, available: ${avail.length}`);
          const chosen = shuffle(avail).slice(0, REQ_COUNT - ids.length);
          showLogs(`  • chosen ${chosen.length} questions from this subject pool`);
          ids.push(...chosen);
          if (ids.length >= REQ_COUNT) {
            showLogs(`🎯 reached requested count: ${ids.length}/${REQ_COUNT}`);
            break;
          }
          continue;
        }

        // Otherwise expect object: chapterKey -> [ids]
        const chapterKey = Object.keys(bucketOrMap || {}).find(c => normalizeKey(c) === normalizeKey(chapter))
          || Object.keys(bucketOrMap || {}).find(c => normalizeKey(c).includes(normalizeKey(chapter)) || normalizeKey(chapter).includes(normalizeKey(c)));

        if (chapterKey) {
          showLogs(`✅ nested chapter matched -> subjectKey="${subjectKey}" chapterKey="${chapterKey}"`);
          const pool = bucketOrMap[chapterKey] || [];
          showLogs(`📊 nested chapter pool size: ${pool.length}`);
          
          const avail = pool.filter(id => {
            const q = questionById.get(id);
            if (!q) {
              showLogs(`❌ question ${id} not found in questionBank`);
              return false;
            }
            const attemptedBy = Array.isArray(q.attemptedBy) ? q.attemptedBy : [];
            const hasUserAttempted = attemptedBy.includes(userId);
            if (hasUserAttempted) {
              showLogs(`⏩ skipping question ${id} - user already attempted`);
            }
            return !hasUserAttempted;
          });
          showLogs(`  • pool size: ${pool.length}, available: ${avail.length}`);
          const chosen = shuffle(avail).slice(0, REQ_COUNT - ids.length);
          showLogs(`  • chosen ${chosen.length} questions from this nested chapter`);
          ids.push(...chosen);
          if (ids.length >= REQ_COUNT) {
            showLogs(`🎯 reached requested count: ${ids.length}/${REQ_COUNT}`);
            break;
          }
          continue;
        } else {
          showLogs(`⚠️ no chapterKey found inside subjectKey "${subjectKey}" for chapter "${chapter}"`);
        }
      } else {
        showLogs(`⚠️ no subjectKey found for "${subject}" (combined-key also failed)`);
      }

      // 3) no bucket found for this subject/chapter; continue to next chapter
      showLogs(`ℹ️ continuing — no bucket for ${subject} / ${chapter}`);
    } // for each chapter

    if (ids.length >= REQ_COUNT) {
      showLogs(`🎯 breaking outer loop - reached requested count: ${ids.length}/${REQ_COUNT}`);
      break;
    }
  } // for each entry

  showLogs(`📊 IDs collected before fallback: ${ids.length}/${REQ_COUNT}`);
  
  // fallback: if not enough ids and fallback allowed, sample from entire questionBank
  if (ids.length < REQ_COUNT) {
    if (!allowFallback) {
      showLogs(`❗ Not enough IDs (${ids.length}/${REQ_COUNT}) and fallback disabled. Returning collected IDs only.`);
    } else {
      showLogs(`ℹ️ Not enough IDs (${ids.length}/${REQ_COUNT}) — performing global fallback sampling from questionBank.`);
      const allIds = Array.from(questionById.keys()).filter(id => !ids.includes(id));
      showLogs(`📊 available IDs for fallback: ${allIds.length}`);
      const fallbackChosen = shuffle(allIds).slice(0, REQ_COUNT - ids.length);
      showLogs(`  • fallback selected ${fallbackChosen.length} IDs`);
      ids.push(...fallbackChosen);
    }
  }

  showLogs(`🔢 Collected IDs total: ${ids.length} (requested ${REQ_COUNT})`);
  if (!ids.length) {
    showLogs('⚠️ No IDs found — returning []');
    return [];
  }

  // OPTIONAL: debug limit (to avoid heavy decryption logs)
  const debugLimit = Number(opts.debugLimitIds || 9999);
  showLogs(`🔧 debug limit for decryption: ${debugLimit}`);

  // Decrypt + prepare objects
  const prepared = [];
  for (let i = 0; i < ids.length && prepared.length < REQ_COUNT; i++) {
    const id = ids[i];
    showLogs(`🔍 processing question ${i+1}/${ids.length}: ${id}`);
    
    const raw = questionById.get(id);
    if (!raw) {
      showLogs(`⚠️ ID ${id} not found in questionBank map; skipping`);
      continue;
    }
    try {
      showLogs(`🔐 decrypting question ${id}`);
      const plain = decryptEntry(raw); // your existing decrypt function
      if (i < debugLimit) {
        showLogs(`📄 plain text for question ${id}:`, plain);
      } else {
        showLogs(`📄 plain text for question ${id}: [omitted due to debug limit]`);
      }

      // prepare options arrays safely (keep your existing override logic)
      let optsHin = [plain.OptionA, plain.OptionB, plain.OptionC, plain.OptionD].filter(Boolean);
      let optsEng = [plain.OptionA_Eng, plain.OptionB_Eng, plain.OptionC_Eng, plain.OptionD_Eng].filter(Boolean);
      let answerHin = plain.Answer || '';
      let answerEng = plain.Answer_Eng || '';

      showLogs(`⚙️ initial options for ${id}:`, { optsHin, optsEng, answerHin, answerEng });

      const override = invalidQuestionOverrides && invalidQuestionOverrides[id];
      if (override) {
        showLogs(`🔄 applying override for question ${id}:`, override);
        if (override.hindi) {
          if (Array.isArray(override.hindi.options) && override.hindi.options.length) {
            optsHin = override.hindi.options.slice();
            showLogs(`🔄 overridden hindi options:`, optsHin);
          }
          if (override.hindi.answer) {
            answerHin = override.hindi.answer;
            showLogs(`🔄 overridden hindi answer: ${answerHin}`);
          }
        }
        if (override.english) {
          if (Array.isArray(override.english.options) && override.english.options.length) {
            optsEng = override.english.options.slice();
            showLogs(`🔄 overridden english options:`, optsEng);
          }
          if (override.english.answer) {
            answerEng = override.english.answer;
            showLogs(`🔄 overridden english answer: ${answerEng}`);
          }
        }
      }

      // difficulty heuristics (reuse your logic or adapt)
      const totalAttempts = raw.metadata?.totalAttempts ?? 0;
      const correctAttempts = raw.metadata?.correctAttempts ?? 0;
      const diff = totalAttempts - correctAttempts;
      let difficulty = 'easy';
      if (diff >= 5 && diff < 50) difficulty = 'medium';
      else if (diff >= 50 && diff < 500) difficulty = 'hard';
      else if (diff >= 500) difficulty = 'very hard';

      showLogs(`📊 difficulty calculation for ${id}:`, { totalAttempts, correctAttempts, diff, difficulty });

      const qObj = {
        questionId: id,
        subject: plain.Subject || plain.subject || 'Unknown',
        chapter: plain.Chapter || plain.chapterName || 'Unknown',
        hindi: { question: plain.Question || '', options: optsHin, answer: answerHin },
        english: { question: plain.Question_Eng || '', options: optsEng, answer: answerEng },
        likes: raw.metadata?.likes ?? 0,
        dislikes: raw.metadata?.dislikes ?? 0,
        totalAttempts,
        correctAttempts,
        difficulty
      };

      showLogs('📦 Prepared Question object:', qObj);
      prepared.push(qObj);
      showLogs(`✅ Successfully prepared question ${id}`);

    } catch (err) {
      showLogs(`❌ Error decrypting/preparing question ${id}:`, err && err.message ? err.message : String(err));
      continue;
    }
  }

  showLogs(`📊 Questions prepared: ${prepared.length}`);
  
  // final filter + recording hook (preserve your pipeline)
  let final = Array.isArray(prepared) ? prepared : [];
  showLogs('🔍 applying final filterQuestionsAndRecord');
  
  if (typeof filterQuestionsAndRecord === 'function') {
    final = filterQuestionsAndRecord(final);
    showLogs(`🔍 after filterQuestionsAndRecord: ${final.length} questions`);
  } else {
    showLogs('⚠️ filterQuestionsAndRecord is not a function, skipping filter');
  }

  // ensure we don't return more than requested
  final = final.slice(0, REQ_COUNT);
  showLogs(`✅ Returning ${final.length} prepared questions (requested: ${REQ_COUNT}).`);
  return final;
}

export async function saveDeletedUserData(uid) {
  showLogs('🗑️ saveDeletedUserData called for uid:', uid);
  try {
    // 1) Gather Firestore user doc
    showLogs('📋 gathering Firestore user document');
    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    const userDocData = userSnap.exists ? userSnap.data() : null;
    showLogs('📋 user document data:', userDocData);

    // 2) Gather known subcollections:
    const subcollections = {};

    // 2a) mockAttempts -> include questions subcollection for each attempt
    showLogs('📋 gathering mockAttempts subcollection');
    const mockAttemptsRef = userRef.collection('mockAttempts');
    const mockAttemptsSnap = await mockAttemptsRef.get();
    const mockAttemptsObj = {};
    showLogs(`📋 found ${mockAttemptsSnap.size} mock attempts`);
    
    for (const doc of mockAttemptsSnap.docs) {
      const attemptId = doc.id;
      const attemptData = doc.data() || {};
      showLogs(`📋 processing mock attempt ${attemptId}`);
      
      // fetch questions subcollection
      const qSnap = await mockAttemptsRef.doc(attemptId).collection('questions').get();
      const questions = {};
      qSnap.forEach(qd => { questions[qd.id] = qd.data(); });
      mockAttemptsObj[attemptId] = { meta: attemptData, questions };
      showLogs(`📋 added ${qSnap.size} questions for attempt ${attemptId}`);
    }
    subcollections.mockAttempts = mockAttemptsObj;

    // 2b) incorrect_responses (documents)
    showLogs('📋 gathering incorrect_responses subcollection');
    const incorrectRef = userRef.collection('incorrect_responses');
    const incorrectSnap = await incorrectRef.get();
    const incorrectObj = {};
    incorrectSnap.forEach(d => { incorrectObj[d.id] = d.data(); });
    subcollections.incorrect_responses = incorrectObj;
    showLogs(`📋 found ${incorrectSnap.size} incorrect responses`);

    // 2c) analysis (per-chapter docs)
    showLogs('📋 gathering analysis subcollection');
    const analysisRef = userRef.collection('analysis');
    const analysisSnap = await analysisRef.get();
    const analysisObj = {};
    analysisSnap.forEach(d => { analysisObj[d.id] = d.data(); });
    subcollections.analysis = analysisObj;
    showLogs(`📋 found ${analysisSnap.size} analysis documents`);

    // 3) Ranking entries (per-leaderboard)
    showLogs('📋 gathering ranking entries');
    const leaderboardNames = ['leaderboardReels', 'leaderboardMock', 'leaderboardCombined', 'bubbleGame'];
    const rankings = {};
    for (const lb of leaderboardNames) {
      try {
        showLogs(`📋 fetching ranking for: ${lb}`);
        const doc = await db.collection('ranking').doc(lb).collection('users').doc(uid).get();
        rankings[lb] = doc.exists ? doc.data() : null;
        showLogs(`📋 ranking ${lb}:`, rankings[lb]);
      } catch (err) {
        rankings[lb] = { error: `failed to fetch ranking ${lb}: ${err.message}` };
        showLogs(`❌ error fetching ranking ${lb}:`, err.message);
      }
    }

    // 4) RTDB snapshot (if any)
    showLogs('📋 gathering RTDB data');
    let rtData = null;
    try {
      const rtSnap = await rtDb.ref(`users/${uid}`).once('value');
      rtData = rtSnap.exists() ? rtSnap.val() : null;
      showLogs('📋 RTDB data:', rtData);
    } catch (err) {
      rtData = { error: `failed to fetch RTDB: ${err.message}` };
      showLogs('❌ error fetching RTDB:', err.message);
    }

    // 5) Optionally: other references you care about can be fetched here (mocks responses etc.)
    //    For performance reasons, we skip scanning ALL mocks. Add custom fetches if needed.

    // 6) Build the payload
    showLogs('📦 building payload for deleted user');
    const payload = {
      savedAt: new Date().toISOString(),
      userDoc: userDocData,
      subcollections,
      rankings,
      realtimeDb: rtData
    };
    showLogs('📦 payload built, saving to deletedUsersStore');

    const deletedData = await deletedUsersStore.read(uid);
    showLogs('📦 existing deleted data:', deletedData);
    
    const userDeletedArray = Array.isArray(deletedData) ? deletedData : [];
    userDeletedArray.push(payload);
    
    await deletedUsersStore.write(userDeletedArray, uid);

    showLogs(`✅ Saved deleted user snapshot for ${uid} to Firestore (size now: ${userDeletedArray.length})`);
    return { success: true };
  } catch (err) {
    showLogs(`❌ saveDeletedUserData failed for ${uid}:`, err.message || err);
    return { success: false, error: err.message || String(err) };
  }
}