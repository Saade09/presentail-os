import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  DashboardHandoffAttempts,
  isDashboardCompletionUrl,
  isDashboardReadyMessage,
  isTopFrameNavigation,
} from "../lib/dashboardHandoffAttempts";

test("a retry supersedes the initial failed attempt", () => {
  const attempts = new DashboardHandoffAttempts();
  const initial = attempts.begin();
  const retry = attempts.begin();

  assert.equal(attempts.isCurrent(initial), false);
  assert.equal(attempts.isCurrent(retry), true);
});

test("only the newest overlapping request may complete", async () => {
  const attempts = new DashboardHandoffAttempts();
  const first = attempts.begin();
  const second = attempts.begin();
  const updates: string[] = [];

  await Promise.all([
    delay(10).then(() => {
      if (attempts.isCurrent(first)) updates.push("stale");
    }),
    delay(1).then(() => {
      if (attempts.isCurrent(second)) updates.push("fresh");
    }),
  ]);

  assert.deepEqual(updates, ["fresh"]);
});

test("WebView timeout is bounded and canceled after success", async () => {
  const attempts = new DashboardHandoffAttempts();
  const timedOut = attempts.begin();
  let failures = 0;
  attempts.scheduleTimeout(timedOut, 5, () => failures++);
  await delay(15);
  assert.equal(failures, 1);

  const succeeded = attempts.begin();
  attempts.scheduleTimeout(succeeded, 5, () => failures++);
  attempts.clearTimeout();
  await delay(15);
  assert.equal(failures, 1);
});

test("unmount invalidates callbacks and clears timers", async () => {
  const attempts = new DashboardHandoffAttempts();
  const active = attempts.begin();
  let updated = false;
  attempts.scheduleTimeout(active, 5, () => {
    updated = true;
  });
  attempts.dispose();
  await delay(15);

  assert.equal(attempts.isCurrent(active), false);
  assert.equal(updated, false);
});

test("iframe navigations cannot replace the tracked main-frame URL", () => {
  assert.equal(isTopFrameNavigation({ isTopFrame: true }), true);
  assert.equal(isTopFrameNavigation({}), true);
  assert.equal(isTopFrameNavigation({ isTopFrame: false }), false);
});

test("only the explicit authenticated dashboard message completes the handoff", () => {
  assert.equal(
    isDashboardReadyMessage(
      JSON.stringify({ type: "presentail.dashboard.ready" }),
    ),
    true,
  );
  assert.equal(
    isDashboardReadyMessage(
      JSON.stringify({ type: "presentail.dashboard.loading" }),
    ),
    false,
  );
  assert.equal(isDashboardReadyMessage("presentail.dashboard.ready"), false);
  assert.equal(isDashboardReadyMessage("{"), false);
});

test("same-origin dashboard navigation provides a safe completion fallback", () => {
  const bootstrap =
    "https://os.presentail.com/sign-in?__clerk_ticket=fresh&mobile_handoff=1";

  assert.equal(
    isDashboardCompletionUrl("https://os.presentail.com/", bootstrap),
    true,
  );
  assert.equal(
    isDashboardCompletionUrl("https://os.presentail.com/orders", bootstrap),
    true,
  );
  assert.equal(
    isDashboardCompletionUrl("https://os.presentail.com/sign-in", bootstrap),
    false,
  );
  assert.equal(
    isDashboardCompletionUrl(
      "https://os.presentail.com/sign-in?mobile_handoff_error=1",
      bootstrap,
    ),
    false,
  );
  assert.equal(
    isDashboardCompletionUrl("https://clerk.presentail.com/v1/oauth_callback", bootstrap),
    false,
  );
  assert.equal(
    isDashboardCompletionUrl("https://accounts.google.com/oauth", bootstrap),
    false,
  );
});
