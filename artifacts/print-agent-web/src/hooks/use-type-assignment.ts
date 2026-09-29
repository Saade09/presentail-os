import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/queryClient";

const TYPE_ASSIGNMENT_TIMEOUT_MS = 15_000;

export type TypeAssignmentStatus =
  | "auth-loading"
  | "ready"
  | "assigning"
  | "error";

export type TypeAssignmentState = {
  status: TypeAssignmentStatus;
  error: string | null;
};

type ReloadedUser = {
  publicMetadata?: {
    userType?: unknown;
  } | null;
} | null;

type UseTypeAssignmentOptions = {
  isLoaded: boolean;
  userId: string | null;
  userType: string | null;
  reload: (() => Promise<ReloadedUser>) | null;
};

function readUserType(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "Could not verify your account type. Please reload the page.";
}

/**
 * Assigns the app-level user type once for users whose Clerk metadata does not
 * have one yet.
 *
 * The effect intentionally depends on stable primitives, not the Clerk user
 * object. Clerk may replace that object while reload() is completing. A
 * generation check makes an older async attempt unable to overwrite the
 * result of a newer effect, while every current attempt has an explicit
 * success, timeout, or error state.
 */
export function useTypeAssignment({
  isLoaded,
  userId,
  userType,
  reload,
}: UseTypeAssignmentOptions): TypeAssignmentState {
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  const [state, setState] = useState<TypeAssignmentState>({
    status: isLoaded ? (userType ? "ready" : "assigning") : "auth-loading",
    error: null,
  });
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    let disposed = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const isCurrent = () =>
      !disposed && generationRef.current === generation;
    const finish = (next: TypeAssignmentState) => {
      if (isCurrent()) setState(next);
    };

    if (!isLoaded) {
      finish({ status: "auth-loading", error: null });
      return () => {
        disposed = true;
      };
    }

    if (!userId || userType) {
      finish({ status: "ready", error: null });
      return () => {
        disposed = true;
      };
    }

    finish({ status: "assigning", error: null });

    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(
          new Error("Account setup timed out. Please reload the page."),
        );
      }, TYPE_ASSIGNMENT_TIMEOUT_MS);
    });

    const assignAndReload = async () => {
      await apiFetch("/api/auth/set-user-type", {
        method: "POST",
        timeoutMs: TYPE_ASSIGNMENT_TIMEOUT_MS,
      });

      const refreshedUser = await reloadRef.current?.();
      const refreshedType = readUserType(
        refreshedUser?.publicMetadata?.userType,
      );
      if (!refreshedType) {
        throw new Error(
          "Account type was assigned, but the updated session was not available. Please reload the page.",
        );
      }
    };

    void Promise.race([assignAndReload(), timeout])
      .then(() => finish({ status: "ready", error: null }))
      .catch((error) =>
        finish({ status: "error", error: errorMessage(error) }),
      )
      .finally(() => {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      });

    return () => {
      disposed = true;
    };
  }, [isLoaded, userId, userType]);

  return state;
}
