# Changelog

## Version 2.27.1.0 - December 3, 2025

### 🐛 **CRITICAL BUG FIXES: Race Condition Crashes**
- **Null Reference Protection**: Added null checks before calling `status.update()` to prevent crashes
- **Morning Restart Guard**: Prevents morning restart from executing if searches are already running
- **Duplicate Start Prevention**: Blocks duplicate morning starts during periodic checks
- **Race Condition Fix**: Resolves "Cannot read properties of null" errors during simultaneous initializations
- **Status Object Safety**: All status update calls now verify object exists before attempting updates

### 🔧 **Stability Improvements**
- **Graceful Degradation**: Extension continues operating even if status updates fail
- **Warning Messages**: Clear console warnings when status object is unavailable
- **Search Continuity**: Searches complete successfully even during status update failures
- **Initialization Ordering**: Fixed race conditions between periodic checks and manual starts

---

## Version 2.27.0.0 - December 3, 2025

### 🎯 **Dynamic Daily Point Limits**
- **Automatic Detection**: Extension now detects Microsoft's daily maximum search points from rewards page (e.g., 300 points during promotions)
- **Adaptive Completion**: Searches until actual daily maximum is reached instead of stopping at hardcoded 150 points
- **Smart Notifications**: Alerts users when increased daily limits are detected (e.g., "Daily search limit increased to 300 points!")
- **Points-Based Completion**: True completion based on total points earned vs. daily maximum, not just search counts
- **Promotion Support**: Automatically handles Microsoft Rewards special promotions and bonus point periods

### 📊 **Enhanced Status Tracking**
- **Real-Time Max Points**: Dynamically extracts daily maximum from Microsoft Rewards page HTML
- **Multi-Layer Completion Check**: Validates completion using both search counts AND total points vs. daily maximum
- **Detailed Logging**: Comprehensive console logs show earned points, daily max, and completion status with emoji indicators
- **Completion Notifications**: Final notification shows exact points reached (e.g., "Reached maximum 300 search points for the day!")

### 🔧 **Technical Improvements**
- **HTML Parsing**: Extracts daily maximum from patterns like "65 of 300 daily search points"
- **Fallback Defaults**: Uses sensible defaults (150 points) if extraction fails
- **Sanity Validation**: Validates extracted maximums are within reasonable range (100-500 points)
- **Status Summary Enhancement**: Added `maxDailySearchPoints` to status summary object

---

## Version 2.26.0.0 - November 26, 2025

### 🌅 **CRITICAL FIX: Automatic Morning Startup System**
- **Chrome Alarms API**: Replaced unreliable setTimeout timers with persistent Chrome alarms
- **Periodic Wake-Up Checks**: Added hourly background check to detect and recover from missed morning starts
- **Multiple Wake-Up Triggers**: Morning start can now be triggered by alarms, Chrome startup, extension reload, OR popup open
- **Missed Start Detection**: Automatically detects if scheduled start time was missed and starts immediately
- **Persistent Across Restarts**: System survives service worker termination, Chrome restart, and computer reboot

### 🎯 **Points-Based Completion System**
- **True Completion Detection**: Extension checks actual points earned (150/150) instead of just search counts
- **Automatic Additional Cycles**: If searches appear complete but points remain, automatically runs another cycle
- **Persistent Until Complete**: Continues running cycles until full daily Microsoft Rewards goal is achieved
- **Completion Notifications**: Shows notifications when additional cycles are needed for remaining points

### 🎨 **Enhanced Badge Management**  
- **Schedule-Aware Badges**: Badge shows gray when outside search time window
- **Smart State Transitions**: Badges correctly reflect state when schedule opens/closes and timers restart
- **Fixed Gray Badge Issue**: Resolved badge remaining gray when extension reloads during active search hours
- **Proper Badge Classes**: Added OffBadge class for outside-schedule periods

