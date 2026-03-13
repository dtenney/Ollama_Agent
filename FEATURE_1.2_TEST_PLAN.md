# Feature 1.2: Model Presets - Test Plan

## Overview
Model presets allow users to quickly switch between Fast/Balanced/Quality configurations without manually selecting models and adjusting temperature.

## Implementation Summary

### Files Modified
1. **src/config.ts** - Added MODEL_PRESETS definitions
2. **webview/webview.html** - Added preset dropdown in header
3. **webview/webview.js** - Added preset selection logic and state management
4. **src/provider.ts** - Added preset persistence to workspace state

### Preset Configurations
- **Fast**: qwen2.5-coder:1.5b @ temp 0.5 (⚡ icon)
- **Balanced**: qwen2.5-coder:7b @ temp 0.7 (⚖️ icon) - DEFAULT
- **Quality**: llama3.1:8b @ temp 0.8 (💎 icon)
- **Custom**: User manually selects model (no icon)

## Test Cases

### TC1: Initial Load
**Steps:**
1. Open VS Code with OllamaPilot installed
2. Open the Ollama Agent sidebar

**Expected:**
- Preset dropdown shows "⚖️ Balanced" selected
- Model dropdown shows "qwen2.5-coder:7b" (if available)
- Preset persists across VS Code restarts

**Status:** ⏳ Pending

---

### TC2: Switch to Fast Preset
**Steps:**
1. Open Ollama Agent sidebar
2. Click preset dropdown
3. Select "⚡ Fast"

**Expected:**
- Preset dropdown shows "⚡ Fast"
- Model dropdown automatically changes to "qwen2.5-coder:1.5b"
- Selection persists in workspace state
- Next message uses Fast preset settings

**Status:** ⏳ Pending

---

### TC3: Switch to Quality Preset
**Steps:**
1. Open Ollama Agent sidebar
2. Click preset dropdown
3. Select "💎 Quality"

**Expected:**
- Preset dropdown shows "💎 Quality"
- Model dropdown automatically changes to "llama3.1:8b"
- Selection persists in workspace state
- Next message uses Quality preset settings

**Status:** ⏳ Pending

---

### TC4: Manual Model Selection (Custom Preset)
**Steps:**
1. Start with any preset selected
2. Manually change model dropdown to a different model (e.g., "phi3:mini")

**Expected:**
- Preset dropdown automatically switches to "Custom"
- Model selection is preserved
- Custom selection persists in workspace state

**Status:** ⏳ Pending

---

### TC5: Preset Persistence Across Sessions
**Steps:**
1. Select "⚡ Fast" preset
2. Send a message
3. Close VS Code
4. Reopen VS Code and workspace
5. Open Ollama Agent sidebar

**Expected:**
- Preset dropdown shows "⚡ Fast" (restored from workspace state)
- Model dropdown shows "qwen2.5-coder:1.5b"
- Previous selection is preserved

**Status:** ⏳ Pending

---

### TC6: Preset Persistence Across Workspace Changes
**Steps:**
1. Open workspace A, select "💎 Quality"
2. Open workspace B, select "⚡ Fast"
3. Switch back to workspace A

**Expected:**
- Workspace A shows "💎 Quality" (workspace-scoped)
- Workspace B shows "⚡ Fast" (workspace-scoped)
- Each workspace maintains its own preset

**Status:** ⏳ Pending

---

### TC7: Model Not Available
**Steps:**
1. Select "💎 Quality" preset (requires llama3.1:8b)
2. Ensure llama3.1:8b is NOT pulled in Ollama

**Expected:**
- Preset dropdown shows "💎 Quality"
- Model dropdown shows "llama3.1:8b" but may show error when sending
- User can manually switch to available model (becomes Custom)

**Status:** ⏳ Pending

---

### TC8: Bidirectional Sync
**Steps:**
1. Select "⚖️ Balanced" preset
2. Manually change model to "qwen2.5-coder:7b" (same as Balanced)

**Expected:**
- Preset dropdown remains "⚖️ Balanced" (recognizes matching model)
- No unnecessary preset changes

**Status:** ⏳ Pending

---

### TC9: Token Counter Updates
**Steps:**
1. Select "⚡ Fast" preset (1.5b model, smaller context)
2. Type a long message
3. Switch to "💎 Quality" preset (8b model, larger context)

**Expected:**
- Token counter updates to reflect new model's context window
- Warning thresholds adjust accordingly
- No errors in console

**Status:** ⏳ Pending

---

### TC10: New Chat Preserves Preset
**Steps:**
1. Select "💎 Quality" preset
2. Send a message
3. Click "New Chat" button

**Expected:**
- Preset dropdown still shows "💎 Quality"
- Model dropdown still shows "llama3.1:8b"
- New chat uses same preset as before

**Status:** ⏳ Pending

---

## Manual Testing Checklist

### Visual Verification
- [ ] Preset dropdown appears in header (between title and model dropdown)
- [ ] Preset dropdown has correct width (~90px)
- [ ] Icons display correctly (⚡⚖️💎)
- [ ] Dropdown styling matches VS Code theme
- [ ] No layout issues on narrow sidebars

### Functional Verification
- [ ] Preset selection changes model dropdown
- [ ] Model selection updates preset dropdown (or sets to Custom)
- [ ] Preset persists across VS Code restarts
- [ ] Preset is workspace-scoped (different per workspace)
- [ ] No console errors when switching presets
- [ ] Token counter updates when preset changes

### Edge Cases
- [ ] Works when no models are available
- [ ] Works when selected model is not pulled
- [ ] Works with custom models not in preset list
- [ ] Works when switching workspaces rapidly
- [ ] Works when extension is reloaded (Developer: Reload Window)

## Performance Verification
- [ ] Preset switching is instant (<50ms)
- [ ] No lag when typing after preset change
- [ ] No memory leaks after multiple preset switches
- [ ] Workspace state updates are non-blocking

## Regression Testing
- [ ] Existing model dropdown still works
- [ ] Chat history still loads correctly
- [ ] @mentions still work
- [ ] Context bar still works
- [ ] All existing features unaffected

## Known Limitations
1. Preset models must be pulled in Ollama before use
2. Temperature is not exposed in UI (preset-controlled only)
3. Custom preset doesn't save temperature setting
4. Preset names are hardcoded (not user-configurable)

## Future Enhancements (Not in Scope)
- [ ] User-defined custom presets
- [ ] Temperature slider in UI
- [ ] Preset import/export
- [ ] Per-session preset override
- [ ] Preset tooltips showing model details

---

## Test Results

### Test Date: _____________
### Tester: _____________
### VS Code Version: _____________
### Extension Version: 0.2.0

| Test Case | Status | Notes |
|-----------|--------|-------|
| TC1 | ⏳ | |
| TC2 | ⏳ | |
| TC3 | ⏳ | |
| TC4 | ⏳ | |
| TC5 | ⏳ | |
| TC6 | ⏳ | |
| TC7 | ⏳ | |
| TC8 | ⏳ | |
| TC9 | ⏳ | |
| TC10 | ⏳ | |

### Overall Status: ⏳ PENDING TESTING

### Bugs Found:
(None yet)

### Notes:
(Add any observations here)

---

**Document Status:** Ready for Testing  
**Created:** 2026-03-12  
**Feature:** Phase 1.2 - Model Presets
