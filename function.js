require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { getFirestore, getDoc, setDoc, updateDoc, doc } = require('firebase-admin/firestore');
const { getAuth } = require("firebase-admin/auth");
const CryptoJS = require("crypto-js");

const app = express();
const port = process.env.PORT || 8080;
const actualKey = process.env.SECRET_KEY;

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  //console.error("❌ Missing FIREBASE_SERVICE_ACCOUNT environment variable.");
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  // Replace escaped newlines with actual newline characters in the private key.
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

  //console.log("🔹 Initializing Firebase Admin SDK..."); // Added log
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://black-tigers-c9017-default-rtdb.asia-southeast1.firebasedatabase.app"
  });
  //console.log("✅ Firebase Admin SDK initialized."); // Added log
} catch (error) {
  //console.error("❌ Error parsing Firebase Service Account JSON:", error);
}

const db = getFirestore();
const auth = admin.auth();

app.use(cors());
app.use(express.json());

// ✅ Test route
app.get('/', (req, res) => {
  //console.log('✅ Server is running successfully!'); // Added log
  res.send('✅ Server is running successfully!');
});

// ✅ Start the server
app.listen(port, () => {
  //console.log(`✅ Server is running on port ${port}`);
});

app.get('/check-user-status', async (req, res) => {
  //console.log("🔹 Received request at /check-user-status"); // Added log
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    //console.error("❌ Unauthorized access. No token provided or token format invalid."); // Uncommented log
    return res.status(401).json({ status: "no-auth", message: "No token provided or token format invalid." });
  }

  const token = authHeader.split(' ')[1]; // Extract the actual token

  try {
    // Verify the token
    const decodedToken = await admin.auth().verifyIdToken(token);
    const userId = decodedToken.uid;
    //console.log(`✅ Token verified for user: ${userId}`); // Added log

    // Fetch user document from Firestore
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      //console.error(`❌ User with ID ${userId} not found.`); // Uncommented log
      return res.status(404).json({ status: "not-found", message: "User not found." });
    }

    const userData = userDoc.data();
    // Use userData.creationTime if available; otherwise fallback to token's auth_time
    const creationTime = userData.creationTime || decodedToken.auth_time * 1000;
    const emailVerified = decodedToken.email_verified; // Expect a boolean value
    const currentTime = Date.now();
    const timeDiffInHours = (currentTime - new Date(creationTime).getTime()) / (1000 * 3600);
    const isGuest = userData.isGuest;
    //console.log("Email Verified:", emailVerified, "Is Guest:", isGuest, "Time Diff (Hours):", timeDiffInHours, "User ID:", userId); // Uncommented log
    // Check email verification status
    if (timeDiffInHours > 24) {
      //console.log("Session expired: More than 24 hours has passed"); // Uncommented log

      if (isGuest) {
        //console.log("User is a guest, requiring login."); // Uncommented log
        return res.json({ status: "guest-login-required" });
      }
      else if (!emailVerified) {
        //console.log("User is not a guest but email is not verified."); // Uncommented log
        return res.json({ status: "email-verification-required" });
      }
      else {
        //console.log("User is authenticated, sending user data."); // Uncommented log
        return res.json({ status: "authenticated", data: userData });
      }
    } else {
      //console.log("Session is still valid: Less than 24 hours has passed."); // Uncommented log
      return res.json({ status: "authenticated", data: userData });
    }

  } catch (error) {
    //console.error("❌ Error verifying user:", error); // Uncommented log
    return res.status(500).json({
      status: "error",
      message: "Internal server error.",
      error: error.message
    });
  }
});

app.get('/get-user-data', async (req, res) => {
  //console.log("🔹 Received request at /get-user-data"); // Added log
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    //console.error("❌ Unauthorized access. No token provided or token format invalid."); // Uncommented log
    return res.status(401).json({
      status: 'error',
      message: 'Unauthorized access. No token provided.'
    });
  }

  const token = authHeader.split(' ')[1]; // Extract the token

  try {
    const decodedToken = await admin.auth().verifyIdToken(token); // Verify the token
    const userId = decodedToken.uid;
    //console.log(`✅ Token verified for user: ${userId}`); // Added log

    // Fetch user and ranking data from Firestore
    const userDoc = await db.collection('users').doc(userId).get();
    let rankingDoc = await db.collection('ranking').doc(userId).get();

    if (!userDoc.exists) {
      //console.error(`❌ User data not found for user ID ${userId}.`);
      return res.status(404).json({ status: 'error', message: 'User data not found.' });
    }

    if (!rankingDoc.exists) {
      //console.warn(`⚠️ Ranking data not found for user ID ${userId}. Creating default ranking document.`);
      await db.collection('ranking').doc(userId).set({
        rank: 0,
        markAccuracy: 0,
        username: userDoc.data().username || 'Anonymous', // Use username from userDoc
        timeAccuracy: 0,
      });
      rankingDoc = await db.collection('ranking').doc(userId).get(); // Fetch again after creation
    }

    const userData = userDoc.data();
    const rankingData = rankingDoc.data();
    //console.log("User Data:", userData); // Added log
    //console.log("Ranking Data:", rankingData); // Added log

    // Process user data helper function: countQuestionIDs (Assuming it's defined somewhere in your code)
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
    //console.error('❌ Error fetching user data:', error); // Uncommented log
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve user data.',
      error: error.message
    });
  }
});