### 🛑 **Advanced Search Controls**
- **Three-Button System**: Skip (yellow), Next (blue), and Stop (red) buttons for complete search control
- **Stop Until Tomorrow**: Stop button halts searches until next day or manual restart
- **Enhanced Skip**: Skip properly advances to next term with immediate visual feedback
- **Force Next**: Next button immediately triggers the next search in sequence

### 🔧 **Search Quest Improvements**
- **Robust Stop Logic**: Fixed property assignment errors with fallback mechanisms
- **Better State Management**: Enhanced job status handling with getter/setter compatibility  
- **Circuit Breaker Protection**: Multiple safety checks prevent infinite loops and lockups
- **Error Recovery**: Improved error handling during search restoration and completion detection

### 🐛 **Bug Fixes**
- **Schedule Resume Logic**: Fixed direct property assignment errors in resume functions
- **Timer Recovery**: Resolved issues with timer restoration after browser restarts
- **Badge Consistency**: Fixed badge state during initialization and schedule transitions
- **External Dependencies**: Eliminated external GitHub repository dependencies for better reliability

### 📊 **System Reliability**
- **Hourly Monitoring**: Periodic alarm checks every 60 minutes for missed starts
- **Multi-Layer Recovery**: Four different mechanisms ensure morning startup happens
- **Persistent State**: Chrome storage tracks last run date for accurate new-day detection
- **Comprehensive Logging**: Debug logs with emoji indicators for easy troubleshooting

---

## Version 2.25.0.0 - July 16, 2025

### 🚀 Major Performance Improvements
- **Optimized Term Loading**: Implemented batch loading system that loads only 50 terms at a time instead of all 1400+ terms
- **Memory Efficiency**: Reduced memory usage by ~96% during search term selection
- **Intelligent Caching**: Added smart caching system with efficient indexing and shuffling
- **Startup Performance**: Significantly faster extension startup due to optimized term pool initialization

### 🔧 Skip Functionality Restoration
- **Fixed Skip Button**: Restored proper skip button functionality that was broken in previous versions
- **Visual Feedback**: Skip button now provides immediate visual feedback ("Skipping...") when pressed
- **Next Term Updates**: Skip now immediately refreshes the displayed next search term
- **Session Randomization**: Each new search session uses different random offsets to ensure term variety

### 🎨 User Interface Enhancements
- **Larger Popup**: Increased popup dimensions from 350x480px to 450x640px
- **No More Scroll Bars**: Eliminated scroll bars by optimizing layout and sizing
- **Fixed Display Issues**: Resolved "[object Object]" display issue in next search term
- **Better Space Utilization**: Improved layout margins and padding for better content fit

### 🛠️ Technical Improvements
- **Async Compatibility**: Added dual sync/async methods for backward compatibility
- **Error Handling**: Enhanced error handling and type safety throughout the codebase
- **Log Spam Reduction**: Implemented throttling to reduce excessive console logging
- **Circuit Breakers**: Added intelligent circuit breaker logic to prevent infinite loops
- **Removed External Dependencies**: Disabled external version checking and user agent fetching from GitHub repositories

### 🐛 Bug Fixes
- **Search Type Initialization**: Fixed issues with search type being lost during search loops
- **Progress Calculation**: Resolved progress calculation anomalies and excessive polling
- **Message Handling**: Fixed message port errors and improved async response handling
- **Term Selection**: Eliminated duplicate terms within sessions and improved randomization

### 📊 Performance Metrics
- **Memory Usage**: Reduced from ~1400 terms to ~50 terms in active memory
- **Load Time**: Faster startup with batch loading instead of full file parsing
- **Search Latency**: Immediate term retrieval from pre-loaded working pool
- **Skip Responsiveness**: Instant UI feedback with pre-cached next terms

---

## Previous Versions

### Version 2.24.2.1 and earlier
- Basic search automation functionality
- Original term loading system
- Standard popup dimensions
- Basic skip functionality
