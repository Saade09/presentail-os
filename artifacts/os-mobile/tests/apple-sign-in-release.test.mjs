import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "app/(auth)/sign-in.tsx"), "utf8");
const authIndexSource = fs.readFileSync(path.join(root, "app/(auth)/index.tsx"), "utf8");
const authLayoutSource = fs.readFileSync(path.join(root, "app/(auth)/_layout.tsx"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const easPreInstall = fs.readFileSync(
  path.join(root, "scripts/eas-build-pre-install.sh"),
  "utf8",
);

test("production iOS config retains Apple capability, plugin, and native dependency", () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, "app.json"), "utf8")).expo;

  assert.equal(config.ios.usesAppleSignIn, true);
  assert.ok(config.plugins.includes("expo-apple-authentication"));
  assert.match(packageJson.dependencies["expo-apple-authentication"], /^~8\./);
});

test("iOS renders Apple's native button without availability-gating visibility", () => {
  assert.match(source, /\{IS_IOS && \(/);
  assert.match(source, /<AppleAuthentication\.AppleAuthenticationButton/);
  assert.match(source, /AppleAuthenticationButtonType\.CONTINUE/);
  assert.doesNotMatch(source, /appleAvailable\s*&&/);
});

test("signed-out startup reaches the native sign-in screen", () => {
  assert.match(
    authIndexSource,
    /<Redirect href="\/\(auth\)\/sign-in"/,
  );
  assert.match(authLayoutSource, /<Stack\.Screen name="sign-in"/);
});

test("Apple interaction uses the verified flow and reports unavailable support", () => {
  assert.match(source, /await AppleAuthentication\.isAvailableAsync\(\)/);
  assert.match(source, /Apple sign in is unavailable on this device/);
  assert.match(source, /await requestAppleChallenge\(\)/);
  assert.match(source, /await AppleAuthentication\.signInAsync/);
  assert.match(source, /await signInWithApple\(credential\.identityToken, nonce\)/);
  assert.match(source, /code !== "ERR_REQUEST_CANCELED"/);
});

test("private-relay Apple auth continues through an explicit email-link step", () => {
  assert.match(source, /requiresLink && result\.linkToken/);
  assert.match(source, /testID="apple-link-step"/);
  assert.match(source, /Verify your invited Presentail email/);
  assert.match(source, /setAppleLinkCodeSent\(Boolean\(appleLinkToken\)\)/);
  assert.match(source, /completeAppleLink\(appleLinkToken, email\.trim\(\), otp\.trim\(\)\)/);
  assert.match(source, /testID="apple-link-cancel"/);
  assert.match(source, /testID="apple-link-restart"/);
  assert.doesNotMatch(source, /setAppleError\("Enter your invited Presentail email/);
});

test("ordinary email methods can abandon an interrupted Apple link", () => {
  assert.match(source, /const clearAppleLink = \(\) =>/);
  assert.match(source, /const switchToPassword = \(\) => \{\s*clearAppleLink\(\)/);
  assert.match(source, /const switchToOtp = \(\) => \{\s*clearAppleLink\(\)/);
  assert.match(source, /if \(appleLinkToken\) \{\s*await completeAppleLink/);
  assert.match(source, /else \{\s*await verifyOtp/);
  assert.match(source, /Use regular email sign-in instead/);
});

test("EAS builds run the Apple release regression before installing", () => {
  assert.match(easPreInstall, /node --test tests\/apple-sign-in-release\.test\.mjs/);
});