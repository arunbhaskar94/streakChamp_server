// lib/leaderboard.js
import admin from 'firebase-admin';
import { showLogs } from './logs.js';

export async function updateLeaderboard(db, collectionName, sortedUsers, scoreKey, timeAccuracyKey, rankKey) {
  showLogs('🏆 updateLeaderboard called:', { 
    collectionName, 
    userCount: sortedUsers.length,
    scoreKey,
    timeAccuracyKey, 
    rankKey 
  });

  const batch = db.batch();
  const leaderboardCollectionRef = db.collection('ranking').doc(collectionName).collection('users');
  showLogs('🏆 leaderboard collection reference created');

  for (let i = 0; i < sortedUsers.length; i++) {
    const user = sortedUsers[i];
    showLogs(`🏆 processing user ${i+1}/${sortedUsers.length}:`, user.uid);
    
    const userDocRef = leaderboardCollectionRef.doc(user.uid);
    const updateData = {
      displayName: user.displayName,
      [scoreKey]: user[scoreKey],
      TimeAccuracy: user[timeAccuracyKey],
      [rankKey]: i + 1,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    showLogs(`🏆 setting user data for ${user.uid}:`, updateData);
    batch.set(userDocRef, updateData, { merge: true });
  }

  showLogs('🏆 batch operations prepared, committing...');
  try {
    await batch.commit();
    showLogs(`✅ Leaderboard '${collectionName}' updated with ${sortedUsers.length} users.`);
  } catch (error) {
    showLogs(`❌ Error committing batch for ${collectionName} leaderboard:`, error);
    throw error;
  }
}

export async function updateBubbleLeaderboard(db, collectionName, sortedUsers) {
  showLogs('🫧 updateBubbleLeaderboard called:', { 
    collectionName, 
    userCount: sortedUsers.length 
  });

  const batch = db.batch();
  const leaderboardCollectionRef = db.collection('ranking').doc(collectionName).collection('users');
  showLogs('🫧 bubble leaderboard collection reference created');

  for (let i = 0; i < sortedUsers.length; i++) {
    const user = sortedUsers[i];
    showLogs(`🫧 processing user ${i+1}/${sortedUsers.length}:`, user.uid);
    
    const userDocRef = leaderboardCollectionRef.doc(user.uid);
    const updateData = {
      displayName: user.displayName,
      bubbleScore: user.bubbleScore,
      bubbleTimeAccuracy: user.bubbleTimeAccuracy,
      rankInBubble: i + 1,
      xp: user.xp,
      level: user.level,
      score: user.bubbleRawScore,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    showLogs(`🫧 setting bubble user data for ${user.uid}:`, updateData);
    batch.set(userDocRef, updateData, { merge: true });
  }

  showLogs('🫧 bubble batch operations prepared, committing...');
  try {
    await batch.commit();
    showLogs(`✅ Bubble leaderboard '${collectionName}' updated.`);
  } catch (error) {
    showLogs(`❌ Error committing batch for bubble leaderboard:`, error);
    throw error;
  }
}