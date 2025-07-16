# Search Transition Fixes

## Issue Summary
PC searches complete but mobile searches never begin. The "Start searches now" button shows countdown and toggles between "Starting..." and "Start searches now" without transitioning to mobile search.

## Root Causes Identified

### 1. Search Completion Not Marked in Status
- PC search loop completes but doesn't mark `pcSearchStatus.isCompleted = true`
- This causes smart search logic to think PC isn't done
- Mobile search transition fails because completion detection is broken

### 2. Search Type Reset During Loops
- `_currentSearchType_` gets cleared prematurely
- Causes `_isCurrentSearchCompleted()` to return false (no search type = not complete)
- Search loops continue infinitely showing "31/1" (31 searches when only 1 needed)

### 3. Job Status Management Issues
- Status gets set to DONE too early in some cases
- Race conditions between completion detection and status updates

## Fixes Applied

### 1. Fixed Search Completion Marking
**File:** `searchQuest.js` - `_requestBingSearch()` method
```javascript
// Mark the specific search type as completed
if (this._currentSearchType_ == SEARCH_TYPE_PC_SEARCH && this._status_.pcSearchStatus) {
    this._status_.pcSearchStatus.isCompleted = true;
    console.log('PC search marked as completed');
} else if (this._currentSearchType_ == SEARCH_TYPE_MB_SEARCH && this._status_.mbSearchStatus) {
    this._status_.mbSearchStatus.isCompleted = true;
    console.log('Mobile search marked as completed');
}
```

### 2. Prevented Search Type Reset During Active Loops
**File:** `searchQuest.js` - `_requestBingSearch()` method
```javascript
// Ensure search type is still properly set - DON'T reset during active loop
if (!this._currentSearchType_) {
    console.error('Search type lost during loop, stopping to prevent infinite loop');
    this._jobStatus_ = STATUS_ERROR;
    break;
}
```

### 3. Enhanced Chrome Extension Message Error Handling
**Multiple methods:** Added `chrome.runtime.lastError` checking to prevent spam:
```javascript
(response) => {
    if (chrome.runtime.lastError) {
        console.warn('Message failed:', chrome.runtime.lastError.message);
    }
    resolve(response || { success: true });
}
```

### 4. Improved Cleanup Logic
**File:** `searchQuest.js` - `_quitSearchCleanUp()` method
- Only clear search type during final cleanup
- Better logging of completion status
- More accurate completion detection

## Expected Results

1. **PC Search Completion**: PC searches will properly mark as completed when target is reached
2. **Mobile Search Transition**: After PC completion, mobile searches will start automatically
3. **No More Infinite Loops**: Searches stop at the correct count (e.g., "1/1" instead of "31/1")
4. **Clean Error Handling**: No more spam of runtime.lastError messages
5. **Proper Status Updates**: Job status remains BUSY during transitions between search types

## Testing Steps

1. Start searches and verify PC completes at correct count
2. Confirm automatic transition to mobile search begins
3. Check console logs show proper completion marking
4. Verify no runtime error spam
5. Confirm final status shows both PC and mobile as completed

## Files Modified

- `src/quest/searchQuest.js` - Main search orchestration fixes
- Enhanced error handling in all message passing methods
- Improved completion detection and status marking
