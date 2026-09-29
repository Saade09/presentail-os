type ApiStartupError = Error & {
  status?: number;
  code?: string;
};

export function retryDashboardStartup(
  failureCount: number,
  error: unknown,
): boolean {
  const startupError = error as ApiStartupError | null;
  return (
    failureCount < 3
    && startupError?.status === 503
    && startupError.code === "startup_in_progress"
  );
}

export function dashboardStartupRetryDelay(attemptIndex: number): number {
  return Math.min(1_000 * (2 ** attemptIndex), 5_000);
}