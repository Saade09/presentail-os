# Sign in with Apple release checklist

## Apple configuration

- Confirm the `com.presentail.osmobile` App ID has **Sign in with Apple** enabled in Apple Developer.
- Regenerate the iOS provisioning profile if Apple does not update it automatically.
- The API verifies tokens for audience `com.presentail.osmobile`. Production may set `APPLE_CLIENT_ID` to that same value explicitly.
- Confirm the deployed API uses that exact audience and successfully consumes a single-use nonce before issuing a session.
- Build and submit a new iOS binary after enabling the capability. No Android or website configuration is required.

## App Review note

> Presentail OS Mobile is an invitation-only workforce application. “Sign in with Apple” is available on the native iOS sign-in screen alongside Google, email/password, and email one-time-code authentication as the Guideline 4.8 equivalent option. It never creates a public account. Reviewers can use the invited review account credentials supplied in App Review Information. If Hide My Email is selected, the app asks the reviewer to enter the invited account email and verify the one-time code sent there, securely linking the stable Apple identity. Subsequent Apple sign-ins go directly to the same workspace.

## Reviewer test steps

1. Open the app, tap **Sign in**, then tap **Sign in with Apple**.
2. Complete Apple authorization. For a matching invited email, the workspace opens immediately.
3. If Apple private relay is selected, confirm the app shows **Verify your invited Presentail email** as an in-app continuation, not a red error.
4. Enter the invited review-account email, tap **Send me a code**, enter the six-digit code, and tap **Verify code**. The dashboard opens without repeating Apple authorization.
5. Sign out and repeat **Sign in with Apple**. The same Apple account must open the workspace directly, even when Apple does not return an email claim.

## Replacement-build smoke test

Run this on a clean production-style iPad/TestFlight install with the invited review account before submitting the replacement build:

- [ ] Apple authorization is available and the native button is visible on iPad.
- [ ] Matching-email path opens the dashboard after one Apple authorization.
- [ ] Hide My Email path shows the non-error invited-email step, sends the OTP, accepts the six-digit code, and opens the dashboard without restarting Apple authorization.
- [ ] Sign out, repeat Apple authorization, and confirm the stored Apple identity opens the same workspace without email.
- [ ] Cancel Apple authorization and confirm the screen is usable with no stuck spinner.
- [ ] Try an expired/invalid code or link and confirm an actionable message plus **Start over with Apple** is available.
- [ ] Confirm ordinary email OTP and password sign-in still work after abandoning the Apple-link step.

The API should return `APPLE_EMAIL_LINK_REQUIRED` only for the expected private-relay/unrecognized-email continuation. Invalid credentials, expired nonces, duplicate identities, unauthorized invited emails, and temporary service failures use separate bounded outcomes and must not be presented as a successful sign-in.