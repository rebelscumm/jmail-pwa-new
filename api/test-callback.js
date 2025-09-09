#!/usr/bin/env node

// Simple test script to verify the callback endpoint locally
const { execSync } = require('child_process');
const path = require('path');

console.log('Testing Google OAuth callback endpoint...\n');

// Check if local.settings.json exists
const localSettingsPath = path.join(__dirname, 'local.settings.json');
const fs = require('fs');

if (!fs.existsSync(localSettingsPath)) {
  console.log('❌ local.settings.json not found. Please copy from local.settings.example.json and configure your environment variables.');
  process.exit(1);
}

// Load environment variables
const localSettings = JSON.parse(fs.readFileSync(localSettingsPath, 'utf8'));
const env = localSettings.Values || {};

console.log('Environment variables check:');
console.log(`✅ APP_BASE_URL: ${env.APP_BASE_URL || 'MISSING'}`);
console.log(`✅ GOOGLE_CLIENT_ID: ${env.GOOGLE_CLIENT_ID ? 'SET' : 'MISSING'}`);
console.log(`✅ GOOGLE_CLIENT_SECRET: ${env.GOOGLE_CLIENT_SECRET ? 'SET' : 'MISSING'}`);
console.log(`✅ COOKIE_SECRET: ${env.COOKIE_SECRET ? 'SET' : 'MISSING'}`);
console.log(`✅ COOKIE_SIGNING_SECRET: ${env.COOKIE_SIGNING_SECRET ? 'SET' : 'MISSING'}`);
console.log(`✅ COOKIE_SECURE: ${env.COOKIE_SECURE || 'true (default)'}`);

// Test the callback endpoint with mock data
console.log('\nTesting callback endpoint with mock data...');

const mockRequest = {
  method: 'GET',
  query: {
    code: 'test_code_123',
    state: 'test_state_456'
  },
  headers: {
    cookie: 'g_state=test_state_456:/; g_pkce=test_pkce_verifier_789'
  }
};

const mockContext = {
  res: {
    status: 200,
    headers: {},
    body: ''
  }
};

// Set environment variables for the test
Object.keys(env).forEach(key => {
  process.env[key] = env[key];
});

try {
  // Import and test the callback function
  const callbackFunction = require('./google-callback/index.js');
  
  console.log('Calling callback function...');
  await callbackFunction(mockContext, mockRequest);
  
  console.log('Response:', {
    status: mockContext.res.status,
    headers: mockContext.res.headers,
    body: mockContext.res.body
  });
  
} catch (error) {
  console.error('❌ Error testing callback:', error.message);
  console.error('Stack:', error.stack);
}

console.log('\nTo test with real OAuth flow:');
console.log('1. Start the Azure Functions locally: func start');
console.log('2. Visit: http://localhost:7071/api/google/login');
console.log('3. Complete the OAuth flow and check the callback logs');
