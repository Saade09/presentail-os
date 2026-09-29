# Google Play Submission — Owner Checklist

This document records what the owner needs to do to publish Presentail OS Mobile
on Google Play. The EAS Android build pipeline is already configured (see
`eas.json`). The steps below require a human with access to Google Play Console
and EAS credentials.

---

## Prerequisites (one-time setup)

### 0. Add google-services.json (Firebase config for Android push notifications)

The app uses `expo-notifications`, which on Android requires Google Firebase Cloud
Messaging (FCM). Without `google-services.json`, Android push notifications will
not work.

A placeholder with instructions is committed at
`artifacts/os-mobile/google-services.json.example`. The real file is gitignored.

Steps:
1. Go to [console.firebase.google.com](https://console.firebase.google.com) and
   sign in with the Presentail account.
2. Create a Firebase project (e.g. `presentail-os-mobile`) or use an existing one.
3. In **Project Settings → General → Your apps**, click **Add app → Android**.
   - Android package name: `com.presentail.osmobile`
   - App nickname: Presentail OS Mobile
4. Download the generated `google-services.json`.
5. Place it at `artifacts/os-mobile/google-services.json` (it is gitignored —
   never commit the real file).
6. Expo's build pipeline picks it up automatically during `eas build` for Android.

> **Note:** The `google-services.json` file is for the Firebase Android SDK config
> (push token registration). It is different from `google-services-account.json`,
> which is the Play Console service-account key for automated AAB submission.

### 1. Generate the Android upload keystore (EAS Credentials)

Run the following from `artifacts/os-mobile/` on a machine where you are logged
in to EAS (`eas whoami`):

```bash
cd artifacts/os-mobile
eas credentials --platform android
```

Choose **"Generate new keystore"** when prompted. EAS stores it securely in the
cloud and associates it with the `com.presentail.osmobile` app. **Record the key
alias and store alias** shown after generation — you will need them if you ever
need to manage the keystore manually.

> **Important:** Never lose the keystore. Google Play permanently ties the first
> uploaded key to the app — there is no recovery path if it is lost.

### 2. Create the app in Google Play Console

1. Go to [play.google.com/console](https://play.google.com/console) and sign in
   with the Presentail developer account.
2. Click **Create app**.
3. Fill in:
   - **App name**: Presentail OS Mobile
   - **Default language**: English (US)
   - **App or game**: App
   - **Free or paid**: Free
4. Accept the declarations and click **Create app**.
5. Note the **Package name**: `com.presentail.osmobile` (must match `eas.json`).

### 3. Add a Google service account for EAS automated submission (optional)

If you want `eas submit` to upload the AAB automatically (without manual upload):

1. In Play Console → Setup → API access, link to a Google Cloud project.
2. Create a service account with the **Release Manager** role.
3. Download the JSON key as `google-services-account.json` and place it in
   `artifacts/os-mobile/` (already gitignored).
4. The `eas.json` submit profile already points to this path.

---

## Build & Submit Workflow

### Push an OTA update (no new binary needed)

Delivers the latest JS bundle to all existing installs over the air:

```bash
cd artifacts/os-mobile
EAS_NO_VCS=1 eas update --branch production \
  --message "Auth, CMC mobile, password support"
```

### Trigger a new Android build

Produces a signed `.aab` (Android App Bundle) via EAS cloud build:

```bash
cd artifacts/os-mobile
EAS_NO_VCS=1 eas build \
  --platform android \
  --profile production \
  --non-interactive
```

The command prints a build URL. The build typically takes 10–20 minutes on EAS
servers. You do **not** need to stay connected — EAS builds run in the cloud.

### Submit the AAB to Google Play

After the build finishes, submit the latest build to the **Internal testing**
track:

```bash
cd artifacts/os-mobile
EAS_NO_VCS=1 eas submit \
  --platform android \
  --profile production \
  --latest \
  --non-interactive
```

This requires `google-services-account.json` (see Prerequisites §3) or you can
upload the AAB manually in Play Console (see below).

### Manual AAB upload (alternative to automated submit)

1. Download the `.aab` from the EAS build detail page.
2. In Play Console → your app → Testing → Internal testing → Create new release.
3. Upload the `.aab`.
4. Add release notes and click **Save & publish**.

---

## Promote to Production

Once internal testing is complete:

1. Play Console → Production → Create new release.
2. Promote the internal testing release or upload a new AAB.
3. Complete the store listing (description, screenshots, content rating, etc.).
4. Submit for Google review (typically 1–3 business days for new apps).

---

## iOS TestFlight (for reference)

The equivalent iOS flow:

```bash
cd artifacts/os-mobile
EAS_NO_VCS=1 eas build \
  --platform ios \
  --profile production \
  --non-interactive \
  --auto-submit
```

`--auto-submit` uploads to App Store Connect / TestFlight automatically when the
cloud build finishes (uses the submit profile in `eas.json`).

---

## Key identifiers

| Item | Value |
|------|-------|
| Android package name | `com.presentail.osmobile` |
| iOS bundle identifier | `com.presentail.osmobile` |
| EAS project ID | `0b397aef-d6de-490f-a6c5-65b790437d31` |
| App Store Connect app ID | `6787070693` |
| EAS owner | `saade01` |
