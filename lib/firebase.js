// lib/firebase.js
import 'dotenv/config';
import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { showLogs } from './logs.js';

showLogs('🔥 firebase.js module loading started');

let initializedApp;

showLogs('🔍 checking for existing admin apps...');
if (!admin.apps.length) {
  showLogs('ℹ️ no existing admin apps, initializing new app');
  const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (serviceAccountBase64) {
    showLogs('✅ using service account from environment variable');
    const serviceAccount = JSON.parse(
      Buffer.from(serviceAccountBase64, 'base64').toString('utf8')
    );
    showLogs('🔧 service account parsed, processing private key...');
    
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
      showLogs('✅ private key formatting applied');
    }

    initializedApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL:
        process.env.FIREBASE_DATABASE_URL ||
        'https://black-tigers-c9017-default-rtdb.asia-southeast1.firebasedatabase.app',
    });
    showLogs('✅ Firebase admin app initialized with service account');
  } else {
    showLogs('ℹ️ no service account found, using application default credential');
    initializedApp = admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      databaseURL:
        process.env.FIREBASE_DATABASE_URL ||
        'https://black-tigers-c9017-default-rtdb.asia-southeast1.firebasedatabase.app',
    });
    showLogs('✅ Firebase admin app initialized with application default credential');
  }
} else {
  showLogs('ℹ️ using existing admin app');
  initializedApp = admin.apps[0];
}

showLogs('🔧 initializing Firestore and Realtime Database instances...');
// export globally usable instances
export const db = getFirestore(initializedApp);
showLogs('✅ Firestore instance created');

export const auth = admin.auth(initializedApp);
showLogs('✅ Auth instance created');

export const rtDb = admin.database();
showLogs('✅ Realtime Database instance created');

export { admin };
showLogs('🔥 firebase.js module loading completed');