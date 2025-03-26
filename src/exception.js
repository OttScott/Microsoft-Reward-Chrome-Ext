function handleException(ex) {
    setBadge(new ErrorBadge());
    console.log('Error History:');
    logException(ex);
    throw ex;
}

function logException(ex) {
    if (ex.innerException) {
        logException(ex.innerException);
    }
    console.log(`Source: ${ex.source}\n`, ex);
}

class ErrorWithSourceInnerException extends Error {
    constructor(source, innerException, message) {
        message = message + '\nInnerEx: ' + (innerException ? innerException.stack : 'null');
        super(message);
        this.source = source;
        this.innerException = innerException;
    }
}

class FetchFailedException extends ErrorWithSourceInnerException {
    constructor(source, innerException, message) {
        console.log('FetchFailedException details:', {
            source: source,
            innerException: innerException,
            message: message
        });

        if (!innerException) {
            innerException = {
                message: 'No inner exception details available',
                name: 'UnknownError',
                stack: new Error().stack
            };
        }

        if (!message) {
            message = `Fetch failed at ${source}: ${innerException.message || 'Unknown error'}`;
        }

        super(source, innerException, message);
        this.name = 'FetchFailed::' + (innerException.name || 'UnknownError');
    }
}

class ResponseUnexpectedStatusException extends ErrorWithSourceInnerException {
    constructor(source, ex, message) {
        if (!message) {
            message = `Expected response status is within 200-299. Received response: ${ex}`;
        }
        super(source, null, message);
        this.name = 'FetchRedirected';
    }
}

class GoogleTrendPageNumberOverflowException extends ErrorWithSourceInnerException {
    constructor(source, innerException, message) {
        if (!message) {
            message = 'Failed to get more Google trend words because all pages have been used.';
        }
        super(source, innerException, message);
        this.name = 'GoogleTrendOverflow';
    }
}

class ParseJSONFailedException extends ErrorWithSourceInnerException {
    constructor(source, innerException, message) {
        if (!message) {
            message = 'Failed to parse the JSON file.';
        }
        super(source, innerException, message);
        this.name = 'ParseJSONFailed';
    }
}

class FetchTimeoutException extends ErrorWithSourceInnerException {
    constructor(source, innerException, message) {
        if (!message) {
            message = 'Fetch timeout.';
        }
        super(source, innerException, message);
        this.name = 'FetchTimeout';
    }
}

class UserAgentInvalidException extends Error {
    constructor(message) {
        super(message);
        this.name = 'UserAgentInvalid';
    }
}

class NotRewardUserException extends Error {
    constructor(message) {
        super(message);
        this.name = 'UserNotLoggedIn';
    }
}

class NetworkException extends Error {
    constructor(message) {
        super(message || 'Network connectivity issue detected');
        this.name = 'NetworkException';
    }
}

// Make sure it's added to the global scope
self.NetworkException = NetworkException;
