// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const CryptoJS = require("crypto-js"); // Used for decryption on the backend

const app = express();
const port = process.env.PORT || 8080;

// This 'actualKey' is your master decryption key, used by the backend to decrypt questions.
// It should be stored securely as an environment variable (e.g., SECRET_KEY on Render).
const actualKey = process.env.SECRET_KEY;

if (!actualKey) {
  console.error("❌ Missing SECRET_KEY environment variable. Questions cannot be decrypted.");
  // In a production app, you might want to exit or prevent server startup here.
}

// Initialize Firebase Admin SDK
// This block handles Firebase Admin SDK initialization using either:
// 1. A base64 encoded service account key from an environment variable (recommended for Render).
// 2. Application Default Credentials (if GOOGLE_APPLICATION_CREDENTIALS env var is set).
let serviceAccount;
try {
  const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_KEY_B64;
  if (serviceAccountBase64) {
    serviceAccount = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('utf8'));
    // Ensure private_key has actual newlines if it was escaped during base64 encoding
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    console.log("🔹 Initializing Firebase Admin SDK using base64 encoded service account key.");
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: "https://black-tigers-c9017-default-rtdb.asia-southeast1.firebasedatabase.app"
    });
    console.log("✅ Firebase Admin SDK initialized successfully.");
  } else {
    // Fallback to Application Default Credentials if base64 key is not provided
    console.log("🔹 FIREBASE_SERVICE_ACCOUNT_KEY_B64 not found. Attempting Application Default Credentials.");
    admin.initializeApp({
      credential: admin.credentials.ApplicationDefault(),
      databaseURL: "https://black-tigers-c9017-default-rtdb.asia-southeast1.firebasedatabase.app"
    });
    console.log("✅ Firebase Admin SDK initialized using Application Default Credentials.");
  }
} catch (error) {
  console.error("❌ Error initializing Firebase Admin SDK:", error.message);
  console.error("Please ensure FIREBASE_SERVICE_ACCOUNT_KEY_B64 or GOOGLE_APPLICATION_CREDENTIALS is correctly set.");
  // Exit the process if Firebase initialization fails, as the app won't function without it.
  process.exit(1);
}

const db = getFirestore();
const auth = admin.auth(); // Firebase Auth Admin SDK

// Middleware
app.use(cors());
app.use(express.json());

// Helper function to count question IDs in a nested object structure
function countQuestionIDs(data) {
  let count = 0;
  Object.entries(data).forEach(([key, value]) => {
    if (typeof value === "object" && value !== null) {
      count += countQuestionIDs(value); // Recursively count for nested objects
    } else if (typeof value === "number") {
      count += 1; // Count the question ID if it's a number (e.g., "Maths LCM_HCF 00027: 350")
    }
  });
  return count;
}

// Helper to convert Firestore Timestamp to Unix timestamp (milliseconds)
const timestampToMs = (timestamp) => {
  if (timestamp instanceof admin.firestore.Timestamp) {
    return timestamp.toMillis();
  }
  return timestamp; // Return as is if not a Timestamp object
};

// --- API Routes ---

// Test route
app.get('/', (req, res) => {
  console.log('✅ Server is running successfully!');
  res.send('✅ Server is running successfully!');
});

// Route to fetch the encrypted secret key for frontend decryption
app.get('/config/encryption', async (req, res) => {
  try {
    // Fetch the encrypted secret key from Firestore
    // The frontend expects this key to be encrypted with a client-side key.
    const docRef = db.collection("config").doc("encryption");
    const docSnap = await docRef.get();
    if (docSnap.exists && docSnap.data().secretKey) {
      const encryptedSecretKey = docSnap.data().secretKey;
      console.log("✅ Encrypted secret key fetched from Firestore.");
      res.json({ secretKey: encryptedSecretKey });
    } else {
      console.error("❌ Encrypted secret key not found in Firestore /config/encryption document.");
      res.status(404).json({ error: "Encrypted secret key not found. Please configure Firestore." });
    }
  } catch (error) {
    console.error("❌ Error fetching encrypted secret key:", error);
    res.status(500).json({ error: `Failed to fetch encrypted secret key: ${error.message}` });
  }
});

// Route to fetch all mock test metadata
app.get('/mocks', async (req, res) => {
  try {
    const mocksRef = db.collection("mocks");
    const mocksSnapshot = await mocksRef.get();

    const mocksData = [];
    mocksSnapshot.forEach(doc => {
      const mock_id = doc.id;
      const mock_dict = doc.data();
      mocksData.push({ id: mock_id, ...mock_dict });
    });
    console.log(`✅ Fetched ${mocksData.length} mock tests.`);
    res.json(mocksData);
  } catch (error) {
    console.error("❌ Error fetching mocks:", error);
    res.status(500).json({ error: `Failed to retrieve mock tests: ${error.message}` });
  }
});

// Route to fetch encrypted questions for a specific mock
app.get('/mocks/:mock_id/questions', async (req, res) => {
  try {
    const mockId = req.params.mock_id;
    const docRef = db.collection("mocks").doc(mockId).collection("questions").doc("batch");
    const docSnap = await docRef.get();
    if (docSnap.exists && docSnap.data().encryptedData) {
      const encryptedQuestions = docSnap.data().encryptedData;
      console.log(`✅ Encrypted questions fetched for mock ID: ${mockId}`);
      res.json({ encryptedData: encryptedQuestions });
    } else {
      console.warn(`⚠️ Questions not found for mock ID: ${mockId}`);
      res.status(404).json({ error: "Questions not found for this mock" });
    }
  } catch (error) {
    console.error(`❌ Error fetching mock questions for ${mockId}:`, error);
    res.status(500).json({ error: `Failed to retrieve mock questions: ${error.message}` });
  }
});

