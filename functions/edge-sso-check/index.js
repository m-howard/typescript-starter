/**
 * CloudFront Function (viewer-request) - Edge SSO gate for the reader portal.
 *
 * Runs on every viewer request before CloudFront serves an object. If the caller has no session
 * cookie it is bounced to the Cognito hosted UI to authenticate against the corporate IdP, so the
 * portal's access-control claim is enforced at the edge rather than assumed. This is intentionally
 * a coarse presence check; the JWT/OAuth exchange and fine-grained ACLs live in the APIs.
 *
 * Note: CloudFront Functions use a constrained JS runtime — no ES modules, no async, no Node APIs.
 */
function handler(event) {
    var request = event.request;
    var headers = request.headers;

    // Allow the OAuth callback and static assets needed to complete sign-in.
    if (request.uri.indexOf('/oauth2/') === 0 || request.uri.indexOf('/auth/') === 0) {
        return request;
    }

    var hasSession = headers.cookie && headers.cookie.value.indexOf('kb_session=') !== -1;
    if (hasSession) {
        return request;
    }

    var loginHost = '__COGNITO_DOMAIN__';
    var clientId = '__CLIENT_ID__';
    var redirectUri = 'https://' + headers.host.value + '/oauth2/idpresponse';
    var location =
        'https://' +
        loginHost +
        '/oauth2/authorize?response_type=code&client_id=' +
        clientId +
        '&scope=openid+email+profile&redirect_uri=' +
        redirectUri;

    return {
        statusCode: 302,
        statusDescription: 'Found',
        headers: { location: { value: location } },
    };
}
