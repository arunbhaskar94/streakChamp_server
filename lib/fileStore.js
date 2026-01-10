// lib/fileStore.js
import fsSync from 'fs';
import path from 'path';
import { showLogs } from './logs.js';
import {
  blockedUsersStore,
  suspectedUsersStore,
  userLoginDataStore,
  usersIPStore,
  deletedUsersStore,
  buggyQuestionsStore
} from './firestoreStore.js';

// Map file paths to Firestore stores
const getStoreForFile = (filePath) => {
  showLogs('🔍 getStoreForFile called with filePath:', filePath);
  const fileName = path.basename(filePath);
  showLogs('🔍 extracted fileName:', fileName);
  
  switch (fileName) {
    case 'blocked_users.json':
      showLogs('✅ matched: blocked_users.json -> blockedUsersStore');
      return blockedUsersStore;
    case 'suspected_users.json':
      showLogs('✅ matched: suspected_users.json -> suspectedUsersStore');
      return suspectedUsersStore;
    case 'userLoginData.json':
      showLogs('✅ matched: userLoginData.json -> userLoginDataStore');
      return userLoginDataStore;
    case 'usersIP.json':
      showLogs('✅ matched: usersIP.json -> usersIPStore');
      return usersIPStore;
    case 'deletedUsersData.json':
      showLogs('✅ matched: deletedUsersData.json -> deletedUsersStore');
      return deletedUsersStore;
    case 'buggy_questions.json':
      showLogs('✅ matched: buggy_questions.json -> buggyQuestionsStore');
      return buggyQuestionsStore;
    default:
      showLogs('❌ no store match for fileName:', fileName);
      return null;
  }
};

export function safeReadJSON(p) {
  showLogs('📖 safeReadJSON called with path:', p);
  try {
    if (typeof global.safeReadJSON === 'function') {
      showLogs('ℹ️ using global.safeReadJSON');
      return global.safeReadJSON(p);
    }
    
    // Try local file first
    if (!fsSync.existsSync(p)) {
      showLogs('⚠️ local file does not exist:', p);
      // If local file doesn't exist, try Firestore
      const store = getStoreForFile(p);
      if (store) {
        showLogs(`[safeReadJSON] Using Firestore for: ${p}`);
        return {}; // Firestore read will happen async elsewhere
      }
      showLogs('❌ no Firestore store available, returning empty object');
      return {};
    }
    
    showLogs('✅ local file exists, reading...');
    const raw = fsSync.readFileSync(p, 'utf8').trim();
    showLogs('📄 raw file content length:', raw.length);
    const parsed = raw ? JSON.parse(raw) : {};
    showLogs('✅ successfully parsed local JSON');
    return parsed;
  } catch (err) {
    showLogs('❌ [safeReadJSON] error for path:', p, 'error:', err && err.message ? err.message : String(err));
    
    // On error, try Firestore fallback
    const store = getStoreForFile(p);
    if (store) {
      showLogs(`[safeReadJSON] Falling back to Firestore for: ${p}`);
      return {}; // Firestore read will happen async elsewhere
    }
    
    showLogs('⚠️ attempting backup and recovery...');
    try { 
      fsSync.copyFileSync(p, `${p}.bak.${Date.now()}`); 
      showLogs('✅ created backup file');
    } catch (e) { 
      showLogs('❌ backup failed:', e && e.message ? e.message : String(e));
    }
    try { 
      fsSync.writeFileSync(p, '{}', 'utf8'); 
      showLogs('✅ wrote empty JSON to file');
    } catch (e) { 
      showLogs('❌ file recovery failed:', e && e.message ? e.message : String(e));
    }
    return {};
  }
}

export function safeWriteJSON(p, obj) {
  showLogs('📝 safeWriteJSON called with path:', p, 'object keys:', Object.keys(obj));
  try {
    if (typeof global.safeWriteJSON === 'function') {
      showLogs('ℹ️ using global.safeWriteJSON');
      return global.safeWriteJSON(p, obj);
    }
    
    // Write to Firestore for cloud compatibility
    const store = getStoreForFile(p);
    if (store) {
      showLogs(`[safeWriteJSON] Writing to Firestore: ${p}`);
      store.write(obj).catch(err => {
        showLogs(`❌ [safeWriteJSON] Firestore write failed for ${p}:`, err.message);
      });
    } else {
      showLogs('⚠️ no Firestore store found for path:', p);
    }
    
    // Also write to local file if it exists (for local development)
    showLogs('💾 writing to local file...');
    const tmp = `${p}.tmp`;
    fsSync.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fsSync.renameSync(tmp, p);
    showLogs('✅ local file write successful');
  } catch (err) {
    showLogs('❌ [safeWriteJSON] error for path:', p, 'error:', err && err.message ? err.message : String(err));
    
    // If local write fails, still try Firestore
    const store = getStoreForFile(p);
    if (store) {
      showLogs('🔄 attempting Firestore write as fallback...');
      store.write(obj).catch(firestoreErr => {
        showLogs(`❌ [safeWriteJSON] Firestore write also failed for ${p}:`, firestoreErr.message);
      });
    }
  }
}