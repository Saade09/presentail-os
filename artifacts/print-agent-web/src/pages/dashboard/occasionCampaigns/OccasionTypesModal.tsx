import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Edit2, Trash2, Check, X } from "lucide-react";
import { apiFetch } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { type OccasionType } from "../OccasionCampaignCalendarPage";

const PRESET_COLORS = [
  "#ef4444", "#f97316", "#f59e0b", "#10b981",
  "#3b82f6", "#8b5cf6", "#ec4899", "#6b7280",
];

export function OccasionTypesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("#6366f1");
  const [editDesc, setEditDesc] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("#6366f1");
  const [newDesc, setNewDesc] = useState("");

  const typesQuery = useQuery({
    queryKey: ["/api/occasion-campaigns/types"],
    queryFn: () => apiFetch<{ types: OccasionType[] }>("/api/occasion-campaigns/types"),
    enabled: open,
  });
  const types = typesQuery.data?.types ?? [];

  const createMutation = useMutation({
    mutationFn: (data: object) =>
      apiFetch("/api/occasion-campaigns/types", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/occasion-campaigns/types"] });
      toast({ title: "Type created" });
      setCreating(false);
      setNewName(""); setNewColor("#6366f1"); setNewDesc("");
    },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...data }: { id: number; name?: string; color?: string; description?: string | null }) =>
      apiFetch(`/api/occasion-campaigns/types/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/occasion-campaigns/types"] });
      toast({ title: "Type updated" });
      setEditingId(null);
    },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/occasion-campaigns/types/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/occasion-campaigns/types"] });
      toast({ title: "Type deleted" });
    },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  function startEdit(t: OccasionType) {
    setEditingId(t.id);
    setEditName(t.name);
    setEditColor(t.color);
    setEditDesc(t.description ?? "");
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Manage occasion types</DialogTitle>
          <DialogDescription>Create and edit custom occasion types for your workspace.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 mt-2">
          {types.map((t) => (
            <div key={t.id} className="border border-border rounded-lg p-3">
              {editingId === t.id ? (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <Input value={editName} onChange={(e) => setEditName(e.target.value)}
                      placeholder="Type name" className="h-8 text-sm flex-1" autoFocus />
                    <input type="color" value={editColor} onChange={(e) => setEditColor(e.target.value)}
                      className="h-8 w-10 rounded border border-border cursor-pointer" />
                  </div>
                  <div className="flex gap-1 flex-wrap">
                    {PRESET_COLORS.map((c) => (
                      <button key={c} type="button"
                        onClick={() => setEditColor(c)}
                        className="w-5 h-5 rounded-full border-2 transition-all"
                        style={{ backgroundColor: c, borderColor: editColor === c ? "#000" : "transparent" }}
                      />
                    ))}
                  </div>
                  <Input value={editDesc} onChange={(e) => setEditDesc(e.target.value)}
                    placeholder="Description (optional)" className="h-8 text-sm" />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => updateMutation.mutate({ id: t.id, name: editName, color: editColor, description: editDesc || null })}
                      disabled={!editName.trim() || updateMutation.isPending}>
                      <Check size={13} className="mr-1" /> Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                      <X size={13} className="mr-1" /> Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: t.color }} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{t.name}</p>
                    {t.description && <p className="text-xs text-muted-foreground truncate">{t.description}</p>}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => startEdit(t)}>
                      <Edit2 size={12} />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive"
                      onClick={() => deleteMutation.mutate(t.id)} disabled={deleteMutation.isPending}>
                      <Trash2 size={12} />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))}

          {creating ? (
            <div className="border border-border rounded-lg p-3 space-y-2">
              <div className="flex gap-2">
                <Input value={newName} onChange={(e) => setNewName(e.target.value)}
                  placeholder="Type name" className="h-8 text-sm flex-1" autoFocus />
                <input type="color" value={newColor} onChange={(e) => setNewColor(e.target.value)}
                  className="h-8 w-10 rounded border border-border cursor-pointer" />
              </div>
              <div className="flex gap-1 flex-wrap">
                {PRESET_COLORS.map((c) => (
                  <button key={c} type="button"
                    onClick={() => setNewColor(c)}
                    className="w-5 h-5 rounded-full border-2 transition-all"
                    style={{ backgroundColor: c, borderColor: newColor === c ? "#000" : "transparent" }}
                  />
                ))}
              </div>
              <Input value={newDesc} onChange={(e) => setNewDesc(e.target.value)}
                placeholder="Description (optional)" className="h-8 text-sm" />
              <div className="flex gap-2">
                <Button size="sm" onClick={() => createMutation.mutate({ name: newName, color: newColor, description: newDesc || null })}
                  disabled={!newName.trim() || createMutation.isPending}>
                  {createMutation.isPending ? "Creating…" : "Create"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setCreating(false); setNewName(""); }}>Cancel</Button>
              </div>
            </div>
          ) : (
            <Button variant="outline" size="sm" className="w-full" onClick={() => setCreating(true)}>
              <Plus size={13} className="mr-1.5" /> Add occasion type
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