function countQuestionIDs(data) {
  let count = 0;
  // Traverse the data recursively
  Object.entries(data).forEach(([key, value]) => {
    if (typeof value === "object" && value !== null) {
      count += countQuestionIDs(value); // Recursively count for nested objects
    } else if (typeof value === "number") {
      count += 1; // Count the question ID if it's a number (e.g., "Maths LCM_HCF 00027: 350")
    }
  });
  return count;
}

app.get('/get-questions', async (req, res) => {
  //console.log("🔹 Received request at /get-questions"); // Uncommented log

  // Fetch user document from Firestore
  const authHeader = req.headers.authorization;
  //console.log("🔹 Authorization Header:", authHeader); // Uncommented log

  const batchSize = parseInt(req.query.batchSize) || 5;
  const retryLimit = parseInt(req.query.retryLimit) || 3;
  //console.log(`🔹 Batch size: ${batchSize}, Retry limit: ${retryLimit}`); // Uncommented log

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    //console.warn("⚠️ Unauthorized access. No token provided."); // Uncommented log
    return res.status(401).json({
      status: 'error',
      message: 'Unauthorized access. No token provided.'
    });
  }

  const token = authHeader.split(' ')[1];


  try {
    //console.log("🔹 Verifying Firebase ID token..."); // Uncommented log
    const decodedToken = await admin.auth().verifyIdToken(token);
    const userId = decodedToken.uid;
    //console.log(`✅ Token verified for user: ${userId}`); // Uncommented log

    //console.log("🔹 Fetching user document..."); // Uncommented log
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      //console.warn(`⚠️ User not found: ${userId}`); // Uncommented log
      return res.status(404).json({
        status: 'error',
        message: 'User not found.'
      });
    }

    const userData = userDoc.data();
    // Use userData.creationTime if available; otherwise fallback to token's auth_time
    const creationTime = userData.creationTime || decodedToken.auth_time * 1000;
    const emailVerified = decodedToken.email_verified; // Expect a boolean value
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

    //console.log("✅ User data fetched successfully:", userData); // Uncommented log

    let categories = ["english"];

    if (req.query.selectedCategories) {
      try {
        //console.log("🔹 Parsing selected categories..."); // Uncommented log

        // Try parsing the query parameter as JSON
        try {
          categories = JSON.parse(req.query.selectedCategories);
        } catch (e) {
          // If parsing fails, check if it's a plain string (e.g., 'PYQ')
          if (e instanceof SyntaxError) {
            categories = req.query.selectedCategories; // It's a plain string, like 'PYQ'
          } else {
            // Unexpected error, return a proper response
            //console.error('Error parsing selectedCategories:', e); // Uncommented log
            return res.status(400).json({ error: 'Invalid selectedCategories format' });
          }
        }

        // If categories is a string (e.g., "PYQ"), handle it
        if (typeof categories === "string" && categories === "PYQ") {
          categories = ["PYQ"]; // You can convert it into an array if needed
        }

        // Ensure categories is a non-empty array
        if (!Array.isArray(categories) || categories.length === 0) {
          throw new Error("Selected categories must be a non-empty array.");
        }

        //console.log("✅ Selected categories:", categories); // Uncommented log
      } catch (err) {
        //console.error("❌ Error parsing selectedCategories:", err); // Uncommented log
        return res.status(400).json({
          status: 'error',
          message: 'Invalid category selection.'
        });
      }
    }


    const category = categories[Math.floor(Math.random() * categories.length)];
    //console.log("🔹 Using category:", category); // Uncommented log

    //console.log("🔹 Fetching category document..."); // Uncommented log
    const categoryDoc = await db.collection('questions').doc(category).get();
    if (!categoryDoc.exists) {
      //console.warn(`⚠️ Category not found: ${category}`); // Uncommented log
      return res.status(404).json({
        status: 'error',
        message: 'Category not found.'
      });
    }

    const categoryData = categoryDoc.data();
    //console.log("✅ Category data fetched successfully:", categoryData); // Uncommented log

    const totalQuestions = categoryData.totalQuestions;
    if (!totalQuestions) {
      //console.warn(`⚠️ No questions available in category: ${category}`); // Uncommented log
      return res.status(404).json({
        status: 'error',
        message: 'No questions available in this category.'
      });
    }
    //console.log(`🔹 Total questions in category '${category}': ${totalQuestions}`); // Uncommented log

    // Function to extract question IDs from a given data structure
    const extractQuestionIDs = (data) => {
      const questionIDsArray = [];

      // Iterate over the subjects (e.g., 'GK')
      for (const subject in data) {
        const subjectData = data[subject];

        // Iterate over the dates (e.g., '16-02-2025')
        for (const date in subjectData) {
          const dateData = subjectData[date];

          // Extract questionIDs (keys of the dateData object)
          const questionIDs = Object.keys(dateData);

          // Add questionIDs to the result array
          questionIDsArray.push(...questionIDs);
        }
      }

      return questionIDsArray;
    };

    // Assuming userData contains both correct and wrong attempted questions
    const correctAttemptedQuestionsIDs = userData.correctAttempted_questionsIDs;
    const wrongAttemptedQuestionsIDs = userData.wrongAttempted_questionsIDs;

    // Extract question IDs for both correct and wrong attempts
    const correctQuestionIDs = extractQuestionIDs(correctAttemptedQuestionsIDs);
    const wrongQuestionIDs = extractQuestionIDs(wrongAttemptedQuestionsIDs);

    const combinedUniqueArray = [...new Set([...correctQuestionIDs, ...wrongQuestionIDs])];

    ///////////////////////////////////////////////////////

    ////getting all questions///
    ///////////////////////////////////////////////////////

    const randomIDs = new Set();
    let retries = 0;
    while (randomIDs.size < batchSize && retries < retryLimit * batchSize) {
      const randomIndex = Math.floor(Math.random() * totalQuestions) + 1;
      const randomQuestionID = `question_${randomIndex}`;
      if (!randomIDs.has(randomQuestionID)) {
        randomIDs.add(randomQuestionID);
      } else {
        retries++;
      }
    }
    if (randomIDs.size < batchSize) {
      //console.warn("⚠️ Could not fetch the desired number of unique questions."); // Uncommented log
    }
    const fetchedQuestions = [];
    for (const randomQuestionID of randomIDs) {
      const questionDoc = await db
        .collection('questions')
        .doc(category)
        .collection('allQuestions')
        .doc(randomQuestionID)
        .get();
      if (!questionDoc.exists) {
        //console.warn(`⚠️ Question document not found: ${randomQuestionID}`); // Uncommented log
        // This 'return' here would exit the loop, but it's inside a for...of loop, so it's returning from the async function.
        // It should probably just continue to the next question or handle this specific question's absence.
        // For now, I'll keep it as is, but be aware of this behavior.
        continue; // Changed return to continue to fetch other questions
      }
      const questionData = questionDoc.data();
      try {
        let decryptedData = CryptoJS.AES.decrypt(questionData.encryptedData, actualKey).toString(CryptoJS.enc.Utf8);
        let parsedData = JSON.parse(decryptedData);
        if (!decryptedData || decryptedData.trim() === "") {
          throw new Error("Decryption resulted in empty or invalid JSON");
        }
        const decryptedQuestionID = parsedData.questionID;
        if (combinedUniqueArray.includes(decryptedQuestionID)) {
          //console.log(`⚠️ Question with ID '${decryptedQuestionID}' is already attempted. Skipping.`); // Uncommented log
        } else {

          fetchedQuestions.push({
            id: randomQuestionID,
            likes: questionData.likes || {},
            dislikes: questionData.dislikes || {},
            correctlyAttempted: questionData.correctlyAttempted || 0,
            wronglyAttempted: questionData.wronglyAttempted || 0,
            data: parsedData,
          });
        }
        //console.log(`✅ Question decrypted successfully: ${randomQuestionID}`); // Uncommented log
      } catch (decryptError) {
        //console.error(`❌ Error decrypting data for ${randomQuestionID}:`, decryptError); // Uncommented log
      }
    }


    if (fetchedQuestions.length < 2) {
      //console.warn("⚠️ Less than 2 new questions could be fetched after retries."); // Uncommented log
      return res.json({
        status: 'error',
        message: 'You have attempted all the available questions.',
      });
    }

    res.json({ status: 'success', questions: fetchedQuestions });
  } catch (error) {
    //console.error("❌ Error in /get-questions:", error); // Uncommented log
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve questions.',
      error: error.message
    });
  }
});

