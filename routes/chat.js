import express from "express";
import fsSync from 'fs';
import path from 'path';
import { showLogs } from '../lib/logs.js';
import CryptoJS from 'crypto-js';
import { safeReadJSON, safeWriteJSON } from '../lib/fileStore.js';
import { db, auth, rtDb, admin } from '../lib/firebase.js';
import {getQuestionsFromDatabase } from '../res/local_file_functions.js'
const router = express.Router();

export default router;