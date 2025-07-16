# Changelog

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