app.post('/api/notify', async (req, res) => {
  //console.log("🔹 Received request at /api/notify"); // Added log
  const { toUid, fromUsername, message, chatId } = req.body;
  if (!toUid || !message) return res.status(400).send('Missing fields');

  try {
    // 1. Fetch the recipient's FCM token from Firestore
    const userSnap = await db.doc(`users/${toUid}`).get();
    const token = userSnap.data()?.fcmToken;
    if (!token) {
      //console.log(`No FCM token for user ${toUid}`); // Uncommented log
      return res.sendStatus(204);
    }

    // 2. Build and send the notification
    const payload = {
      notification: {
        title: `New message from ${fromUsername}`,
        body: message.length > 50 ? message.slice(0, 47) + '…' : message,
        clickAction: 'https://YOUR-WEB-APP.COM/?chat=' + encodeURIComponent(chatId)
      },
      data: {
        chatId,
        sender: fromUsername
      }
    };

    // Assuming 'fcm' is initialized elsewhere, e.g., admin.messaging()
    // If you don't have FCM setup, this part will cause an error.
    // For now, I'll assume 'fcm' is available or needs to be uncommented/initialized.
    // await fcm.send({ token, ...payload }); // This line needs 'fcm' to be defined.
    //console.log("FCM send call commented out. Ensure 'fcm' is initialized if needed."); // Added log
    return res.sendStatus(200);

  } catch (err) {
    //console.error("Error sending notification:", err); // Uncommented log
    return res.sendStatus(500);
  }
});

