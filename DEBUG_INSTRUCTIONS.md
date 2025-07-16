# Debug Steps for Microsoft Rewards Extension

## To debug the "No scheduled searches found" issue:

### 1. Open Chrome Extension Developer Tools
1. Go to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Find "Microsoft Rewards" extension
4. Click "Service worker" or "background page" link

### 2. Run Debug Commands in Console

Copy and paste this in the console:

```javascript
// Check current state
console.log('=== CURRENT STATE ===');
console.log('isSchedulePaused:', typeof isSchedulePaused !== 'undefined' ? isSchedulePaused : 'undefined');
console.log('scheduledWorkTimer:', typeof scheduledWorkTimer !== 'undefined' ? scheduledWorkTimer : 'undefined');
console.log('scheduleWakeUpTimer:', typeof scheduleWakeUpTimer !== 'undefined' ? scheduleWakeUpTimer : 'undefined');

// Check storage
chrome.storage.local.get([
  'nextRegularWorkTime',
  'nextWakeUpTime', 
  'isSchedulePaused',
  'scheduleState'
]).then(data => {
  console.log('=== STORAGE STATE ===');
  console.log(data);
});

// Check sync settings
chrome.storage.sync.get([
  'enableSchedule',
  'startTime',
  'endTime',
  'baseSearchInterval'
]).then(settings => {
  console.log('=== SYNC SETTINGS ===');
  console.log(settings);
});
```

### 3. Manually Initialize if Needed

If the above shows undefined values, try manually initializing:

```javascript
// Manual initialization
if (typeof initializeScheduleSystem === 'function') {
  initializeScheduleSystem().then(() => {
    console.log('Schedule system manually initialized');
    return scheduleNextWork();
  }).then(() => {
    console.log('Next work scheduled manually');
    // Check storage again
    return chrome.storage.local.get(['nextRegularWorkTime']);
  }).then(data => {
    console.log('Next work time after manual init:', data);
  });
} else {
  console.log('initializeScheduleSystem function not found');
}
```

### 4. Test Manual Start

Try manually starting searches:

```javascript
// Test manual start
doBackgroundWork().then(() => {
  console.log('Manual background work completed');
}).catch(error => {
  console.error('Manual background work failed:', error);
});
```

### 5. Expected Results

After running the above:
- `isSchedulePaused` should be a boolean
- `nextRegularWorkTime` should have a future timestamp
- Manual start should work and begin searches

### 6. If Still Not Working

Check if there are any errors in the console, and verify:
1. Extension manifest is valid
2. All required permissions are granted
3. No JavaScript errors during initialization

### 7. Reload Extension

If needed, go back to `chrome://extensions/` and click the reload button for the extension, then repeat the debug steps.
