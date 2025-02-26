const DEBUG = true;  // Add this at the top

function debugLog(...args) {
    if (DEBUG) {
        console.log(new Date().toISOString(), ...args);
    }
}

let _prevWeekDay = -1;

function checkNewDay() {
    if (isNewDay()) {
        // if a new day, reset variables
        resetDayBoundParams();
    }
}

function isNewDay() {
    let day;
    if ((day = new Date().getDay()) != _prevWeekDay) {
        _prevWeekDay = day;
        return true;
    }
    return false;
}

function getDomFromText(text) {
    return new DOMParser().parseFromString(text, 'text/html');
}

function getTodayDate() {
    const today = new Date();
    let dd = today.getDate();
    let mm = today.getMonth() + 1;
    if (dd < 10) {
        dd = '0' + dd;
    }
    if (mm < 10) {
        mm = '0' + mm;
    }
    return `${mm}/${today.getFullYear()}`;
}

function resetDayBoundParams() {
    searchQuest.reset();
    googleTrend.reset();
}

function isHttpUrlValid(url) {
    // rule:
    // starts with https:// or http://
    // followed by non-whitespace character
    // must end with a word character, a digit, or close bracket (')') with or without forward slash ('/')
    return /^https?:\/\/\S+.*\..*[\w\d]+\)?\/?$/i.test(url);
}

function getElementByXpath(path, element) {
    return document.evaluate(path, element, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
}

async function copyTextToClipboard(text) {
    // Credit: https://stackoverflow.com/a/18455088/1786137
    // Create a textbox field where we can insert text to.
    const copyFrom = document.createElement('textarea');

    // Set the text content to be the text you wished to copy.
    copyFrom.textContent = text;

    // Append the textbox field into the body as a child.
    // "execCommand()" only works when there exists selected text, and the text is inside
    // document.body (meaning the text is part of a valid rendered HTML element).
    document.body.appendChild(copyFrom);

    // Select all the text!
    copyFrom.select();

    // Execute command
    document.execCommand('copy');

    // (Optional) De-select the text using blur().
    copyFrom.blur();

    // Remove the textbox field from the document.body, so no other JavaScript nor
    // other elements can get access to this.
    document.body.removeChild(copyFrom);
}

async function getDebugInfo() {
    let text = '[';
    console.log('Collecting debug info...');

    await userDailyStatus.getUserStatusJson().then(
        (statusJson) => {
            console.log('Retrieved user status JSON:', statusJson);
            info = {
                'IsError': statusJson.IsError,
                'IsRewardsUser': statusJson.IsRewardsUser,
                'FlyoutResult': {
                    'DailySetPromotions': statusJson.FlyoutResult.DailySetPromotions,
                    'MorePromotions': statusJson.FlyoutResult.MorePromotions,
                },
                'UserStatus': {
                    'Counters': statusJson.FlyoutResult.UserStatus.Counters,
                },
            };
            text += JSON.stringify(info);
        },
    ).catch((ex) => {
        console.error('Error getting user status:', ex);
        text += '"' + ex.message + '"';
    });

    await userDailyStatus.getDetailedUserStatusJson().then(
        (statusJson) => {
            console.log('Retrieved detailed status JSON:', statusJson);
            info = {
                'punchCards': statusJson.punchCards,
            };
            text += ',' + JSON.stringify(info);
        },
    ).catch((ex) => {
        console.error('Error getting detailed status:', ex);
        text += ',"' + ex.message + '"';
    });

    text += ']';
    console.log('Debug info collected:', text);
    copyTextToClipboard(text);
}

async function getUA() {
    debugLog('Getting user agents...');
    if (_pcUaOverrideEnable && _mbUaOverrideEnable) {
        userAgents = {
            'pc': _pcUaOverrideValue,
            'mb': _mbUaOverrideValue,
            'pcSource': 'override',
            'mbSource': 'override',
        };
        assertUA();
        return;
    }
    await getStableUA();
    if (_pcUaOverrideEnable) {
        userAgents['pc'] = _pcUaOverrideValue;
        userAgents['pcSource'] = 'override';
    } else if (_mbUaOverrideEnable) {
        userAgents['mb'] = _mbUaOverrideValue;
        userAgents['mbSource'] = 'override';
    }
    assertUA();
}

async function getStableUA() {
    console.log('Fetching stable user agents...');
    const controller = new AbortController();
    const signal = controller.signal;
    const url = 'https://raw.githubusercontent.com/tmxkn1/Microsoft-Reward-Chrome-Ext/master/useragents.json';
    
    try {
        const fetchProm = fetch(url, {method: 'GET', signal: signal});
        setTimeout(() => controller.abort(), 3000);

        const response = await fetchProm;
        console.log('Stable UA fetch response:', response.status, response.statusText);

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Stable UA fetch failed:', errorText);
            throw new Error(errorText);
        }

        const text = await response.text();
        const ua = JSON.parse(text);
        userAgents = {
            'pc': ua.stable.edge_win,
            'mb': ua.stable.chrome_ios,
            'pcSource': 'stable',
            'mbSource': 'stable',
        };
    } catch (ex) {
        console.error('Stable UA fetch error:', {
            name: ex.name,
            message: ex.message,
            stack: ex.stack
        });
        
        if (ex.name === 'AbortError') {
            throw new FetchFailedException('getStableUA', ex, 'Fetch timed out. Failed to update user agents. Perhaps, Github server is offline.');
        }
        throw new FetchFailedException('getStableUA', ex);
    }
}

async function getUpdatedUA(type='both') {
    console.log('Fetching updated user agents for type:', type);
    const controller = new AbortController();
    const signal = controller.signal;
    const url = 'https://raw.githubusercontent.com/tmxkn1/UpdatedUserAgents/master/useragents.json';
    
    try {
        const fetchProm = fetch(url, {method: 'GET', signal: signal});
        setTimeout(() => controller.abort(), 3000);

        const response = await fetchProm;
        console.log('Updated UA fetch response:', response.status, response.statusText);

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Updated UA fetch failed:', errorText);
            throw new Error(errorText);
        }

        const text = await response.text();
        const ua = JSON.parse(text);
        if (type == 'both') {
            userAgents.pc = ua.edge.windows;
            userAgents.mb = ua.chrome.ios;
            userAgents.pcSource = 'updated';
            userAgents.mbSource = 'updated';
        } else if (type == 'pc') {
            userAgents.pc = ua.edge.windows;
            userAgents.pcSource = 'updated';
        } else if (type == 'mb') {
            userAgents.mb = ua.chrome.ios;
            userAgents.mbSource = 'updated';
        }
        assertUA();
    } catch (ex) {
        console.error('Updated UA fetch error:', {
            name: ex.name,
            message: ex.message,
            stack: ex.stack
        });
        
        if (ex.name === 'AbortError') {
            throw new FetchFailedException('getUpdatedUA', ex, 'Fetch timed out. Failed to update user agents. Do you have internet connection? Otherwise, perhaps Github server is down.');
        }
        throw new FetchFailedException('getUpdatedUA', ex);
    }
}

function assertUA() {
    console.log('Asserting user agents:', userAgents);
    if (!userAgents.pc || !userAgents.mb) {
        const error = new UserAgentInvalidException('Failed to assert user agents. \n UA:\n' + JSON.stringify(userAgents));
        console.error('UA assertion failed:', error);
        throw error;
    }
}