app.post('/handle-like-dislike', async (req, res) => {
  //console.log("🔹 Received request at /handle-like-dislike"); // Uncommented log
  const authHeader = req.headers.authorization;
  //console.log("🔹 Authorization header:", authHeader); // Uncommented log
  const { id, action, currentSubject } = req.body;
  //console.log("🔹 Request body:", { id, action, currentSubject }); // Uncommented log

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    //console.warn("⚠️ Unauthorized access. Missing or invalid token."); // Uncommented log
    return res.status(401).json({
      status: 'error',
      message: 'Unauthorized access. No token provided.'
    });
  }

  const token = authHeader.split(' ')[1]; // Extract the token

  try {
    //console.log("🔹 Verifying token..."); // Uncommented log
    const decodedToken = await admin.auth().verifyIdToken(token);
    const userID = decodedToken.uid;
    //console.log(`✅ Token verified. User ID: ${userID}`); // Uncommented log

    if (!id || !['like', 'dislike'].includes(action)) {
      //console.warn("⚠️ Invalid request payload:", { id, action }); // Uncommented log
      return res.status(400).json({
        status: 'error',
        message: 'Invalid request payload.'
      });
    }

    //console.log(`🔹 Fetching question document for id: ${id} in subject: ${currentSubject}`); // Uncommented log
    const questionRef = db.doc(`questions/${currentSubject}/allQuestions/${id}`);
    const questionDoc = await questionRef.get();

    if (!questionDoc.exists) {
      //console.warn(`⚠️ Question not found for id: ${id}`); // Uncommented log
      return res.status(404).json({
        status: 'error',
        message: 'Question not found.'
      });
    }

    let questionData = questionDoc.data();
    let { likes = {}, dislikes = {} } = questionData;
    //console.log("🔹 Current likes:", likes); // Uncommented log
    //console.log("🔹 Current dislikes:", dislikes); // Uncommented log

    if (action === 'like') {
      if (likes[userID]) {
        //console.log("🔹 User already liked. Removing like..."); // Uncommented log
        delete likes[userID];
      } else {
        //console.log("🔹 User liking the question. Adding like and removing dislike if present..."); // Uncommented log
        likes[userID] = true;
        delete dislikes[userID];
      }
    } else if (action === 'dislike') {
      if (dislikes[userID]) {
        //console.log("🔹 User already disliked. Removing dislike..."); // Uncommented log
        delete dislikes[userID];
      } else {
        //console.log("🔹 User disliking the question. Adding dislike and removing like if present..."); // Uncommented log
        dislikes[userID] = true;
        delete likes[userID];
      }
    }

    //console.log("🔹 Updating question document with new likes and dislikes..."); // Uncommented log
    await questionRef.update({ likes, dislikes });
    //console.log("✅ Question updated successfully."); // Uncommented log

    res.json({
      status: 'success',
      message: `You ${action}d this question!`,
      likes: Object.keys(likes).length,
      dislikes: Object.keys(dislikes).length,
    });
  } catch (error) {
    //console.error("❌ Error handling like/dislike:", error); // Uncommented log
    res.status(500).json({
      status: 'error',
      message: 'Failed to handle like/dislike.',
      error: error.message
    });
  }
});

app.post('/submit-answer', async (req, res) => {
  //console.log("🔹 Received request at /submit-answer"); // Uncommented log
  const authHeader = req.headers.authorization;
  //console.log("🔹 Authorization header:", authHeader); // Uncommented log
  const { questionID, elapsedTime, answerTrueOrNot, id } = req.body;
  //console.log("🔹 Request body:", { questionID, elapsedTime, answerTrueOrNot, id }); // Uncommented log

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    //console.warn("⚠️ Unauthorized access. Missing or invalid token."); // Uncommented log
    return res.status(401).json({
      status: 'error',
      message: 'Unauthorized access. No token provided.'
    });
  }

  const token = authHeader.split(' ')[1];
  //console.log("🔹 Verifying token..."); // Uncommented log
  const decodedToken = await admin.auth().verifyIdToken(token);
  const userId = decodedToken.uid;
  //console.log(`✅ Token verified. User ID: ${userId}`); // Uncommented log
  const userDocRef = db.collection('users').doc(userId);
  const userSnapshot = await userDocRef.get();
  const userData = userSnapshot.data();

  if (userData.tokens > 0) {
    //console.log("✅ Token deducted successfully."); // Uncommented log
  } else {
    return res.json({
      status: 'error',
      message: `no sufficient tokens. you have ${userData.tokens} token. please refill them.`
    });
  }

  try {
    if (!questionID || elapsedTime === undefined || answerTrueOrNot === undefined) {
      //console.warn("⚠️ Invalid request payload:", { questionID, elapsedTime, answerTrueOrNot, id }); // Uncommented log
      return res.status(400).json({
        status: 'error',
        message: 'Invalid request payload.'
      });
    }

    await userDocRef.update({
      total_time_Taken: admin.firestore.FieldValue.increment(elapsedTime)
    });
    //console.log("✅ Total time updated."); // Uncommented log

    const today = new Date().toLocaleDateString('en-GB').replace(/\//g, '-'); // dd-mm-yyyy
    //console.log("🔹 Today's date:", today); // Uncommented log

    // Extract category and subject from questionID (assumes questionID format: \"<Category> <Subject> ...\")
    const parts = questionID.split(' ');
    if (parts.length < 2) {
      //console.warn("⚠️ Invalid questionID format:", questionID); // Uncommented log
      return res.status(400).json({
        status: 'error',
        message: 'Invalid questionID format.'
      });
    }

    const category = parts[0].toLowerCase(); // e.g., \"English\"
    const subject = parts[1]; // e.g., \"Antonym\"
    //console.log("🔹 Extracted category:", category, "and subject:", subject); // Uncommented log

    // Determine the field to update
    const field = answerTrueOrNot ? 'correctAttempted_questionsIDs' : 'wrongAttempted_questionsIDs';
    //console.log("🔹 Field to update:", field); // Uncommented log

    //console.log("🔹 Updating user's attempted question data..."); // Uncommented log
    await userDocRef.set({
      [field]: {
        [category]: {
          [today]: {
            [questionID]: elapsedTime
          }
        }
      }
    }, { merge: true });
    //console.log("✅ User's attempted question data updated."); // Uncommented log


    // Reference the question document
    const questionRef = db.doc(`questions/${category}/allQuestions/${id}`);
    const questionDoc = await questionRef.get();

    if (!questionDoc.exists) {
      //console.warn(`⚠️ Question not found for id: ${id}`); // Uncommented log
      return res.status(404).json({
        status: 'error',
        message: 'Question not found.'
      });
    }

    let questionData = questionDoc.data();

    // Initialize counters if they don't exist
    questionData.correctlyAttempted = questionData.correctlyAttempted || 0;
    questionData.wronglyAttempted = questionData.wronglyAttempted || 0;

    // Update the counters based on whether the answer is correct
    if (answerTrueOrNot) {
      questionData.correctlyAttempted += 1;
      await userDocRef.update({
        tokens: admin.firestore.FieldValue.increment(0.5)
      });
    } else {
      questionData.wronglyAttempted += 1;
      await userDocRef.update({
        tokens: admin.firestore.FieldValue.increment(-1)
      });
    }

    // Update the document with the new counters
    await questionRef.update({
      correctlyAttempted: questionData.correctlyAttempted,
      wronglyAttempted: questionData.wronglyAttempted
    });


    res.json({ status: 'success', message: 'Answer submitted successfully.' });
  } catch (error) {
    //console.error("❌ Error submitting answer:", error); // Uncommented log
    res.status(500).json({
      status: 'error',
      message: 'Failed to submit answer.',
      error: error.message
    });
  }
});

