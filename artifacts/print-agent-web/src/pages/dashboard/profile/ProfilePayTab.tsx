import { Card, CardContent } from "@/components/ui/card";
import { DollarSign } from "lucide-react";

interface ProfilePayTabProps {
  isOwner: boolean;
}

export function ProfilePayTab({ isOwner }: ProfilePayTabProps) {
  if (!isOwner) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-16 gap-4 text-center">
          <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
            <DollarSign size={24} className="text-muted-foreground" />
          </div>
          <div className="space-y-1">
            <h3 className="font-semibold text-base">Pay Info</h3>
            <p className="text-sm text-muted-foreground max-w-xs">
              Pay information is visible to workspace owners only.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center py-16 gap-4 text-center">
        <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
          <DollarSign size={24} className="text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <h3 className="font-semibold text-base">Pay Info coming soon</h3>
          <p className="text-sm text-muted-foreground max-w-xs">
            Pay information — including salary, payment method, and tax details — will be available here in a future update.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
