# Microsoft Rewards Extension - Issues Tracker

## Current Issues

### 1. Search Loop Race Condition (Fixed)
**Status:** Fixed  
**Description:** Getting error "Search type was reset during loop, reinitializing" when the cleanup method was called while search loops were still active, causing race conditions.

**Root Cause:**
- The `_quitSearchCleanUp()` method was being called while search loops were still running
- This reset `_currentSearchType_` to null during active searches
- Search loops detected the reset and tried to reinitialize, causing errors

**Solution Implemented:**
1. **Changed Error to Warning**: Converted `console.error` to `console.warn` since this is a recoverable condition
2. **Added Cleanup Guards**: Modified `_quitSearchCleanUp()` to only clear search type when not in active loop
3. **Enhanced Loop Recovery**: Added graceful exit handling when status changes during reinitialization
4. **Improved Synchronization**: Added status checks to prevent race conditions between cleanup and active loops

**Files Modified:**
- `src/quest/searchQuest.js`: Enhanced search loop synchronization and cleanup handling

### 2. Mobile Search Point Earning Enhancement (In Progress)
**Status:** In Progress  
**Description:** Mobile searches may not be earning points effectively because Microsoft has tightened requirements and expects mobile searches to come from their mobile app rather than browser-based searches with mobile user agents.

**Enhancements Implemented:**
1. **Enhanced Mobile User Agents**: Replaced single fallback mobile UA with array of varied, recent mobile user agents including iOS Safari, Edge Mobile, and Chrome Mobile with random selection
2. **Mobile-Specific Search URLs**: Implemented mobile-optimized Bing URLs with mobile app parameters (`form=QBREMB`, `cvid` generation, mobile-specific query parameters)
3. **Mobile-Specific Headers**: Added mobile-specific request headers including `Sec-Fetch-*` headers, viewport width, and mobile-optimized accept headers
4. **Mobile Search Delays**: Implemented longer, randomized delays for mobile searches (15-25 seconds) to better mimic human mobile usage patterns
5. **Random CVID Generation**: Added dynamic CVID generation for mobile searches to mimic Bing mobile app behavior

**Files Modified:**
- `src/quest/searchQuest.js`: 
  - Enhanced `_applyFallbackUserAgents()` with varied mobile user agents
  - Added `_buildSearchUrl()` for mobile-optimized URLs
  - Added `_buildSearchHeaders()` for mobile-specific headers
  - Added `_generateRandomCvid()` for mobile app mimicking
  - Added `_getMobileSearchDelay()` for mobile-specific timing
  - Modified `_updateSearchProgress()` to use mobile delays
  - Enhanced `_performSingleSearch()` to use new mobile adaptations

**Technical Details:**
- **Mobile User Agents**: Now includes iOS 16.7-17.2, Edge Mobile, Chrome Mobile with random rotation
- **Mobile URLs**: Uses `form=QBREMB` and dynamic CVID parameters like mobile app
- **Mobile Headers**: Includes viewport width, Sec-Fetch headers for mobile browsing context
- **Mobile Timing**: 15-25 second randomized delays vs standard PC intervals

## Fixed Issues

### 1. Mobile Searches Not Starting After PC Completion (Fixed)
**Status:** Fixed  
**Description:** When PC searches were exhausted/completed, mobile searches would not automatically start, requiring manual intervention.

**Root Causes Found:**
1. **Logic Error in Smart Switching**: The smart switching algorithm had flawed conditional logic that prevented proper transition from PC to mobile searches
2. **No Continuous Evaluation**: The system didn't continuously re-evaluate which search types were still needed after each completion
3. **Duplicate Method Conflicts**: Duplicate `skipCurrentSearch` methods were causing potential runtime errors
4. **Missing Status Refresh**: Status wasn't being refreshed between search type transitions

**Solutions Implemented:**
1. **Enhanced Smart Switching Logic**: Rewrote `_doSmartSearches()` to use a continuous loop that re-evaluates search needs after each completion
2. **Status Re-evaluation**: Added proper status updates (`await this._status_.update()`) between search type transitions
3. **Cleaned Up Code**: Removed duplicate `skipCurrentSearch` method and kept the more comprehensive version
4. **Improved Logging**: Added detailed logging to track search type transitions and decision-making

**Files Modified:**
- `src/quest/searchQuest.js`: Complete rewrite of smart switching logic with continuous evaluation loop

### 2. Countdown Progress Bar Loading Empty (Fixed)
**Status:** Fixed  
**Description:** The countdown progress bar showed as empty/zero even when there was still time remaining until the next search. The timeout time hadn't been reached yet but the progress calculation was incorrect.

**Root Causes Found:**
1. **Progress Reset Issue**: Smoothing logic prevented `percentComplete` from resetting to 0 when a new search started
2. **Calculation Logic**: Progress calculation used `timeRemaining` in a way that could cause division issues
3. **Client-Server Sync**: Client-side countdown and server-side progress updates weren't properly synchronized
4. **Tracking Problems**: No proper detection of when a new search interval began

**Solutions Implemented:**
1. **Enhanced Progress Calculation**: Rewrote `getSearchProgress()` to use elapsed time instead of remaining time for more reliable calculation
2. **New Search Detection**: Added tracking keys to detect when a new search starts and reset progress accordingly
3. **Validation & Fallbacks**: Added comprehensive validation for all progress values with fallback calculations
4. **Synchronized Tracking**: Both client-side and server-side now use the same search key tracking system
5. **Debug Logging**: Added detailed logging to identify anomalies in progress calculation

**Files Modified:**
- `src/quest/searchQuest.js`: Complete rewrite of progress calculation logic
- `src/popup/popup.js`: Enhanced countdown display with new search detection and fallback calculations

### 3. Automatic Wake-up After Scheduled Sleep (Fixed)
**Status:** Resolved  
**Description:** Extension would sleep at scheduled end time but fail to automatically wake up at scheduled start time, requiring manual intervention.

**Solution:** Enhanced scheduling system with proper pause/resume state management, automatic wake-up with comprehensive flag clearing and job status reset.

### 2. Console Error "[object Object]" (Fixed)
**Status:** Resolved  
**Description:** Console was showing object references instead of proper error messages.

**Solution:** Enhanced error handling and message formatting throughout the codebase.

### 3. Progress Bar Jumping/Jerky Movement (Fixed)
**Status:** Resolved  
**Description:** Progress bar would jump backwards or show erratic movement during countdown.

**Solution:** Implemented smoothing algorithms and anti-jumping logic in progress calculation.

## Enhancement Requests

### 1. Smart Search Switching (Implemented)
**Status:** Complete  
**Description:** Switch to mobile searches when PC searches reach maximum points for the day.

### 2. Interleaved Search Pattern (Implemented)
**Status:** Complete  
**Description:** Alternate between PC and mobile searches in patterns.

### 3. Random Batch Sizes (Implemented)
**Status:** Complete  
**Description:** Use random batch sizes (3-8) instead of static patterns.

## Development Notes

- Main search logic in `src/quest/searchQuest.js`
- UI progress handling in `src/popup/popup.js`
- Background scheduling in `src/background.js`
- Progress calculation uses smoothing to prevent jumping
- Client-side countdown runs every 1000ms for smooth display