app.post('/report-question', async (req, res) => {
  //console.log("🔹 Received request at /report-question"); // Uncommented log
  const authHeader = req.headers.authorization;
  //console.log("🔹 Authorization header:", authHeader); // Uncommented log
  const { questionID } = req.body;
  //console.log("🔹 Request body:", { questionID }); // Uncommented log

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    //console.warn("⚠️ /report-question: Unauthorized access. No token provided."); // Uncommented log
    return res.status(401).json({ status: 'error', message: 'Unauthorized access. No token provided.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    //console.log("🔹 Verifying token..."); // Uncommented log
    const decodedToken = await admin.auth().verifyIdToken(token);
    const userId = decodedToken.uid;
    //console.log("✅ Token verified. User ID:", userId); // Uncommented log

    if (!questionID) {
      //console.warn("⚠️ /report-question: Invalid request. Question ID is missing."); // Uncommented log
      return res.status(400).json({ status: 'error', message: 'Invalid request. Question ID is missing.' });
    }

    //console.log("🔹 Adding report to Firestore..."); // Uncommented log
    const reportedQuestionsRef = db.collection('reportedQuestions');
    await reportedQuestionsRef.add({
      questionID: questionID,
      reportedAt: admin.firestore.FieldValue.serverTimestamp(),
      userId: userId,
    });

    //console.log("✅ Question reported successfully."); // Uncommented log
    res.json({ status: 'success', message: 'Question reported successfully.' });
  } catch (error) {
    //console.error("❌ /report-question: Error reporting question:", error); // Uncommented log
    return res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve user data.',
      error: error.message
    });
  }
});

app.post('/update-question-time', async (req, res) => {
  //console.log("🔹 Received request at /update-question-time"); // Uncommented log
  const authHeader = req.headers.authorization;
  //console.log("🔹 Authorization header:", authHeader); // Uncommented log
  const { questionID, elapsedTime, field, currentDate } = req.body;
  //console.log("🔹 Request body:", { questionID, elapsedTime, field, currentDate }); // Uncommented log

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    //console.warn("⚠️ /update-question-time: Unauthorized access. No token provided."); // Uncommented log
    return res.status(401).json({ status: 'error', message: 'Unauthorized access. No token provided.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    //console.log("🔹 Verifying token..."); // Uncommented log
    const decodedToken = await admin.auth().verifyIdToken(token);
    const userId = decodedToken.uid;
    //console.log("✅ Token verified. User ID:", userId); // Uncommented log

    // Validate input
    if (!questionID || !elapsedTime || !field || !currentDate) {
      //console.warn("⚠️ /update-question-time: Invalid request. Missing data:", { questionID, elapsedTime, field, currentDate }); // Uncommented log
      return res.status(400).json({ status: 'error', message: 'Invalid request. Missing data.' });
    }

    //console.log("🔹 Retrieving user document..."); // Uncommented log
    const userDocRef = db.collection('users').doc(userId);
    const userDoc = await userDocRef.get();

    if (!userDoc.exists) {
      //console.warn(`⚠️ /update-question-time: User document not found for user ${userId}`); // Uncommented log
      return res.status(404).json({ status: 'error', message: 'User document not found.' });
    }

    const userData = userDoc.data();
    let fieldData = userData[field] || {};
    //console.log("🔹 Current field data:", fieldData); // Uncommented log

    // Parse questionID to extract subject and chapter (adjust parsing as needed)
    let [subject, chapter] = questionID.split(' ').slice(0, 2);
    if (subject && chapter) {
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
      //console.log("🔹 Updated field data:", fieldData); // Uncommented log

      //console.log("🔹 Updating user document in Firestore..."); // Uncommented log
      await userDocRef.update({ [field]: fieldData });
      //console.log("✅ Data updated successfully."); // Uncommented log
      res.json({ status: 'success', message: 'Data updated successfully.' });
    } else {
      //console.warn("⚠️ /update-question-time: Invalid question ID format:", questionID); // Uncommented log
      res.status(400).json({ status: 'error', message: 'Invalid question ID format.' });
    }
  } catch (error) {
    //console.error("❌ /update-question-time: Error processing request:", error); // Uncommented log
    return res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve user data.',
      error: error.message
    });
  }
});

