# Gemini 404 Error Troubleshooting Guide

## Problem
You're seeing "Diagnostic failed: Gemini error 404" when trying to use the college recruiting filter.

## Common Causes and Solutions

### 1. Missing API Key
**Error:** "Gemini API key not set"
**Solution:** 
- Go to Settings > API
- Enter your Gemini API key
- Save settings

### 2. Invalid API Key
**Error:** "Gemini API key not found or invalid"
**Solution:**
- Verify your API key is correct
- Check that the key starts with `AIza` (Google API keys typically start this way)
- Regenerate a new API key from Google AI Studio if needed

### 3. Wrong Model Name
**Error:** "Gemini model not found"
**Solution:**
- Check Settings > API > AI Model
- Use a valid Gemini model name like:
  - `gemini-1.5-flash` (recommended)
  - `gemini-1.5-pro`
  - `gemini-pro`

### 4. API Key Permissions
**Error:** "Gemini API endpoint not found"
**Solution:**
- Ensure your API key has access to the Gemini API
- Check that the Generative AI API is enabled in your Google Cloud project
- Verify billing is set up if required

## How to Get a Gemini API Key

1. Go to [Google AI Studio](https://aistudio.google.com/)
2. Sign in with your Google account
3. Click "Get API Key" or "Create API Key"
4. Copy the generated key
5. Paste it into Settings > API > AI API Key

## Testing Your Setup

1. Go to Settings > API
2. Verify your API key is set
3. Check that AI Provider is set to "Gemini"
4. Use the "Test Recruiting Filter" button in any email viewer
5. Check the Diagnostics page for detailed error information

## Alternative Providers

If Gemini continues to have issues, you can switch to other AI providers:

1. **OpenAI:** Set AI Provider to "OpenAI" and use a GPT API key
2. **Anthropic:** Set AI Provider to "Anthropic" and use a Claude API key

## Getting Help

If you continue to have issues:
1. Check the Diagnostics page for detailed error logs
2. Try the "Test Recruiting Filter" on a specific email to see detailed error information
3. Verify your internet connection and firewall settings
4. Check if your organization blocks Google AI services

## Error Message Reference

- `Gemini error 404` → API key or model issue
- `Gemini invalid API key` → Wrong or expired API key
- `Gemini rate limit exceeded` → Too many requests, wait and try again
- `Gemini bad request` → Prompt content issue (rare)
