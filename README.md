# Microsoft Rewards Bot

A Chrome extension for Microsoft Rewards, which automatically clears PC, mobile and Edge search quests and displays daily point countdown.

Daily Tasks can attempt supported quiz, poll, and visit-link promotions when enabled in Options. Completion depends on Microsoft Rewards; unsupported activities and failed attempts remain pending for retry.

**This is a bot!**

Use at your own risk. I do not take responsibility for any consequence caused by this extension.

# Install from GitHub

1. Head to [Release](https://github.com/tmxkn1/Microsoft-Reward-Chrome-Ext/releases) and download the latest Source code (zip).
2. Unzip the downloaded file to somewhere you want to keep it.
3. Open Chrome.
4. Go to chrome://extensions/ and enable `Developer mode`.
5. Select `Load unpacked` and select the `src` folder.
6. Enable the extension.

## Updating a local installation (2.28.3.0)

There is no build step: the browser runs the JavaScript in `src` directly.
For this checkout, the unpacked folder is
`F:\src\Repos\Microsoft-Reward-Chrome-Ext\src`.

1. Open `edge://extensions` (or `chrome://extensions`).
2. Click **Reload** on the existing Microsoft Rewards Bot extension. Do not remove it; reloading retains settings.
3. Approve access to `trends.google.com` if prompted, reopen the popup, and confirm version **2.28.3.0** on the extensions page.
4. In Options, verify the schedule and enable **Daily Tasks** if desired.

The browser must be running for scheduled work. Alarms recover work after service-worker restarts, but cannot wake a closed browser or guarantee that Microsoft credits searches.

The local regression suite uses mocked browser APIs and does not perform live searches:

```powershell
node --test tests\extension.test.js tests\googleTrend.test.js
```


# Install from Chrome web store

Unfortunately, the extension could not make its way to become visible on web store due to ... well ... obvious reasons.

# Use

1. Log into [Microsoft Rewards](https://account.microsoft.com/rewards) and [Bing](https://www.bing.com/).
2. Enjoy.

*Note: You may need to repeat step 1 every time you restart Chrome.*

# Functionality

### Background Work

The extension checks authenticated Microsoft Rewards counters and attempts incomplete searches at the configured interval, within the configured schedule. **Start Searches Now** overrides that schedule for the requested run. Regular work, schedule transitions, midnight resets, and delayed Daily Tasks use Chrome alarms rather than long-running JavaScript timers.

Search attempts and earned points are tracked separately: HTTP success does not mean Microsoft awarded credit. Sessions are bounded and leave uncredited searches pending for later work. Sign-in failures or unrecognized Rewards responses are reported instead of showing simulated points.

If optional activity counters use an unsupported format, search counters can still be used. The popup warns that activity totals are unavailable and displays unknown totals as `--`, not zero. Invalid search counters and sign-in failures still stop searches explicitly.

### Live search terms

Each search run fetches Google's public [US trending-search RSS feed](https://trends.google.com/trending/rss?geo=US).
These are currently trending queries, not an all-time popularity ranking. Live
terms stay active through pool refills and resets; previews do not consume them.

If the live feed fails or takes longer than 15 seconds, the extension logs the
reason and uses the packaged archive. It retries the live feed on the next run,
without the old 24-hour CORS lockout. The service-worker console reports the live
term count or fallback reason. Source diagnostics are also saved in local
storage as `googleTrendsSource` (`live`, `archive`, or `emergency`),
`googleTrendsLastFetch`, `googleTrendsTermCount`, and `googleTrendsLastError`.

### Action Button

1. A button to force check reward progress.
2. A link to Microsoft Rewards.
3. Options:
   1. Compatibility Mode. Toggle to enable/disable a different way of calculating point countdown. Try this if you have any issues with the current point countdown method.
   2. Copy Debug Info. This will place a bunch of information in your clipboard. The information is not useful for end users.

### Action Button Badge

The colour of the badge changes depending on your daily reward progress or the status of the extension:

![greyLogo](https://github.com/tmxkn1/Microsoft-Reward-Chrome-Ext/blob/master/src/img/grey@1x.png?raw=true) - Just hang on a second. The extension will start to work soon.

![blueLogo](https://github.com/tmxkn1/Microsoft-Reward-Chrome-Ext/blob/master/src/img/busy@1x.png?raw=true) - Working hard on doing those search quests for ya!

![greenLogo](https://github.com/tmxkn1/Microsoft-Reward-Chrome-Ext/blob/master/src/img/done@1x.png?raw=true) - Congratulations! You have completed all quests for today.

![yellowLogo](https://github.com/tmxkn1/Microsoft-Reward-Chrome-Ext/blob/master/src/img/warn@1x.png?raw=true) - Attention! You still have some points to earn through quests.

![redLogo](https://github.com/tmxkn1/Microsoft-Reward-Chrome-Ext/blob/master/src/img/err@1x.png?raw=true) - Oops... an error occurred - Check out [Troubleshooting](TROUBLESHOOTING.md).
