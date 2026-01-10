// lib/userLogin.js
import path from 'path';
import { readJSON, writeJSON } from './fileStore.js';
import { showLogs } from './logs.js';

const USER_LOGIN_FILE = path.resolve(process.cwd(), 'userLoginData.json');
showLogs('👤 userLogin.js loaded, USER_LOGIN_FILE:', USER_LOGIN_FILE);

export function updateUserLoginData(deviceId, ip, uid, email, password, isGuest = false) {
  showLogs('👤 updateUserLoginData called:', { 
    deviceId, 
    ip, 
    uid, 
    email: email ? `${email.substring(0, 3)}...` : 'null',
    isGuest,
    passwordLength: password ? password.length : 0
  });

  showLogs('📖 reading user login data from file...');
  const userLoginData = readJSON(USER_LOGIN_FILE, {});
  showLogs('📊 current userLoginData keys:', Object.keys(userLoginData));

  if (!deviceId) {
    // fallback: create a device key from uid
    deviceId = `device_${uid || 'unknown'}`;
    showLogs('🔧 generated deviceId:', deviceId);
  }

  if (!userLoginData[deviceId]) {
    showLogs('👤 creating new user login record for device:', deviceId);
    userLoginData[deviceId] = {
      uid,
      email,
      password: isGuest ? password : undefined,
      ips: Array.isArray(ip) ? ip.slice() : (ip ? [ip] : []),
      isGuest,
      createdAt: Date.now()
    };
    showLogs('✅ new user record created:', userLoginData[deviceId]);
  } else {
    showLogs('👤 updating existing user login data for device:', deviceId);
    // ensure structure
    if (!Array.isArray(userLoginData[deviceId].ips)) {
      showLogs('🔧 initializing empty ips array');
      userLoginData[deviceId].ips = [];
    }

    // Update fields
    userLoginData[deviceId].uid = uid;
    userLoginData[deviceId].email = email;
    if (isGuest && password) {
      userLoginData[deviceId].password = password;
      showLogs('🔑 password updated for guest user');
    }
    userLoginData[deviceId].isGuest = isGuest;

    // ensure ip(s) added
    if (ip) {
      if (Array.isArray(ip)) {
        showLogs('🔧 processing IP array:', ip);
        for (const p of ip) {
          if (!userLoginData[deviceId].ips.includes(p)) {
            userLoginData[deviceId].ips.push(p);
            showLogs('✅ added IP to array:', p);
          }
        }
      } else {
        if (!userLoginData[deviceId].ips.includes(ip)) {
          userLoginData[deviceId].ips.push(ip);
          showLogs('✅ added IP to array:', ip);
        } else {
          showLogs('ℹ️ IP already exists in array:', ip);
        }
      }
    }
    
    showLogs('✅ updated user record:', userLoginData[deviceId]);
  }

  showLogs('📝 writing updated user login data to file...');
  writeJSON(USER_LOGIN_FILE, userLoginData);
  showLogs('✅ user login data updated successfully');
  return userLoginData[deviceId];
}

export function getUserByDevice(deviceId, ip) {
  showLogs('🔍 getUserByDevice called:', { deviceId, ip });

  showLogs('📖 reading user login data from file...');
  const userLoginData = readJSON(USER_LOGIN_FILE, {});
  showLogs('📊 userLoginData keys:', Object.keys(userLoginData));

  // exact match (deviceId + ip)
  if (deviceId && userLoginData[deviceId] && Array.isArray(userLoginData[deviceId].ips)) {
    showLogs('🔍 checking exact device match...');
    if (ip && userLoginData[deviceId].ips.includes(ip)) {
      showLogs('✅ exact device + IP match found');
      return userLoginData[deviceId];
    }
    // if ip not provided, return device match
    if (!ip) {
      showLogs('✅ exact device match found (no IP check)');
      return userLoginData[deviceId];
    }
    showLogs('❌ device found but IP does not match');
  } else {
    showLogs('❌ no device match found');
  }

  // fallback: find by IP in any device record
  if (ip) {
    showLogs('🔍 falling back to IP-only search...');
    for (const id of Object.keys(userLoginData)) {
      const rec = userLoginData[id];
      showLogs(`🔍 checking device ${id}...`);
      if (rec && Array.isArray(rec.ips) && rec.ips.includes(ip)) {
        showLogs(`✅ IP match found in device: ${id}`);
        return rec;
      }
    }
    showLogs('❌ no IP match found in any device');
  } else {
    showLogs('ℹ️ no IP provided for fallback search');
  }

  showLogs('❌ no user found by device or IP');
  return null;
}