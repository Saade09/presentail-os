import { useClerk } from "@clerk/react";
import { Button } from "@/components/ui/button";

export default function UnauthorizedPage() {
  const { signOut } = useClerk();

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <div className="max-w-md w-full text-center space-y-6">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Access Denied
          </h1>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Your account does not have access to Presentail OS. This application
            is only available to team members. If you believe this is a mistake,
            please contact your administrator.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => signOut({ redirectUrl: "/" })}
        >
          Sign out
        </Button>
      </div>
    </div>
  );
}
