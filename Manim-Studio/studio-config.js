// Public browser configuration. Never put OAuth client secrets or GitHub tokens here.
// Connect an authentication backend after registering a GitHub App or OAuth App.
// authBaseUrl should be the HTTPS origin of the auth service, without a trailing slash.
// When empty, sign-in correctly reports "not configured"; local preview still works.
window.STUDIO_CONFIG = Object.freeze({
  authBaseUrl: ""
});
