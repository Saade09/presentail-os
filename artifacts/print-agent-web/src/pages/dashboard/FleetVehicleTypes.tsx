import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { apiFetch, queryClient } from "@/lib/queryClient";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type VehicleType = {
  id: number;
  name: string;
  is_active: boolean;
  sort_order: number;
};

export default function FleetVehicleTypesPage() {
  const { realIsOwner } = useWorkspaceRole();
  const { toast } = useToast();
  const [newName, setNewName] = useState("");

  const { data, isLoading } = useQuery<{ vehicle_types: VehicleType[] }>({
    queryKey: ["fleet-vehicle-types"],
    queryFn: () => apiFetch("/api/fleet/vehicle-types"),
  });

  const createMutation = useMutation({
    mutationFn: (name: string) =>
      apiFetch("/api/fleet/vehicle-types", {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      setNewName("");
      queryClient.invalidateQueries({ queryKey: ["fleet-vehicle-types"] });
      toast({ title: "Vehicle type added" });
    },
    onError: (err: Error) =>
      toast({ title: err.message || "Failed to add vehicle type", variant: "destructive" }),
  });

  const toggleActive = useMutation({
    mutationFn: ({ id, is_active }: { id: number; is_active: boolean }) =>
      apiFetch(`/api/fleet/vehicle-types/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_active }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["fleet-vehicle-types"] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/fleet/vehicle-types/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["fleet-vehicle-types"] });
      toast({ title: "Vehicle type removed" });
    },
  });

  const types = data?.vehicle_types ?? [];

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-3">
        <Link to="/fleet">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="size-4 mr-1.5" />
            Back to Fleet
          </Button>
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Vehicle Types</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Manage the controlled list of vehicle types used when registering drivers.
        </p>
      </div>

      {realIsOwner && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Add a vehicle type</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="flex gap-2 items-end"
              onSubmit={(e) => {
                e.preventDefault();
                const v = newName.trim();
                if (!v) return;
                createMutation.mutate(v);
              }}
            >
              <div className="flex-1">
                <Label htmlFor="vt-name">Name</Label>
                <Input
                  id="vt-name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. Refrigerated Van"
                />
              </div>
              <Button type="submit" disabled={!newName.trim() || createMutation.isPending}>
                <Plus className="size-4 mr-1.5" />
                Add
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      <div className="rounded-md border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/50 border-b">
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Name</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
              {realIsOwner && (
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Actions</th>
              )}
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={3} className="text-center text-muted-foreground py-8">
                  Loading…
                </td>
              </tr>
            )}
            {!isLoading && types.length === 0 && (
              <tr>
                <td colSpan={3} className="text-center text-muted-foreground py-8">
                  No vehicle types yet.
                </td>
              </tr>
            )}
            {types.map((t) => (
              <tr key={t.id} className="border-b last:border-0">
                <td className="px-4 py-3 font-medium">{t.name}</td>
                <td className="px-4 py-3">
                  <Badge variant={t.is_active ? "default" : "outline"}>
                    {t.is_active ? "Active" : "Inactive"}
                  </Badge>
                </td>
                {realIsOwner && (
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          toggleActive.mutate({ id: t.id, is_active: !t.is_active })
                        }
                      >
                        {t.is_active ? "Deactivate" : "Activate"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={() => deleteMutation.mutate(t.id)}
                        disabled={deleteMutation.isPending}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
