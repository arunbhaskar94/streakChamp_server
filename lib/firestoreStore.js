// lib/firestoreStore.js
import { db } from './firebase.js';
import { showLogs } from './logs.js';

showLogs('[FirestoreStore] Module loading started');

// Generic Firestore operations to replace local JSON files
export class FirestoreStore {
  constructor(collectionName) {
    showLogs(`[FirestoreStore] Constructor called for collection: ${collectionName}`);
    this.collectionName = collectionName;
    showLogs(`[FirestoreStore] Instance created for collection: ${this.collectionName}`);
  }

  async read(uid = 'global') {
    showLogs(`[FirestoreStore:${this.collectionName}] read() called with uid: ${uid}`);
    try {
      showLogs(`[FirestoreStore:${this.collectionName}] Attempting to read document: ${uid}`);
      const docRef = db.collection(this.collectionName).doc(uid);
      showLogs(`[FirestoreStore:${this.collectionName}] Document reference created, getting document...`);
      
      const doc = await docRef.get();
      showLogs(`[FirestoreStore:${this.collectionName}] Document get completed, exists: ${doc.exists}`);
      
      if (doc.exists) {
        const data = doc.data();
        showLogs(`[FirestoreStore:${this.collectionName}] Document data retrieved:`, data);
        const result = data.data || {};
        showLogs(`[FirestoreStore:${this.collectionName}] Returning data:`, result);
        return result;
      }
      
      showLogs(`[FirestoreStore:${this.collectionName}] Document does not exist, returning empty object`);
      return {};
    } catch (err) {
      console.error(`[FirestoreStore:${this.collectionName}] ERROR in read(${uid}):`, err);
      showLogs(`[FirestoreStore] Error reading ${this.collectionName}/${uid}:`, err.message);
      return {};
    }
  }

  async write(data, uid = 'global') {
    showLogs(`[FirestoreStore:${this.collectionName}] write() called with uid: ${uid}, data:`, data);
    try {
      showLogs(`[FirestoreStore:${this.collectionName}] Preparing to write to document: ${uid}`);
      const docRef = db.collection(this.collectionName).doc(uid);
      const writeData = {
        data,
        updatedAt: new Date().toISOString()
      };
      
      showLogs(`[FirestoreStore:${this.collectionName}] Writing data:`, writeData);
      showLogs(`[FirestoreStore:${this.collectionName}] Calling set() with merge: true...`);
      
      await docRef.set(writeData, { merge: true });
      
      showLogs(`[FirestoreStore:${this.collectionName}] Write operation completed successfully`);
      return true;
    } catch (err) {
      console.error(`[FirestoreStore:${this.collectionName}] ERROR in write(${uid}):`, err);
      showLogs(`[FirestoreStore] Error writing ${this.collectionName}/${uid}:`, err.message);
      return false;
    }
  }

  async readAll() {
    showLogs(`[FirestoreStore:${this.collectionName}] readAll() called`);
    try {
      showLogs(`[FirestoreStore:${this.collectionName}] Getting entire collection...`);
      const snapshot = await db.collection(this.collectionName).get();
      
      showLogs(`[FirestoreStore:${this.collectionName}] Collection snapshot received, size: ${snapshot.size}`);
      
      const result = {};
      let docCount = 0;
      
      snapshot.forEach(doc => {
        showLogs(`[FirestoreStore:${this.collectionName}] Processing document: ${doc.id}`);
        const docData = doc.data();
        showLogs(`[FirestoreStore:${this.collectionName}] Document ${doc.id} data:`, docData);
        
        result[doc.id] = docData.data || {};
        docCount++;
      });
      
      showLogs(`[FirestoreStore:${this.collectionName}] Processed ${docCount} documents, returning:`, result);
      return result;
    } catch (err) {
      console.error(`[FirestoreStore:${this.collectionName}] ERROR in readAll():`, err);
      showLogs(`[FirestoreStore] Error reading all from ${this.collectionName}:`, err.message);
      return {};
    }
  }

  async delete(uid = 'global') {
    showLogs(`[FirestoreStore:${this.collectionName}] delete() called with uid: ${uid}`);
    try {
      showLogs(`[FirestoreStore:${this.collectionName}] Attempting to delete document: ${uid}`);
      const docRef = db.collection(this.collectionName).doc(uid);
      
      await docRef.delete();
      
      showLogs(`[FirestoreStore:${this.collectionName}] Delete operation completed successfully`);
      return true;
    } catch (err) {
      console.error(`[FirestoreStore:${this.collectionName}] ERROR in delete(${uid}):`, err);
      showLogs(`[FirestoreStore] Error deleting ${this.collectionName}/${uid}:`, err.message);
      return false;
    }
  }
}

showLogs('[FirestoreStore] Class definition completed, creating store instances...');

// Specific stores for each type of data
showLogs('[FirestoreStore] Creating blockedUsersStore...');
export const blockedUsersStore = new FirestoreStore('blockedUsers');
showLogs('[FirestoreStore] blockedUsersStore created:', blockedUsersStore);

showLogs('[FirestoreStore] Creating suspectedUsersStore...');
export const suspectedUsersStore = new FirestoreStore('suspectedUsers');
showLogs('[FirestoreStore] suspectedUsersStore created:', suspectedUsersStore);

showLogs('[FirestoreStore] Creating userLoginDataStore...');
export const userLoginDataStore = new FirestoreStore('userLoginData');
showLogs('[FirestoreStore] userLoginDataStore created:', userLoginDataStore);

showLogs('[FirestoreStore] Creating usersIPStore...');
export const usersIPStore = new FirestoreStore('usersIP');
showLogs('[FirestoreStore] usersIPStore created:', usersIPStore);

showLogs('[FirestoreStore] Creating deletedUsersStore...');
export const deletedUsersStore = new FirestoreStore('deletedUsers');
showLogs('[FirestoreStore] deletedUsersStore created:', deletedUsersStore);

showLogs('[FirestoreStore] Creating buggyQuestionsStore...');
export const buggyQuestionsStore = new FirestoreStore('buggyQuestions');
showLogs('[FirestoreStore] buggyQuestionsStore created:', buggyQuestionsStore);

showLogs('[FirestoreStore] All store instances created, module loading completed');