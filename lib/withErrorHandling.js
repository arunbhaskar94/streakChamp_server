// lib/withErrorHandling.js
import { showLogs } from './logs.js';

export function withErrorHandling(fn, context = '') {
  showLogs('🛡️ withErrorHandling wrapper created for:', context);
  
  return async function (...args) {
    showLogs(`🔧 withErrorHandling executing: ${context}`);
    showLogs(`📋 function arguments count: ${args.length}`);
    
    try {
      showLogs(`🚀 calling original function: ${context}`);
      const result = await fn(...args);
      showLogs(`✅ function ${context} completed successfully`);
      return result;
    } catch (err) {
      showLogs(`❌ Error in ${context}:`, err && err.stack ? err.stack : err);
      
      // if first args[0] looks like (req,res,next) we can send 500
      const maybeReq = args[0];
      const maybeRes = args[1];
      
      showLogs(`🔍 checking if response object is available...`);
      if (maybeRes && typeof maybeRes.status === 'function') {
        showLogs(`📤 sending 500 error response for ${context}`);
        try {
          return maybeRes.status(500).json({ status: 'error', message: 'Internal server error' });
        } catch (e) {
          showLogs(`❌ failed to send error response:`, e && e.message ? e.message : String(e));
          // swallow
        }
      } else {
        showLogs(`ℹ️ no response object available for error handling`);
      }
      
      showLogs(`🚨 re-throwing error from ${context}`);
      throw err;
    }
  };
}

export function showLogs(...args) {
   console.log(...args);
}