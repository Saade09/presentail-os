export class DashboardHandoffAttempts {
  private currentId = 0;
  private timeout: ReturnType<typeof setTimeout> | null = null;

  begin(): number {
    this.clearTimeout();
    this.currentId += 1;
    return this.currentId;
  }

  isCurrent(id: number): boolean {
    return id === this.currentId;
  }

  scheduleTimeout(id: number, delayMs: number, onTimeout: () => void): void {
    this.clearTimeout();
    this.timeout = setTimeout(() => {
      this.timeout = null;
      if (this.isCurrent(id)) onTimeout();
    }, delayMs);
  }

  clearTimeout(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  dispose(): void {
    this.begin();
  }
}

export function isTopFrameNavigation(request: { isTopFrame?: boolean }): boolean {
  return request.isTopFrame !== false;
}

export function isDashboardReadyMessage(data: string): boolean {
  try {
    const parsed = JSON.parse(data) as { type?: unknown };
    return parsed.type === "presentail.dashboard.ready";
  } catch {
    return false;
  }
}

export function isDashboardCompletionUrl(
  currentUrl: string,
  bootstrapUrl: string,
): boolean {
  try {
    const current = new URL(currentUrl);
    const bootstrap = new URL(bootstrapUrl);
    if (current.protocol !== "https:" || current.origin !== bootstrap.origin) {
      return false;
    }

    const path = current.pathname.replace(/\/+$/, "") || "/";
    if (path === "/sign-in" || path.startsWith("/sign-in/")) {
      return false;
    }

    return (
      !current.searchParams.has("__clerk_ticket") &&
      current.searchParams.get("mobile_handoff") !== "1" &&
      current.searchParams.get("mobile_handoff_error") !== "1"
    );
  } catch {
    return false;
  }
}