async function updateAllRanks() {
  //console.log("🔹 Updating all ranks..."); // Uncommented log
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
    //console.log("🔹 Users fetched from ranking:", users); // Uncommented log

    // Sort users by markAccuracy and timeAccuracy
    users.sort((a, b) => {
      if (b.markAccuracy !== a.markAccuracy) {
        return b.markAccuracy - a.markAccuracy;
      } else if (b.timeAccuracy !== a.timeAccuracy) {
        return b.timeAccuracy - a.timeAccuracy;
      } else {
        return a.name.localeCompare(b.name);
      }
    });
    //console.log("🔹 Sorted users:", users); // Uncommented log

    // Update ranks in Firestore
    const batch = db.batch();
    users.forEach((user, index) => {
      const userDocRef = db.collection("ranking").doc(user.userId);
      //console.log(`🔹 Setting rank for user ${user.userId} (${user.name}) to ${index + 1}`); // Uncommented log
      batch.update(userDocRef, { rank: index + 1 });
    });

    await batch.commit();
    //console.log("✅ Ranks updated successfully."); // Uncommented log
  } catch (error) {
    //console.error("❌ Error updating ranks:", error); // Uncommented log
    return res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve user data.',
      error: error.message
    });
  }
}

app.post("/trigger-rank-update", async (req, res) => {
  //console.log("🔹 Received request at /trigger-rank-update"); // Uncommented log
  try {
    await updateAllRanks();
    //console.log("✅ Ranks updated successfully via /trigger-rank-update"); // Uncommented log
    res.json({ status: "success", message: "Ranks updated successfully." });
  } catch (error) {
    //console.error("❌ /trigger-rank-update error:", error); // Uncommented log
    return res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve user data.',
      error: error.message
    });
  }
});


app.post("/auth", async (req, res) => {
  //console.log("🔹 Received /auth request with:", req.body); // Uncommented log
  const { email, password, name } = req.body;

  if (!email || !password || !name) {
    //console.warn("⚠️ /auth: Validation Error: Missing fields"); // Uncommented log
    return res.status(400).json({ message: "Fields cannot be empty" });
  }

  try {
    //console.log(`🔹 Attempting login for user: ${email}`); // Uncommented log
    const user = await auth.getUserByEmail(email);
    //console.log(`✅ Login successful for userId: ${user.uid}`); // Uncommented log
    return res.json({ message: "Login successful", userId: user.uid });
  } catch (error) {
    //console.error(`❌ /auth: Login failed for ${email}:`, error.message); // Uncommented log
    if (error.code === "auth/user-not-found") {
      //console.log("🔹 User not found. Creating new account..."); // Uncommented log

      try {
        const userRecord = await auth.createUser({ email, password, displayName: name });
        const userId = userRecord.uid;
        const creationTime = Date.now();
        //console.log(`✅ User created successfully: ${userId}`); // Uncommented log

        // Determine if user is a guest
        let isGuest = email.toLowerCase().includes('guest');
        //console.log(`🔹 Setting isGuest as: ${isGuest} for user ${email}`); // Uncommented log

        // Store user data in Firestore
        try {
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
            tokens: 100,
          });
          //console.log(`✅ Firestore write successful for userId: ${userId}`); // Uncommented log
        } catch (dbError) {
          //console.error(`❌ Firestore write failed for userId: ${userId}`, dbError); // Uncommented log
          return res.status(500).json({ message: "Error saving user data", error: dbError.message });
        }

        await db.collection("ranking").doc(userId).set({
          rank: 0,
          markAccuracy: 0,
          username: name,
          timeAccuracy: 0,
        });
        //console.log(`✅ Ranking data stored in Firestore for userId: ${userId}`); // Uncommented log

        return res.json({ message: "Account created successfully", userId });
      } catch (err) {
        //console.error("❌ /auth: Error creating user:", err.message, err); // Uncommented log
        return res.status(500).json({ message: "Error creating user", error: err.message });
      }
    }
    return res.status(500).json({ message: "Login failed", error: error.message });
  }
});

app.post("/guest-auth", async (req, res) => {
  //console.log("🔹 Received /guest-auth request with:", req.body); // Uncommented log
  const { email, password, name, uid } = req.body;

  if (!email || !password || !name || !uid) {
    //console.warn("⚠️ /guest-auth: Validation Error: Missing fields"); // Uncommented log
    return res.status(400).json({ message: "Fields cannot be empty" });
  }

  try {
    //console.log(`🔹 Updating user with UID: ${uid}`); // Uncommented log

    // Update Firebase Authentication details
    await admin.auth().updateUser(uid, {
      email: email,
      password: password,
      displayName: name
    });
    //console.log("✅ User authentication details updated successfully"); // Uncommented log

    // Update Firestore: users collection
    await db.collection("users").doc(uid).update({
      username: name,
      isGuest: false,
      tokens: 100
    }, { merge: true });
    //console.log(`✅ Firestore 'users' updated for UID: ${uid}`); // Uncommented log

    // Update Firestore: ranking collection (if applicable)
    await db.collection("ranking").doc(uid).update({
      username: name
    }, { merge: true });
    //console.log(`✅ Firestore 'ranking' updated for UID: ${uid}`); // Uncommented log

    return res.json({ message: "User updated successfully", userId: uid });
  } catch (err) {
    //console.error("❌ /guest-auth: Error updating user:", err.message); // Uncommented log
    return res.status(500).json({ message: "Error updating user", error: err.message });
  }
});

