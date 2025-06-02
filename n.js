require('dotenv').config({ path: __dirname + '/.env' });
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require("firebase-admin/auth");
const CryptoJS = require("crypto-js");

const port = process.env.PORT || 8080;

// ✅ Fix JSON Parsing Issue
let serviceAccount;
try {
  serviceAccount = {
    "type": process.env.type,
    "project_id": process.env.project_id,
    "private_key_id": process.env.private_key_id,
    "private_key": process.env.private_key,
    "client_email": process.env.client_email,
    "client_id": process.env.client_id,
    "auth_uri": process.env.auth_uri,
    "token_uri": process.env.token_uri,
    token_uri:"https://oauth2.googleapis.com/token",
auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
client_x509_cert_url: "https://www.googleapis.com/robot/v1/metadata/x509/translation-api-serviceaccount%40black-tigers-c9017.iam.gserviceaccount.com",

  }


  console.log("✅ FIREBASE_SERVICE_ACCOUNT Loaded Successfully.");
} catch (error) {
  console.error("❌ Error parsing FIREBASE_SERVICE_ACCOUNT:", error.message);
  process.exit(1);
}

// ✅ Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://black-tigers-c9017-default-rtdb.asia-southeast1.firebasedatabase.app"
});

// ✅ Initialize Express server
const app = express();
const db = getFirestore();
const auth = getAuth();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(cors({
  origin: 'http://127.0.0.1:5500',
  methods: 'GET,POST,PUT,DELETE',
  allowedHeaders: 'Content-Type,Authorization'
}));

// ✅ Test route
app.get('/', (req, res) => {
  res.send('✅ Server is running successfully!');
});

// ✅ Start the server
app.listen(port, () => {
  console.log(`✅ Server is running on port ${port}`);
});