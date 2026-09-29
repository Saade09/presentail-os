import "@testing-library/jest-dom";
import "@/i18n";

// Suppress known-harmless console.error patterns produced by jsdom and React
// during tests.  We filter only the specific messages below; anything else
// remains visible so genuine errors are never silenced.
const _consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  const msg = typeof args[0] === "string" ? args[0] : "";
  if (
    // jsdom stubs that have no effect in tests
    msg.includes("Not implemented") ||
    // React DOM invalid-nesting warning produced by the Select mock in
    // Settings.language.test.tsx (SelectTrigger previously rendered a <button>
    // inside the mocked <select>)
    msg.includes("In HTML") ||
    // React act() warnings for async state updates that are known-benign in
    // the affected test suites (Brands 409 tests, Settings language tests)
    msg.includes("not wrapped in act") ||
    // React warning when IS_REACT_ACT_ENVIRONMENT is not set – covered by the
    // globalThis flag above but kept here as a belt-and-suspenders guard
    msg.includes("not configured to support act")
  ) {
    return;
  }
  _consoleError(...args);
};

window.HTMLElement.prototype.hasPointerCapture = () => false;
window.HTMLElement.prototype.setPointerCapture = () => {};
window.HTMLElement.prototype.releasePointerCapture = () => {};
window.HTMLElement.prototype.scrollIntoView = () => {};

// Suppress "Not implemented: navigation to another Document" jsdom warnings.
//
// jsdom emits this to process.stderr (bypassing console.error) whenever any
// anchor click or window.location assignment attempts cross-document navigation.
// In tests this noise comes from:
//   • programmatic download anchors: production code does anchor.click() to
//     trigger a file save, which jsdom cannot perform;
//   • Link mocks that render <a href="..."> — clicking them for React-handler
//     tests also causes jsdom's navigation activation behavior to run.
//
// We filter only this specific message so genuine jsdom errors are still visible.
const _stderrWrite = process.stderr.write.bind(process.stderr);
(process.stderr as NodeJS.WriteStream).write = function (
  chunk: Parameters<typeof process.stderr.write>[0],
  ...rest: Parameters<typeof process.stderr.write>[1][]
): boolean {
  if (
    typeof chunk === "string" &&
    chunk.includes("Not implemented: navigation to another Document")
  ) {
    const cb = rest.find((a) => typeof a === "function") as
      | ((err?: Error | null) => void)
      | undefined;
    cb?.();
    return true;
  }
  return _stderrWrite(chunk, ...(rest as Parameters<typeof _stderrWrite>[1][]));
} as typeof process.stderr.write;

if (typeof window.EventSource === "undefined") {
  (window as unknown as Record<string, unknown>).EventSource = class EventSource {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readyState = 0;
    url = "";
    withCredentials = false;
    onopen: ((ev: Event) => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    constructor(_url: string) {}
    addEventListener() {}
    removeEventListener() {}
    dispatchEvent() { return true; }
    close() {}
  };
}

if (typeof window.ResizeObserver === "undefined") {
  window.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