app.post("/reset-password", async (req, res) => {
  //console.log("🔹 Received /reset-password request for:", req.body.email); // Uncommented log
  const { email } = req.body;
  if (!email) {
    //console.warn("⚠️ /reset-password: Validation Error: Email is required"); // Uncommented log
    return res.status(400).json({ message: "Email is required" });
  }

  try {
    //console.log(`🔹 Attempting to send password reset email to: ${email}`); // Uncommented log
    await auth.generatePasswordResetLink(email);
    //console.log("✅ Password reset email sent successfully"); // Uncommented log
    return res.json({ message: "Password reset link sent to your email." });
  } catch (error) {
    //console.error(`❌ /reset-password: Password reset failed for ${email}:`, error.message, error); // Uncommented log
    return res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve user data.',
      error: error.message
    });
  }
});

app.post("/send-verification", async (req, res) => {
  //console.log("🔹 Received /send-verification request for userId:", req.body.uid); // Uncommented log
  const { uid } = req.body;

  if (!uid) {
    //console.warn("⚠️ /send-verification: Validation Error: User ID is required"); // Uncommented log
    return res.status(400).json({ message: "User ID is required" });
  }

  try {
    const user = await auth.getUser(uid);
    //console.log(`🔹 Generating email verification link for user: ${user.email}`); // Uncommented log
    const emailVerificationLink = await auth.generateEmailVerificationLink(user.email);
    //console.log("✅ Email verification link generated successfully:", emailVerificationLink); // Uncommented log
    return res.json({ message: "Verification email sent", link: emailVerificationLink });
  } catch (error) {
    //console.error(`❌ /send-verification: Error sending verification email for userId ${uid}:`, error.message, error); // Uncommented log
    return res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve user data.',
      error: error.message
    });
  }
});

app.get("/check-verification", async (req, res) => {
  //console.log("🔹 Received /check-verification request with query:", req.query); // Uncommented log
  const { uid } = req.query;

  if (!uid) {
    //console.warn("⚠️ /check-verification: Validation Error: User ID is required"); // Uncommented log
    return res.status(400).json({ message: "User ID is required" });
  }

  try {
    const user = await auth.getUser(uid); // Fetch user data from Firebase Auth
    //console.log(`✅ /check-verification: Fetched user data for uid: ${uid}`); // Uncommented log
    return res.json({ verified: user.emailVerified }); // Return verification status
  } catch (error) {
    //console.error(`❌ /check-verification: Error checking verification status for userId ${uid}:`, error.message); // Uncommented log
    return res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve user data.',
      error: error.message
    });
  }
});

app.post('/update-user-rank', async (req, res) => {
  //console.log("🔹 Received /update-user-rank request with:", req.body); // Uncommented log
  const { userId, markAccuracy, timeAccuracy, username } = req.body;

  if (!userId || markAccuracy === undefined || timeAccuracy === undefined) {
    //console.warn("⚠️ /update-user-rank: Invalid data received:", { userId, markAccuracy, timeAccuracy, username }); // Uncommented log
    return res.status(400).json({ status: 'error', message: 'Invalid data received.' });
  }

  try {
    const userDocRef = db.collection('ranking').doc(userId);
    const userDoc = await userDocRef.get();

    if (!userDoc.exists) {
      //console.warn(`⚠️ /update-user-rank: User not found in ranking collection for userId: ${userId}`); // Uncommented log
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
    //console.log("✅ /update-user-rank: Rank updated successfully for userId:", userId); // Uncommented log
    res.json({ status: 'success', message: 'Rank updated successfully.' });
  } catch (error) {
    //console.error("❌ /update-user-rank: Error updating rank data:", error.message, error); // Uncommented log
    return res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve user data.',
      error: error.message
    });
  }
});

app.get('/', (req, res) => {
  //console.log("🔹 Received request at /"); // Uncommented log
  res.json({ message: "✅ Server is running!" });
});

app.get('/api/test', (req, res) => {
  //console.log("🔹 Received request at /api/test"); // Uncommented log
  res.json({ message: "API is working!" });
});

app.get('/favicon.ico', (req, res) => {
  //console.log("🔹 Received request for /favicon.ico"); // Uncommented log
  res.status(204).end();
});

app.get('/rankings', async (req, res) => {
  //console.log("🔹 Received request at /rankings"); // Uncommented log

  try {
    // Step 1: Debug Firestore Connection
    const collectionRef = db.collection("ranking");
    if (!collectionRef) {
      //console.error("❌ Firestore collection 'ranking' not found!"); // Uncommented log
      return res.status(500).json({ message: "Firestore collection not found." });
    }

    // Step 2: Fetch all documents without filters (Debugging Step)
    const allDocsSnapshot = await collectionRef.get();
    //console.log(`📂 Total documents found: ${allDocsSnapshot.size}`); // Uncommented log

    if (allDocsSnapshot.empty) {
      //console.warn("⚠️ No data found in 'ranking' collection!"); // Uncommented log
      return res.json({ rankings: [] });
    }

    // Step 3: Fetch the ordered rankings
    //console.log("🔍 Fetching top 10 rankings..."); // Uncommented log
    const rankingSnapshot = await collectionRef.orderBy("rank").limit(10).get();

    // Step 4: Check if the query returned documents
    if (rankingSnapshot.empty) {
      //console.warn("⚠️ Query returned no rankings!"); // Uncommented log
      return res.json({ rankings: [] });
    }

    // Step 5: Process the documents
    const rankings = [];
    rankingSnapshot.forEach(doc => {
      const data = doc.data();
      //console.log(`📜 Document ID: ${doc.id}, Data:`, data); // Uncommented log // Debug individual document

      if (data.rank !== undefined && data.rank !== 0) {
        rankings.push({
          rank: data.rank,
          username: data.username || "Anonymous",
          markAccuracy: data.markAccuracy ?? "N/A", // Avoid undefined values
          timeAccuracy: data.timeAccuracy ?? "N/A"
        });
      }
    });

    //console.log("✅ Rankings fetched successfully:", rankings); // Uncommented log
    res.json({ rankings });

  } catch (error) {
    //console.error("❌ /rankings: Error fetching rankings:", error); // Uncommented log
    return res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve rankings.',
      error: error.message
    });
  }
});

