# Feature 1.2: Quick Start Testing Guide

## Prerequisites
- Ollama running: `ollama serve`
- At least one model pulled (ideally qwen2.5-coder:7b)
- VS Code with extension installed

## Quick Visual Check (2 minutes)

### Step 1: Open Extension
1. Open VS Code
2. Click robot icon 🤖 in Activity Bar
3. Look at header

**Expected:**
```
[Ollama Agent] [⚖️ Balanced ▼] [qwen2.5-coder:7b ▼] [🕐] [+]
```

### Step 2: Test Preset Dropdown
1. Click "⚖️ Balanced" dropdown
2. Should see 4 options:
   - Custom
   - ⚡ Fast
   - ⚖️ Balanced (selected)
   - 💎 Quality

### Step 3: Switch to Fast
1. Select "⚡ Fast"
2. Model dropdown should change to "qwen2.5-coder:1.5b"
3. Preset dropdown should show "⚡ Fast"

### Step 4: Switch to Quality
1. Select "💎 Quality"
2. Model dropdown should change to "llama3.1:8b"
3. Preset dropdown should show "💎 Quality"

### Step 5: Manual Model Change
1. Click model dropdown
2. Select any different model (e.g., "phi3:mini")
3. Preset dropdown should change to "Custom"

### Step 6: Test Persistence
1. Select "⚡ Fast"
2. Close VS Code completely
3. Reopen VS Code and workspace
4. Open Ollama Agent sidebar
5. Should show "⚡ Fast" (persisted)

## Quick Functional Test (3 minutes)

### Test 1: Send Message with Fast Preset
1. Select "⚡ Fast"
2. Type: "Say hello"
3. Press Enter
4. Should get response (using qwen2.5-coder:1.5b)

### Test 2: Send Message with Quality Preset
1. Select "💎 Quality"
2. Type: "Say hello again"
3. Press Enter
4. Should get response (using llama3.1:8b)

### Test 3: Token Counter Updates
1. Select "⚡ Fast"
2. Type a long message (100+ words)
3. Note token count
4. Switch to "💎 Quality"
5. Token count should recalculate (different context window)

## Console Check

### Open Developer Tools
1. Press `Ctrl+Shift+I` (Windows) or `Cmd+Option+I` (Mac)
2. Go to Console tab
3. Look for errors (should be none)

### Expected Log Messages
```
[provider] Preset changed to: fast
[provider] Preset changed to: balanced
[provider] Preset changed to: quality
[provider] Preset changed to: custom
```

## Common Issues

### Issue: Preset dropdown not visible
**Fix:** Rebuild extension: `npm run build`

### Issue: Model doesn't change when preset changes
**Fix:** Check console for errors, verify MODEL_PRESETS in webview.js

### Issue: Preset doesn't persist
**Fix:** Check workspace state is being saved (see provider.ts logs)

### Issue: "Custom" always selected
**Fix:** Verify findPresetForModel() logic in webview.js

## Success Criteria

✅ All visual elements appear correctly  
✅ Preset selection changes model  
✅ Model selection updates preset  
✅ Preset persists across restarts  
✅ No console errors  
✅ Messages send successfully with each preset  
✅ Token counter updates on preset change  

## If All Tests Pass

1. Review FEATURE_1.2_SUMMARY.md
2. Stage changes: `git add -A`
3. Commit with message from summary
4. Push: `git push origin main`
5. Update SESSION_STATE.md with commit hash
6. Move to Feature 1.3 (Code Actions Provider)

## If Tests Fail

1. Document issue in FEATURE_1.2_TEST_PLAN.md
2. Check console for errors
3. Review code changes
4. Fix and rebuild
5. Retest

---

**Estimated Time:** 5 minutes  
**Status:** Ready to test  
**Next:** Full test plan (FEATURE_1.2_TEST_PLAN.md)
