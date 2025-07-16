# Fix for "Search type lost during loop" Error

## Problem Description
The extension was immediately failing on load with the error:
```
Search type lost during loop, stopping to prevent infinite loop
```
This occurred in `quest/searchQuest.js` at line 927.

## Root Cause Analysis

### 1. Race Condition Issue
- `_startSearchQuests()` calls `_quitSearchCleanUp()` immediately after search strategies complete
- `_quitSearchCleanUp()` clears `this._currentSearchType_ = null`
- Meanwhile, `_requestBingSearch()` is still running its search loop asynchronously
- The loop detects that `_currentSearchType_` is null and immediately errors out

### 2. Poor Error Handling
- The original code immediately set status to ERROR when `_currentSearchType_` was null
- No attempt was made to recover or determine the correct search type from context
- This created a brittle system that failed on any timing issue

### 3. Inadequate Cleanup Timing
- Cleanup was triggered too early, before async operations completed
- No checks to ensure searches were actually finished before cleanup
- Missing delay to allow operations to complete

## Fixes Applied

### 1. **Intelligent Search Type Recovery**
**File**: `src/quest/searchQuest.js` (lines ~927)

**Before:**
```javascript
if (!this._currentSearchType_) {
    console.error('Search type lost during loop, stopping to prevent infinite loop');
    this._jobStatus_ = STATUS_ERROR;
    break;
}
```

**After:**
```javascript
if (!this._currentSearchType_) {
    console.warn('Search type lost during loop, attempting to restore based on context');
    
    // Try to determine correct search type based on current search context
    const pcCompleted = this._status_?.pcSearchStatus?.isCompleted;
    const mbCompleted = this._status_?.mbSearchStatus?.isCompleted;
    
    if (!pcCompleted) {
        console.log('Restoring PC search type');
        this._preparePCSearch();
    } else if (!mbCompleted) {
        console.log('Restoring Mobile search type');
        this._prepareMbSearch();
    } else {
        console.error('Both search types completed but loop still running, stopping to prevent infinite loop');
        this._jobStatus_ = STATUS_DONE;
        break;
    }
    
    // Double-check that we successfully restored the search type
    if (!this._currentSearchType_) {
        console.error('Failed to restore search type, stopping to prevent infinite loop');
        this._jobStatus_ = STATUS_ERROR;
        break;
    }
}
```

### 2. **Safer Cleanup Logic**
**File**: `src/quest/searchQuest.js` (lines ~900)

**Before:**
```javascript
// Always clear search type when doing final cleanup
this._currentSearchType_ = null;
console.log('Cleared search type during final cleanup');
```

**After:**
```javascript
// Only clear search type if we're truly done or in error state
if (this._jobStatus_ === STATUS_DONE || this._jobStatus_ === STATUS_ERROR) {
    this._currentSearchType_ = null;
    console.log('Cleared search type during final cleanup');
} else {
    console.log('Skipping search type clear - searches may still be running');
}
```

### 3. **Improved Initialization Logic**
**File**: `src/quest/searchQuest.js` (lines ~920)

**Before:**
```javascript
if (!this._currentSearchType_) {
    console.warn('Search type not initialized, defaulting to PC search');
    this._preparePCSearch();
}
```

**After:**
```javascript
if (!this._currentSearchType_) {
    console.warn('Search type not initialized, determining appropriate type...');
    
    // Determine which search type to start with based on completion status
    const pcCompleted = this._status_?.pcSearchStatus?.isCompleted;
    const mbCompleted = this._status_?.mbSearchStatus?.isCompleted;
    
    if (!pcCompleted) {
        console.log('Starting with PC search');
        this._preparePCSearch();
    } else if (!mbCompleted) {
        console.log('Starting with Mobile search');
        this._prepareMbSearch();
    } else {
        console.warn('Both search types appear completed, defaulting to PC search');
        this._preparePCSearch();
    }
}
```

### 4. **Delayed Cleanup with Safety Checks**
**File**: `src/quest/searchQuest.js` (lines ~170)

**Before:**
```javascript
console.log('_startSearchQuests() calling cleanup...');
this._quitSearchCleanUp();
```

**After:**
```javascript
console.log('_startSearchQuests() search strategies completed, checking for cleanup...');

// Add a small delay to ensure any async operations complete
await new Promise(resolve => setTimeout(resolve, 1000));

// Only cleanup if no searches are currently running
if (this._jobStatus_ !== STATUS_BUSY) {
    console.log('Safe to cleanup - no searches running');
    this._quitSearchCleanUp();
} else {
    console.log('Searches still running, deferring cleanup');
    // The individual search functions will handle their own cleanup
}
```

### 5. **Added Finally Block for Local Cleanup**
**File**: `src/quest/searchQuest.js` (lines ~1040)

**Added:**
```javascript
} finally {
    // Ensure proper cleanup when this specific search session ends
    if (this._jobStatus_ !== STATUS_BUSY) {
        console.log('_requestBingSearch session ended, performing local cleanup');
        removeUA(); // Clean up user agent
        
        // Don't clear search type here as other searches might still be running
        // Let the main cleanup handle that
    }
}
```

## Benefits of These Fixes

### 1. **Fault Tolerance**
- System no longer crashes immediately when search type is lost
- Attempts intelligent recovery based on completion status
- Graceful degradation instead of immediate failure

### 2. **Race Condition Prevention**
- Cleanup is delayed and conditional
- Proper checks before clearing critical state
- Async operations are given time to complete

### 3. **Better Debugging**
- Enhanced logging shows exactly what's happening
- Clear indication of recovery attempts
- Better visibility into timing issues

### 4. **Robust State Management**
- Search type determination based on actual completion status
- Multiple fallback strategies
- Safer cleanup that doesn't interfere with running operations

## Expected Behavior After Fix

1. **Normal Operation**: Extension loads without immediate errors
2. **Recovery**: If search type is lost, system attempts intelligent recovery
3. **Debugging**: Clear console logs show state transitions and recovery attempts
4. **Cleanup**: Safer, delayed cleanup that doesn't interfere with running searches

The extension should now be much more resilient to timing issues and race conditions during the search process.