// Route to fetch user responses for a specific mock and user
app.get('/mocks/:mock_id/responses/:user_id', async (req, res) => {
  try {
    const { mock_id, user_id } = req.params;
    const docRef = db.collection("mocks").doc(mock_id).collection("Responses").doc(user_id);
    const docSnap = await docRef.get();
    if (docSnap.exists) {
      const data = docSnap.data();
      // Convert any Firestore Timestamps to milliseconds for consistency with frontend
      if (data.updatedAt) {
        data.updatedAt = timestampToMs(data.updatedAt);
      }
      if (data.submittedAt) {
        data.submittedAt = timestampToMs(data.submittedAt);
      }
      console.log(`✅ User responses fetched for user ${user_id} on mock ${mock_id}.`);
      res.json(data);
    } else {
      console.log(`⚠️ User responses not found for user ${user_id} on mock ${mock_id}.`);
      res.status(404).json({ error: "User responses not found" });
    }
  } catch (error) {
    console.error(`❌ Error fetching user responses for ${user_id} on mock ${mock_id}:`, error);
    res.status(500).json({ error: `Failed to retrieve user responses: ${error.message}` });
  }
});

// Route to save user progress
app.post('/mocks/:mock_id/responses/:user_id/progress', async (req, res) => {
  try {
    const { mock_id, user_id } = req.params;
    const data = req.body;
    if (!data) {
      console.warn("⚠️ Progress save: Request body is empty.");
      return res.status(400).json({ error: "Request body must be JSON" });
    }

    const docRef = db.collection("mocks").doc(mock_id).collection("Responses").doc(user_id);

    // Use server timestamp for accuracy
    data.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    await docRef.set(data, { merge: true });
    console.log(`✅ Progress saved successfully for user ${user_id} on mock ${mock_id}.`);
    res.json({ message: "Progress saved successfully" });
  } catch (error) {
    console.error(`❌ Error saving progress for user ${user_id} on mock ${mock_id}:`, error);
    res.status(500).json({ error: `Failed to save progress: ${error.message}` });
  }
});

// Route to submit test
app.post('/mocks/:mock_id/responses/:user_id/submit', async (req, res) => {
  try {
    const { mock_id, user_id } = req.params;
    const data = req.body;
    if (!data) {
      console.warn("⚠️ Test submission: Request body is empty.");
      return res.status(400).json({ error: "Request body must be JSON" });
    }

    const userResponseDocRef = db.collection("mocks").doc(mock_id).collection("Responses").doc(user_id);
    const userIncorrectDocRef = db.collection("users").doc(user_id).collection("incorrect_responses").doc(mock_id);

    // Check if test was previously submitted to avoid double incrementing attemptedCount
    const userResponseSnap = await userResponseDocRef.get();
    const wasPreviouslySubmitted = userResponseSnap.exists && userResponseSnap.data().isTestSubmitted;

    // Update user response document
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
    console.log(`✅ User response document updated for submission for user ${user_id} on mock ${mock_id}.`);

    // Save incorrect questions
    const incorrectQuestionsData = data.incorrectQuestionsData || {};
    if (Object.keys(incorrectQuestionsData).length > 0) {
      await userIncorrectDocRef.set(incorrectQuestionsData, { merge: true });
      console.log(`✅ Incorrect questions data saved for user ${user_id} on mock ${mock_id}.`);
    } else {
      // If no incorrect questions, ensure the document is deleted or empty
      await userIncorrectDocRef.delete();
      console.log(`✅ No incorrect questions. Document deleted for user ${user_id} on mock ${mock_id}.`);
    }

    // Increment attempted count for the mock only if it's a new submission
    if (!wasPreviouslySubmitted) {
      const mockDocRef = db.collection("mocks").doc(mock_id);
      const mockDocSnap = await mockDocRef.get();
      if (mockDocSnap.exists) {
        const currentAttemptedCount = parseInt(mockDocSnap.data().attemptedCount || "0", 10);
        await mockDocRef.update({
          attemptedCount: String(currentAttemptedCount + 1)
        });
        console.log(`✅ Mock attempted count incremented for mock ${mock_id}.`);
      }
    }

    res.json({ message: "Test submitted successfully" });
  } catch (error) {
    console.error(`❌ Error submitting test for user ${user_id} on mock ${mock_id}:`, error);
    res.status(500).json({ error: `Failed to submit test: ${error.message}` });
  }
});

// Route to delete user responses (for reattempt)
app.delete('/mocks/:mock_id/responses/:user_id', async (req, res) => {
  try {
    const { mock_id, user_id } = req.params;
    const userResponseDocRef = db.collection("mocks").doc(mock_id).collection("Responses").doc(user_id);
    const userIncorrectDocRef = db.collection("users").doc(user_id).collection("incorrect_responses").doc(mock_id);

    await userResponseDocRef.delete();
    console.log(`✅ User response document deleted for user ${user_id} on mock ${mock_id}.`);
    await userIncorrectDocRef.delete();
    console.log(`✅ User incorrect responses document deleted for user ${user_id} on mock ${mock_id}.`);

    res.json({ message: "Previous responses deleted successfully" });
  } catch (error) {
    console.error(`❌ Error deleting responses for user ${user_id} on mock ${mock_id}:`, error);
    res.status(500).json({ error: `Failed to delete previous responses: ${error.message}` });
  }
});

// Check user authentication status
app.get('/check-user-status', async (req, res) => {
  console.log("🔹 Received request at /check-user-status");
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.error("❌ Unauthorized access. No token provided or token format invalid.");
    return res.status(401).json({ status: "no-auth", message: "No token provided or token format invalid." });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decodedToken = await auth.verifyIdToken(token);
    const userId = decodedToken.uid;
    console.log(`✅ Token verified for user: ${userId}`);

    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      console.error(`❌ User with ID ${userId} not found.`);
      return res.status(404).json({ status: "not-found", message: "User not found." });
    }

    const userData = userDoc.data();
    const creationTime = userData.creationTime || decodedToken.auth_time * 1000; // Use userData.creationTime if available
    const emailVerified = decodedToken.email_verified;
    const currentTime = Date.now();
    const timeDiffInHours = (currentTime - new Date(creationTime).getTime()) / (1000 * 3600);
    const isGuest = userData.isGuest;

    if (timeDiffInHours > 24) {
      console.log("Session expired: More than 24 hours has passed.");
      if (isGuest) {
        console.log("User is a guest, requiring login.");
        return res.json({ status: "guest-login-required" });
      } else if (!emailVerified) {
        console.log("User is not a guest but email is not verified.");
        return res.json({ status: "email-verification-required" });
      } else {
        console.log("User is authenticated, sending user data.");
        return res.json({ status: "authenticated", data: userData });
      }
    } else {
      console.log("Session is still valid: Less than 24 hours has passed.");
      return res.json({ status: "authenticated", data: userData });
    }

  } catch (error) {
    console.error("❌ Error verifying user:", error);
    return res.status(500).json({
      status: "error",
      message: `Internal server error during user status check: ${error.message}`,
      error: error.message
    });
  }
});