app.post("/updateTokens", async (req, res) => {
  const { userId, gameEvents } = req.body;
  //console.log("Received updateTokens request:", req.body); // Uncommented log

  // Validate input: must include userId and exactly maxFlips (6) game events.
  if (
    !userId ||
    !Array.isArray(gameEvents) ||
    gameEvents.length !== 6 ||
    !gameEvents.every((event) => event === "token" || event === "ad")
  ) {
    //console.error("Invalid game data received:", req.body); // Uncommented log
    return res
      .status(400)
      .send({ success: false, error: "Invalid game data" });
  }

  // Recalculate tokens securely on the server.
  const tokenEventsCount = gameEvents.filter((event) => event === "token").length;
  const randomBonus = Math.floor(Math.random() * 5) + 1;
  const tokensAwarded = tokenEventsCount * randomBonus;
  //console.log("Token events count:", tokenEventsCount, "Random bonus:", randomBonus, "Total tokens awarded:", tokensAwarded); // Uncommented log

  try {
    const userDocRef = db.collection("users").doc(userId);
    //console.log("Updating tokens for user:", userId); // Uncommented log
    await userDocRef.update({
      tokens: admin.firestore.FieldValue.increment(tokensAwarded),
    });
    //console.log("Successfully updated tokens for user:", userId); // Uncommented log
    res.send({ success: true, tokensAwarded });
  } catch (error) {
    //console.error("Error updating tokens for user:", userId, error); // Uncommented log

    return res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve user data.',
      error: error.message
    });
  }
});


setInterval(() => {
  updateAllRanks();
}, 24 * 60 * 60 * 1000); // Runs every 24 hours

// Removed the extra closing brace here, it was causing a syntax error.
// } 










// Helper to convert Firestore Timestamp to Unix timestamp (milliseconds)
const timestampToMs = (timestamp) => {
  if (timestamp instanceof admin.firestore.Timestamp) {
    return timestamp.toMillis();
  }
  return timestamp; // Return as is if not a Timestamp object
};


// Route to fetch the encrypted secret key
app.get('/config/encryption', async (req, res) => {
  try {

    res.json({ secretKey: actualKey });
  } catch (error) {
    console.error("Error fetching secret key:", error);
    res.status(500).json({ error: error.message });
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

    res.json(mocksData);
  } catch (error) {
    console.error("Error fetching mocks:", error);
    res.status(500).json({ error: error.message });
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
      res.json({ encryptedData: encryptedQuestions });
    } else {
      res.status(404).json({ error: "Questions not found for this mock" });
    }
  } catch (error) {
    console.error("Error fetching mock questions:", error);
    res.status(500).json({ error: error.message });
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
      res.json(data);
    } else {
      res.status(404).json({ error: "User responses not found" });
    }
  } catch (error) {
    console.error("Error fetching user responses:", error);
    res.status(500).json({ error: error.message });
  }
});

// Route to save user progress
app.post('/mocks/:mock_id/responses/:user_id/progress', async (req, res) => {
  try {
    const { mock_id, user_id } = req.params;
    const data = req.body;
    if (!data) {
      return res.status(400).json({ error: "Request body must be JSON" });
    }

    const docRef = db.collection("mocks").doc(mock_id).collection("Responses").doc(user_id);

    // Use server timestamp for accuracy
    data.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    await docRef.set(data, { merge: true });
    res.json({ message: "Progress saved successfully" });
  } catch (error) {
    console.error("Error saving progress:", error);
    res.status(500).json({ error: error.message });
  }
});

// Route to submit test
app.post('/mocks/:mock_id/responses/:user_id/submit', async (req, res) => {
  try {
    const { mock_id, user_id } = req.params;
    const data = req.body;
    if (!data) {
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

    // Save incorrect questions
    const incorrectQuestionsData = data.incorrectQuestionsData || {};
    if (Object.keys(incorrectQuestionsData).length > 0) {
      await userIncorrectDocRef.set(incorrectQuestionsData, { merge: true });
    } else {
      // If no incorrect questions, ensure the document is deleted or empty
      await userIncorrectDocRef.delete();
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
      }
    }

    res.json({ message: "Test submitted successfully" });
  } catch (error) {
    console.error("Error submitting test:", error);
    res.status(500).json({ error: error.message });
  }
});

// Route to delete user responses (for reattempt)
app.delete('/mocks/:mock_id/responses/:user_id', async (req, res) => {
  try {
    const { mock_id, user_id } = req.params;
    const userResponseDocRef = db.collection("mocks").doc(mock_id).collection("Responses").doc(user_id);
    const userIncorrectDocRef = db.collection("users").doc(user_id).collection("incorrect_responses").doc(mock_id);

    await userResponseDocRef.delete();
    await userIncorrectDocRef.delete();

    res.json({ message: "Previous responses deleted successfully" });
  } catch (error) {
    console.error("Error deleting responses:", error);
    res.status(500).json({ error: error.message });
  }
});