// Get user data including ranking and attempted questions
app.get('/get-user-data', async (req, res) => {
  console.log("🔹 Received request at /get-user-data");
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.error("❌ Unauthorized access. No token provided or token format invalid.");
    return res.status(401).json({ status: 'error', message: 'Unauthorized access. No token provided.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decodedToken = await auth.verifyIdToken(token);
    const userId = decodedToken.uid;
    console.log(`✅ Token verified for user: ${userId}`);

    const userDoc = await db.collection('users').doc(userId).get();
    let rankingDoc = await db.collection('ranking').doc(userId).get();

    if (!userDoc.exists) {
      console.error(`❌ User data not found for user ID ${userId}.`);
      return res.status(404).json({ status: 'error', message: 'User data not found.' });
    }

    if (!rankingDoc.exists) {
      console.warn(`⚠️ Ranking data not found for user ID ${userId}. Creating default ranking document.`);
      await db.collection('ranking').doc(userId).set({
        rank: 0,
        markAccuracy: 0,
        username: userDoc.data().username || 'Anonymous',
        timeAccuracy: 0,
      });
      rankingDoc = await db.collection('ranking').doc(userId).get(); // Fetch again after creation
    }

    const userData = userDoc.data();
    const rankingData = rankingDoc.data();
    console.log("User Data:", userData);
    console.log("Ranking Data:", rankingData);

    const correctCount = countQuestionIDs(userData.correctAttempted_questionsIDs || {});
    const wrongCount = countQuestionIDs(userData.wrongAttempted_questionsIDs || {});
    const userFilteredData = [
      correctCount,
      wrongCount,
      userData.username || 'Unknown',
      decodedToken.email || 'N/A',
      rankingData.rank || 0,
      userData.total_time_Taken || 0,
      decodedToken.email_verified || false,
      userData.creationTime || null,
      rankingData.markAccuracy || 0,
      userData.correctAttempted_questionsIDs || {},
      userData.wrongAttempted_questionsIDs || {},
      userData.tokens,
    ];

    res.json({ status: 'success', userFilteredData });
  } catch (error) {
    console.error('❌ Error fetching user data:', error);
    res.status(500).json({
      status: 'error',
      message: `Failed to retrieve user data: ${error.message}`,
      error: error.message
    });
  }
});

// Get questions for a test
app.get('/get-questions', async (req, res) => {
  console.log("🔹 Received request at /get-questions");

  const authHeader = req.headers.authorization;
  const batchSize = parseInt(req.query.batchSize) || 5;
  const retryLimit = parseInt(req.query.retryLimit) || 3;
  console.log(`🔹 Batch size: ${batchSize}, Retry limit: ${retryLimit}`);

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.warn("⚠️ Unauthorized access. No token provided.");
    return res.status(401).json({ status: 'error', message: 'Unauthorized access. No token provided.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    console.log("🔹 Verifying Firebase ID token...");
    const decodedToken = await auth.verifyIdToken(token);
    const userId = decodedToken.uid;
    console.log(`✅ Token verified for user: ${userId}`);

    console.log("🔹 Fetching user document...");
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      console.warn(`⚠️ User not found: ${userId}`);
      return res.status(404).json({ status: 'error', message: 'User not found.' });
    }

    const userData = userDoc.data();
    const creationTime = userData.creationTime || decodedToken.auth_time * 1000;
    const emailVerified = decodedToken.email_verified;
    const currentTime = Date.now();
    const timeDiffInHours = (currentTime - new Date(creationTime).getTime()) / (1000 * 3600);
    const isGuest = userData.isGuest;

    if (timeDiffInHours > 24) {
      if (isGuest) {
        return res.json({ status: "guest-login-required" });
      }
      if (!emailVerified) {
        return res.json({ status: "email-verification-required" });
      }
    }

    console.log("✅ User data fetched successfully.");

    let categories = ["english"]; // Default category

    if (req.query.selectedCategories) {
      try {
        // Attempt to parse as JSON array first
        categories = JSON.parse(req.query.selectedCategories);
      } catch (e) {
        // If JSON parsing fails, check if it's a plain string like 'PYQ'
        if (e instanceof SyntaxError) {
          categories = [req.query.selectedCategories]; // Treat as a single category string in an array
        } else {
          console.error('Error parsing selectedCategories:', e);
          return res.status(400).json({ error: 'Invalid selectedCategories format' });
        }
      }

      if (!Array.isArray(categories) || categories.length === 0) {
        throw new Error("Selected categories must be a non-empty array.");
      }
      console.log("✅ Selected categories:", categories);
    }

    const category = categories[Math.floor(Math.random() * categories.length)];
    console.log("🔹 Using category:", category);

    console.log("🔹 Fetching category document...");
    const categoryDoc = await db.collection('questions').doc(category).get();
    if (!categoryDoc.exists) {
      console.warn(`⚠️ Category not found: ${category}`);
      return res.status(404).json({ status: 'error', message: 'Category not found.' });
    }

    const categoryData = categoryDoc.data();
    console.log("✅ Category data fetched successfully.");

    const totalQuestions = categoryData.totalQuestions;
    if (!totalQuestions) {
      console.warn(`⚠️ No questions available in category: ${category}`);
      return res.status(404).json({ status: 'error', message: 'No questions available in this category.' });
    }
    console.log(`🔹 Total questions in category '${category}': ${totalQuestions}`);

    // Function to extract question IDs from a given data structure
    const extractQuestionIDs = (data) => {
      const questionIDsArray = [];
      for (const subject in data) {
        const subjectData = data[subject];
        for (const date in subjectData) {
          const dateData = subjectData[date];
          const questionIDs = Object.keys(dateData);
          questionIDsArray.push(...questionIDs);
        }
      }
      return questionIDsArray;
    };

    const correctAttemptedQuestionsIDs = userData.correctAttempted_questionsIDs || {};
    const wrongAttemptedQuestionsIDs = userData.wrongAttempted_questionsIDs || {};

    const correctQuestionIDs = extractQuestionIDs(correctAttemptedQuestionsIDs);
    const wrongQuestionIDs = extractQuestionIDs(wrongAttemptedQuestionsIDs);
    const combinedUniqueAttemptedIDs = new Set([...correctQuestionIDs, ...wrongQuestionIDs]);
    console.log(`🔹 User has attempted ${combinedUniqueAttemptedIDs.size} unique questions.`);

    const fetchedQuestions = [];
    const randomIDs = new Set();
    let retriesCount = 0;

    // Loop to fetch unique, unattempted questions
    while (fetchedQuestions.length < batchSize && retriesCount < retryLimit * batchSize * 2) { // Increased retry multiplier
      const randomIndex = Math.floor(Math.random() * totalQuestions) + 1;
      const randomQuestionID = `question_${randomIndex}`;

      if (randomIDs.has(randomQuestionID)) {
        retriesCount++;
        continue; // Already tried this random ID
      }
      randomIDs.add(randomQuestionID);

      const questionDoc = await db
        .collection('questions')
        .doc(category)
        .collection('allQuestions')
        .doc(randomQuestionID)
        .get();

      if (!questionDoc.exists) {
        console.warn(`⚠️ Question document not found: ${randomQuestionID}. Skipping.`);
        retriesCount++;
        continue;
      }

      const questionData = questionDoc.data();
      if (!questionData || !questionData.encryptedData) {
        console.warn(`⚠️ Question data or encryptedData missing for ${randomQuestionID}. Skipping.`);
        retriesCount++;
        continue;
      }

      try {
        const decryptedBytes = CryptoJS.AES.decrypt(questionData.encryptedData, actualKey);
        const decryptedJsonString = decryptedBytes.toString(CryptoJS.enc.Utf8);
        
        if (!decryptedJsonString || decryptedJsonString.trim() === "") {
          throw new Error("Decryption resulted in empty or invalid JSON");
        }
        const parsedData = JSON.parse(decryptedJsonString);
        
        const decryptedQuestionID = parsedData.questionID;
        if (combinedUniqueAttemptedIDs.has(decryptedQuestionID)) {
          console.log(`⚠️ Question with ID '${decryptedQuestionID}' is already attempted. Skipping.`);
          retriesCount++;
          continue; // Skip already attempted questions
        }

        fetchedQuestions.push({
          id: randomQuestionID, // Firestore document ID
          likes: questionData.likes || {},
          dislikes: questionData.dislikes || {},
          correctlyAttempted: questionData.correctlyAttempted || 0,
          wronglyAttempted: questionData.wronglyAttempted || 0,
          data: parsedData, // Decrypted question content
        });
        console.log(`✅ Question decrypted and added: ${randomQuestionID}`);

      } catch (decryptError) {
        console.error(`❌ Error decrypting or parsing data for ${randomQuestionID}:`, decryptError);
        retriesCount++;
      }
    }

    if (fetchedQuestions.length < 2) { // Ensure at least 2 questions are returned
      console.warn("⚠️ Less than 2 new questions could be fetched after retries. User might have attempted all questions.");
      return res.json({ status: 'error', message: 'You have attempted all the available questions in this category or not enough new questions are available.' });
    }

    res.json({ status: 'success', questions: fetchedQuestions });
  } catch (error) {
    console.error("❌ Error in /get-questions:", error);
    res.status(500).json({ status: 'error', message: `Failed to retrieve questions: ${error.message}`, error: error.message });
  }
});

// Notification API (FCM setup required for full functionality)
app.post('/api/notify', async (req, res) => {
  console.log("🔹 Received request at /api/notify");
  const { toUid, fromUsername, message, chatId } = req.body;
  if (!toUid || !message) {
    console.warn("⚠️ /api/notify: Missing fields.");
    return res.status(400).send('Missing fields');
  }

  try {
    const userSnap = await db.doc(`users/${toUid}`).get();
    const token = userSnap.data()?.fcmToken;
    if (!token) {
      console.log(`⚠️ No FCM token for user ${toUid}. Cannot send notification.`);
      return res.sendStatus(204); // No content, but successful processing
    }

    const payload = {
      notification: {
        title: `New message from ${fromUsername}`,
        body: message.length > 50 ? message.slice(0, 47) + '…' : message,
        // Ensure this clickAction URL is correct for your web app
        clickAction: `https://YOUR-WEB-APP.COM/?chat=${encodeURIComponent(chatId)}`
      },
      data: {
        chatId,
        sender: fromUsername
      }
    };

    // Uncomment the following line if you have Firebase Cloud Messaging (FCM) set up
    // and 'admin.messaging()' is properly initialized.
    // await admin.messaging().sendToDevice(token, payload);
    console.log("FCM send call is commented out. Ensure Firebase Cloud Messaging is configured if needed.");
    res.sendStatus(200);

  } catch (err) {
    console.error("❌ Error sending notification:", err);
    res.status(500).send(`Failed to send notification: ${err.message}`);
  }
});

// Handle like/dislike actions on questions
app.post('/handle-like-dislike', async (req, res) => {
  console.log("🔹 Received request at /handle-like-dislike");
  const authHeader = req.headers.authorization;
  const { id, action, currentSubject } = req.body;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.warn("⚠️ Unauthorized access. Missing or invalid token.");
    return res.status(401).json({ status: 'error', message: 'Unauthorized access. No token provided.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decodedToken = await auth.verifyIdToken(token);
    const userID = decodedToken.uid;
    console.log(`✅ Token verified. User ID: ${userID}`);

    if (!id || !['like', 'dislike'].includes(action) || !currentSubject) {
      console.warn("⚠️ Invalid request payload for like/dislike:", { id, action, currentSubject });
      return res.status(400).json({ status: 'error', message: 'Invalid request payload.' });
    }

    const questionRef = db.doc(`questions/${currentSubject}/allQuestions/${id}`);
    const questionDoc = await questionRef.get();

    if (!questionDoc.exists) {
      console.warn(`⚠️ Question not found for id: ${id} in subject: ${currentSubject}`);
      return res.status(404).json({ status: 'error', message: 'Question not found.' });
    }

    let { likes = {}, dislikes = {} } = questionDoc.data();

    if (action === 'like') {
      if (likes[userID]) {
        delete likes[userID]; // User already liked, so unlike
        console.log("🔹 User unliked the question.");
      } else {
        likes[userID] = true; // User likes, add like
        delete dislikes[userID]; // Remove dislike if present
        console.log("🔹 User liked the question.");
      }
    } else if (action === 'dislike') {
      if (dislikes[userID]) {
        delete dislikes[userID]; // User already disliked, so undislike
        console.log("🔹 User undisliked the question.");
      } else {
        dislikes[userID] = true; // User dislikes, add dislike
        delete likes[userID]; // Remove like if present
        console.log("🔹 User disliked the question.");
      }
    }

    await questionRef.update({ likes, dislikes });
    console.log("✅ Question likes/dislikes updated successfully.");

    res.json({
      status: 'success',
      message: `You ${action}d this question!`,
      likes: Object.keys(likes).length,
      dislikes: Object.keys(dislikes).length,
    });
  } catch (error) {
    console.error("❌ Error handling like/dislike:", error);
    res.status(500).json({ status: 'error', message: `Failed to handle like/dislike: ${error.message}` });
  }
});

// Submit answer and update user/question stats
app.post('/submit-answer', async (req, res) => {
  console.log("🔹 Received request at /submit-answer");
  const authHeader = req.headers.authorization;
  const { questionID, elapsedTime, answerTrueOrNot, id } = req.body; // 'id' here refers to Firestore doc ID for the question

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.warn("⚠️ Unauthorized access. Missing or invalid token.");
    return res.status(401).json({ status: 'error', message: 'Unauthorized access. No token provided.' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decodedToken = await auth.verifyIdToken(token);
    const userId = decodedToken.uid;
    console.log(`✅ Token verified. User ID: ${userId}`);

    if (!questionID || elapsedTime === undefined || answerTrueOrNot === undefined || !id) {
      console.warn("⚠️ Invalid request payload for submit-answer:", { questionID, elapsedTime, answerTrueOrNot, id });
      return res.status(400).json({ status: 'error', message: 'Invalid request payload. Missing data.' });
    }

    const userDocRef = db.collection('users').doc(userId);
    const userSnapshot = await userDocRef.get();
    const userData = userSnapshot.data();

    if (!userData || userData.tokens === undefined) {
        console.error(`❌ User data or tokens not found for user ${userId}`);
        return res.status(500).json({ status: 'error', message: 'User data or tokens not found.' });
    }

    // Token deduction logic
    if (userData.tokens <= 0) {
      return res.status(403).json({ status: 'error', message: `No sufficient tokens. You have ${userData.tokens} token. Please refill them.` });
    }
    console.log("✅ Token balance sufficient.");

    // Update total time taken for the user
    await userDocRef.update({
      total_time_Taken: admin.firestore.FieldValue.increment(elapsedTime)
    });
    console.log("✅ User's total time updated.");

    const today = new Date().toLocaleDateString('en-GB').replace(/\//g, '-'); // dd-mm-yyyy

    // Extract category and subject from questionID (assumes questionID format: "Category Subject ...")
    const parts = questionID.split(' ');
    if (parts.length < 2) {
      console.warn("⚠️ Invalid questionID format for submit-answer:", questionID);
      return res.status(400).json({ status: 'error', message: 'Invalid questionID format.' });
    }

    const category = parts[0].toLowerCase();
    const subject = parts[1];

    // Determine the field to update (correctAttempted_questionsIDs or wrongAttempted_questionsIDs)
    const field = answerTrueOrNot ? 'correctAttempted_questionsIDs' : 'wrongAttempted_questionsIDs';

    // Use a transaction to ensure atomicity for complex updates
    await db.runTransaction(async (transaction) => {
        const currentUserDoc = await transaction.get(userDocRef);
        const currentUserData = currentUserDoc.data();

        // Update user's attempted question data
        const updatedFieldData = { ... (currentUserData[field] || {}) };
        if (!updatedFieldData[category]) updatedFieldData[category] = {};
        if (!updatedFieldData[category][subject]) updatedFieldData[category][subject] = {};
        if (!updatedFieldData[category][subject][today]) updatedFieldData[category][subject][today] = {};

        updatedFieldData[category][subject][today][questionID] = elapsedTime;
        transaction.update(userDocRef, { [field]: updatedFieldData });
        console.log("✅ User's attempted question data updated in transaction.");

        // Update question counters (correctlyAttempted/wronglyAttempted)
        const questionRef = db.doc(`questions/${category}/allQuestions/${id}`);
        const questionDoc = await transaction.get(questionRef);

        if (!questionDoc.exists) {
            console.warn(`⚠️ Question not found for id: ${id}. Cannot update question counters.`);
            // You might want to throw an error here if question must exist
            return; // Exit transaction if question doesn't exist
        }

        let currentQuestionData = questionDoc.data();
        let newCorrectlyAttempted = currentQuestionData.correctlyAttempted || 0;
        let newWronglyAttempted = currentQuestionData.wronglyAttempted || 0;
        let newTokens = currentUserData.tokens;

        if (answerTrueOrNot) {
          newCorrectlyAttempted += 1;
          newTokens += 0.5; // Award tokens for correct answer
        } else {
          newWronglyAttempted += 1;
          newTokens -= 1; // Deduct tokens for wrong answer
        }

        transaction.update(questionRef, {
          correctlyAttempted: newCorrectlyAttempted,
          wronglyAttempted: newWronglyAttempted
        });
        console.log("✅ Question counters updated in transaction.");

        // Update user's token count
        transaction.update(userDocRef, { tokens: newTokens });
        console.log(`✅ User tokens updated to ${newTokens} in transaction.`);
    });

    res.json({ status: 'success', message: 'Answer submitted successfully.' });
  } catch (error) {
    console.error("❌ Error submitting answer:", error);
    res.status(500).json({ status: 'error', message: `Failed to submit answer: ${error.message}`, error: error.message });
  }
});

// Report a question
app.post('/report-question', async (req, res) => {
  console.log("🔹 Received request at /report-question");
  const authHeader = req.headers.authorization;
  const { questionID } = req.body;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.warn("⚠️ /report-question: Unauthorized access. No token provided.");
    return res.status(401).json({ status: 'error', message: 'Unauthorized access. No token provided.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decodedToken = await auth.verifyIdToken(token);
    const userId = decodedToken.uid;
    console.log("✅ Token verified. User ID:", userId);

    if (!questionID) {
      console.warn("⚠️ /report-question: Invalid request. Question ID is missing.");
      return res.status(400).json({ status: 'error', message: 'Invalid request. Question ID is missing.' });
    }

    const reportedQuestionsRef = db.collection('reportedQuestions');
    await reportedQuestionsRef.add({
      questionID: questionID,
      reportedAt: admin.firestore.FieldValue.serverTimestamp(),
      userId: userId,
    });

    console.log("✅ Question reported successfully.");
    res.json({ status: 'success', message: 'Question reported successfully.' });
  } catch (error) {
    console.error("❌ /report-question: Error reporting question:", error);
    return res.status(500).json({ status: 'error', message: `Failed to report question: ${error.message}`, error: error.message });
  }
});

// Update question time (likely for tracking time spent per question)
app.post('/update-question-time', async (req, res) => {
  console.log("🔹 Received request at /update-question-time");
  const authHeader = req.headers.authorization;
  const { questionID, elapsedTime, field, currentDate } = req.body; // 'field' is like 'correctAttempted_questionsIDs' or 'wrongAttempted_questionsIDs'

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.warn("⚠️ /update-question-time: Unauthorized access. No token provided.");
    return res.status(401).json({ status: 'error', message: 'Unauthorized access. No token provided.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decodedToken = await auth.verifyIdToken(token);
    const userId = decodedToken.uid;
    console.log("✅ Token verified. User ID:", userId);

    if (!questionID || elapsedTime === undefined || field === undefined || !currentDate) {
      console.warn("⚠️ /update-question-time: Invalid request. Missing data:", { questionID, elapsedTime, field, currentDate });
      return res.status(400).json({ status: 'error', message: 'Invalid request. Missing data.' });
    }

    const userDocRef = db.collection('users').doc(userId);
    const userDoc = await userDocRef.get();

    if (!userDoc.exists) {
      console.warn(`⚠️ /update-question-time: User document not found for user ${userId}`);
      return res.status(404).json({ status: 'error', message: 'User document not found.' });
    }

    const userData = userDoc.data();
    let fieldData = userData[field] || {};

    // Parse questionID to extract subject and chapter (adjust parsing as needed)
    // Assuming questionID format: "Category Subject Chapter QuestionID" or "Subject Chapter QuestionID"
    const idParts = questionID.split(' ');
    let subject, chapter;

    if (idParts.length >= 3) { // Assuming format like "Maths LCM_HCF 00027"
        subject = idParts[0];
        chapter = idParts[1];
    } else if (idParts.length === 2) { // Assuming format like "English Antonym" if chapter is part of subject
        subject = idParts[0];
        chapter = idParts[1]; // Or adjust this based on actual questionID structure
    } else {
        console.warn("⚠️ /update-question-time: Unrecognized question ID format:", questionID);
        return res.status(400).json({ status: 'error', message: 'Unrecognized question ID format.' });
    }


    if (!fieldData[subject]) {
      fieldData[subject] = {};
    }
    if (!fieldData[subject][currentDate]) {
      fieldData[subject][currentDate] = {};
    }
    if (!fieldData[subject][currentDate][chapter]) {
      fieldData[subject][currentDate][chapter] = {};
    }

    fieldData[subject][currentDate][chapter][questionID] = elapsedTime;

    await userDocRef.update({ [field]: fieldData });
    console.log("✅ User document updated with question time data.");
    res.json({ status: 'success', message: 'Data updated successfully.' });

  } catch (error) {
    console.error("❌ /update-question-time: Error processing request:", error);
    return res.status(500).json({ status: 'error', message: `Failed to update question time: ${error.message}`, error: error.message });
  }
});

// Function to update all user ranks based on markAccuracy and timeAccuracy
async function updateAllRanks() {
  console.log("🔹 Updating all ranks...");
  try {
    const snapshot = await db.collection("ranking").get();
    let users = [];

    snapshot.forEach((doc) => {
      let data = doc.data();
      users.push({
        userId: doc.id,
        rank: data.rank || 0,
        name: data.username || "Anonymous",
        markAccuracy: data.markAccuracy || 0,
        timeAccuracy: data.timeAccuracy || 0,
      });
    });
    console.log(`🔹 Fetched ${users.length} users from ranking collection.`);

    // Sort users by markAccuracy (desc), then timeAccuracy (desc), then name (asc)
    users.sort((a, b) => {
      if (b.markAccuracy !== a.markAccuracy) {
        return b.markAccuracy - a.markAccuracy;
      } else if (b.timeAccuracy !== a.timeAccuracy) {
        return b.timeAccuracy - a.timeAccuracy;
      } else {
        return a.name.localeCompare(b.name);
      }
    });
    console.log("🔹 Users sorted for ranking calculation.");

    // Update ranks in Firestore using a batch write for efficiency
    const batch = db.batch();
    users.forEach((user, index) => {
      const userDocRef = db.collection("ranking").doc(user.userId);
      batch.update(userDocRef, { rank: index + 1 });
    });

    await batch.commit();
    console.log("✅ Ranks updated successfully in Firestore.");
  } catch (error) {
    console.error("❌ Error updating ranks:", error);
    // Re-throw or handle as needed, but avoid sending HTTP response here as it's a background task
  }
}

// Endpoint to manually trigger rank update (for testing/admin purposes)
app.post("/trigger-rank-update", async (req, res) => {
  console.log("🔹 Received request at /trigger-rank-update");
  try {
    await updateAllRanks();
    console.log("✅ Ranks updated successfully via /trigger-rank-update endpoint.");
    res.json({ status: "success", message: "Ranks updated successfully." });
  } catch (error) {
    console.error("❌ /trigger-rank-update error:", error);
    res.status(500).json({ status: 'error', message: `Failed to trigger rank update: ${error.message}`, error: error.message });
  }
});

// User authentication (login/signup)
app.post("/auth", async (req, res) => {
  console.log("🔹 Received /auth request.");
  const { email, password, name } = req.body;

  if (!email || !password || !name) {
    console.warn("⚠️ /auth: Validation Error: Missing fields.");
    return res.status(400).json({ message: "Fields cannot be empty" });
  }

  try {
    // Attempt to get user by email (login)
    const user = await auth.getUserByEmail(email);
    console.log(`✅ Login successful for userId: ${user.uid}`);
    return res.json({ message: "Login successful", userId: user.uid });
  } catch (error) {
    if (error.code === "auth/user-not-found") {
      console.log("🔹 User not found. Attempting to create new account...");
      try {
        // Create new user if not found
        const userRecord = await auth.createUser({ email, password, displayName: name });
        const userId = userRecord.uid;
        const creationTime = Date.now();
        console.log(`✅ User created successfully: ${userId}`);

        const isGuest = email.toLowerCase().includes('guest');
        console.log(`🔹 Setting isGuest as: ${isGuest} for user ${email}`);

        // Store user data in Firestore
        await db.collection("users").doc(userId).set({
          correctAttempted_questionsIDs: {},
          total_time_Taken: 0,
          wrongAttempted_questionsIDs: {},
          username: name,
          creationTime: creationTime,
          isGuest: isGuest,
          rank: 0,
          markAccuracy: 0,
          timeAccuracy: 0,
          tokens: 100, // Initial tokens
        });
        console.log(`✅ Firestore 'users' data stored for userId: ${userId}`);

        // Create ranking data in Firestore
        await db.collection("ranking").doc(userId).set({
          rank: 0,
          markAccuracy: 0,
          username: name,
          timeAccuracy: 0,
        });
        console.log(`✅ Firestore 'ranking' data stored for userId: ${userId}`);

        return res.status(201).json({ message: "Account created successfully", userId });
      } catch (err) {
        console.error("❌ /auth: Error creating user:", err.message, err);
        return res.status(500).json({ message: `Error creating user: ${err.message}`, error: err.message });
      }
    }
    console.error("❌ /auth: Login failed:", error.message);
    return res.status(500).json({ message: `Login failed: ${error.message}`, error: error.message });
  }
});

// Convert guest account to full account
app.post("/guest-auth", async (req, res) => {
  console.log("🔹 Received /guest-auth request.");
  const { email, password, name, uid } = req.body;

  if (!email || !password || !name || !uid) {
    console.warn("⚠️ /guest-auth: Validation Error: Missing fields.");
    return res.status(400).json({ message: "Fields cannot be empty" });
  }

  try {
    console.log(`🔹 Updating user with UID: ${uid}`);

    // Update Firebase Authentication details
    await auth.updateUser(uid, {
      email: email,
      password: password,
      displayName: name,
      emailVerified: false // Mark as not verified yet, verification email to be sent separately
    });
    console.log("✅ User authentication details updated successfully.");

    // Update Firestore: users collection
    await db.collection("users").doc(uid).update({
      username: name,
      isGuest: false,
      tokens: admin.firestore.FieldValue.increment(100) // Give initial tokens
    }, { merge: true });
    console.log(`✅ Firestore 'users' updated for UID: ${uid}.`);

    // Update Firestore: ranking collection
    await db.collection("ranking").doc(uid).update({
      username: name
    }, { merge: true });
    console.log(`✅ Firestore 'ranking' updated for UID: ${uid}.`);

    return res.json({ message: "User updated successfully", userId: uid });
  } catch (err) {
    console.error("❌ /guest-auth: Error updating user:", err.message);
    return res.status(500).json({ message: `Error updating user: ${err.message}`, error: err.message });
  }
});

// Reset user password
app.post("/reset-password", async (req, res) => {
  console.log("🔹 Received /reset-password request.");
  const { email } = req.body;
  if (!email) {
    console.warn("⚠️ /reset-password: Validation Error: Email is required.");
    return res.status(400).json({ message: "Email is required" });
  }

  try {
    console.log(`🔹 Attempting to send password reset email to: ${email}`);
    await auth.generatePasswordResetLink(email);
    console.log("✅ Password reset email sent successfully.");
    return res.json({ message: "Password reset link sent to your email." });
  } catch (error) {
    console.error(`❌ /reset-password: Password reset failed for ${email}:`, error.message);
    return res.status(500).json({ status: 'error', message: `Password reset failed: ${error.message}`, error: error.message });
  }
});

// Send email verification link
app.post("/send-verification", async (req, res) => {
  console.log("🔹 Received /send-verification request.");
  const { uid } = req.body;

  if (!uid) {
    console.warn("⚠️ /send-verification: Validation Error: User ID is required.");
    return res.status(400).json({ message: "User ID is required" });
  }

  try {
    const user = await auth.getUser(uid);
    console.log(`🔹 Generating email verification link for user: ${user.email}`);
    const emailVerificationLink = await auth.generateEmailVerificationLink(user.email);
    console.log("✅ Email verification link generated successfully.");
    return res.json({ message: "Verification email sent", link: emailVerificationLink });
  } catch (error) {
    console.error(`❌ /send-verification: Error sending verification email for userId ${uid}:`, error.message);
    return res.status(500).json({ status: 'error', message: `Failed to send verification email: ${error.message}`, error: error.message });
  }
});

// Check email verification status
app.get("/check-verification", async (req, res) => {
  console.log("🔹 Received /check-verification request.");
  const { uid } = req.query;

  if (!uid) {
    console.warn("⚠️ /check-verification: Validation Error: User ID is required.");
    return res.status(400).json({ message: "User ID is required" });
  }

  try {
    const user = await auth.getUser(uid);
    console.log(`✅ /check-verification: Fetched user data for uid: ${uid}. Email verified: ${user.emailVerified}`);
    return res.json({ verified: user.emailVerified });
  } catch (error) {
    console.error(`❌ /check-verification: Error checking verification status for userId ${uid}:`, error.message);
    return res.status(500).json({ status: 'error', message: `Failed to check verification status: ${error.message}`, error: error.message });
  }
});

// Update user rank data (markAccuracy, timeAccuracy, username)
app.post('/update-user-rank', async (req, res) => {
  console.log("🔹 Received /update-user-rank request.");
  const { userId, markAccuracy, timeAccuracy, username } = req.body;

  if (!userId || markAccuracy === undefined || timeAccuracy === undefined) {
    console.warn("⚠️ /update-user-rank: Invalid data received:", { userId, markAccuracy, timeAccuracy, username });
    return res.status(400).json({ status: 'error', message: 'Invalid data received.' });
  }

  try {
    const userDocRef = db.collection('ranking').doc(userId);
    const userDoc = await userDocRef.get();

    if (!userDoc.exists) {
      console.warn(`⚠️ /update-user-rank: User not found in ranking collection for userId: ${userId}.`);
      // Optionally create the document if it doesn't exist, or return 404
      return res.status(404).json({ status: 'error', message: 'User not found in ranking collection.' });
    }

    await userDocRef.set(
      {
        markAccuracy,
        timeAccuracy,
        username,
      },
      { merge: true }
    );
    console.log(`✅ /update-user-rank: Rank updated successfully for userId: ${userId}.`);
    res.json({ status: 'success', message: 'Rank updated successfully.' });
  } catch (error) {
    console.error("❌ /update-user-rank: Error updating rank data:", error.message, error);
    return res.status(500).json({ status: 'error', message: `Failed to update rank data: ${error.message}`, error: error.message });
  }
});

// Get global rankings
app.get('/rankings', async (req, res) => {
  console.log("🔹 Received request at /rankings");

  try {
    const collectionRef = db.collection("ranking");
    
    // Fetch top 10 rankings ordered by 'rank' field
    const rankingSnapshot = await collectionRef.orderBy("rank").limit(10).get();

    if (rankingSnapshot.empty) {
      console.warn("⚠️ Query returned no rankings!");
      return res.json({ rankings: [] });
    }

    const rankings = [];
    rankingSnapshot.forEach(doc => {
      const data = doc.data();
      // Only include documents that have a valid rank (not 0 or undefined)
      if (data.rank !== undefined && data.rank !== 0) {
        rankings.push({
          rank: data.rank,
          username: data.username || "Anonymous",
          markAccuracy: data.markAccuracy ?? "N/A",
          timeAccuracy: data.timeAccuracy ?? "N/A"
        });
      }
    });

    console.log("✅ Rankings fetched successfully:", rankings.length > 0 ? rankings : "No valid rankings found.");
    res.json({ rankings });

  } catch (error) {
    console.error("❌ /rankings: Error fetching rankings:", error);
    return res.status(500).json({ status: 'error', message: `Failed to retrieve rankings: ${error.message}`, error: error.message });
  }
});

// Update user tokens based on game events (e.g., from a coin flip game)
app.post("/updateTokens", async (req, res) => {
  console.log("🔹 Received updateTokens request:", req.body);
  const { userId, gameEvents } = req.body;

  if (!userId || !Array.isArray(gameEvents) || gameEvents.length !== 6 || !gameEvents.every((event) => event === "token" || event === "ad")) {
    console.error("❌ Invalid game data received:", req.body);
    return res.status(400).send({ success: false, error: "Invalid game data" });
  }

  // Recalculate tokens securely on the server.
  const tokenEventsCount = gameEvents.filter((event) => event === "token").length;
  const randomBonus = Math.floor(Math.random() * 5) + 1; // Bonus between 1 and 5
  const tokensAwarded = tokenEventsCount * randomBonus;
  console.log(`🔹 Token events: ${tokenEventsCount}, Random bonus: ${randomBonus}, Total tokens awarded: ${tokensAwarded}`);

  try {
    const userDocRef = db.collection("users").doc(userId);
    console.log("Updating tokens for user:", userId);
    await userDocRef.update({
      tokens: admin.firestore.FieldValue.increment(tokensAwarded),
    });
    console.log(`✅ Successfully updated tokens for user ${userId}. Awarded: ${tokensAwarded}`);
    res.send({ success: true, tokensAwarded });
  } catch (error) {
    console.error(`❌ Error updating tokens for user ${userId}:`, error);
    return res.status(500).json({ status: 'error', message: `Failed to update tokens: ${error.message}`, error: error.message });
  }
});


// Background task to update all ranks periodically
// This will run every 24 hours (24 * 60 * 60 * 1000 milliseconds)
setInterval(() => {
  console.log("🔹 Triggering scheduled rank update...");
  updateAllRanks().catch(error => {
    console.error("❌ Error during scheduled rank update:", error);
  });
}, 24 * 60 * 60 * 1000);

// Start the server
app.listen(port, () => {
  console.log(`✅ Server is running on port ${port}`);
});
