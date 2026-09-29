import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Key, Plus, Trash2, Copy, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { apiFetch, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { StaleDataBadge } from "@/components/StaleDataBadge";

const COPY_FEEDBACK_MS = 2000;

type ApiKey = {
  id: number;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
};

export default function ApiKeysPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["api-keys"],
    queryFn: () => apiFetch<{ keys: ApiKey[] }>("/api/api-keys"),
  });

  const createMutation = useMutation({
    mutationFn: (name: string) =>
      apiFetch<{ key: ApiKey; plaintext: string }>("/api/api-keys", {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
      setRevealedKey(data.plaintext);
      setIsCreateOpen(false);
      setNewName("");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/api-keys/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["api-keys"] }),
  });

  const keys = data?.keys ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t("apiKeys.title")}</h1>
          <p className="text-muted-foreground mt-2">
            {t("apiKeys.description")}
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <StaleDataBadge
            queries={[{ queryKey: ["api-keys"], url: "/api/api-keys" }]}
            data-testid="api-keys-stale-badge"
          />
          <Button
            onClick={() => setIsCreateOpen(true)}
            className="gap-2"
            data-testid="button-create-key"
          >
            <Plus size={16} /> {t("apiKeys.newKey")}
          </Button>
        </div>
      </div>

      {isLoading ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {t("common.loading")}
          </CardContent>
        </Card>
      ) : keys.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center space-y-3">
            <Key className="w-12 h-12 mx-auto text-muted-foreground" />
            <div>
              <p className="font-medium">{t("apiKeys.noKeysTitle")}</p>
              <p className="text-sm text-muted-foreground">
                {t("apiKeys.noKeysDesc")}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {keys.map((k) => (
            <Card key={k.id} data-testid={`api-key-${k.id}`}>
              <CardHeader>
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-md bg-secondary flex items-center justify-center shrink-0">
                      <Key size={18} />
                    </div>
                    <div className="min-w-0">
                      <CardTitle className="text-base truncate">
                        {k.name}
                      </CardTitle>
                      <CardDescription className="font-mono text-xs mt-1">
                        {k.key_prefix}…
                      </CardDescription>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-right hidden sm:block">
                      <div className="text-xs text-muted-foreground">
                        Created
                      </div>
                      <div className="text-sm">
                        {new Date(k.created_at).toLocaleDateString()}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (confirm(`Revoke "${k.name}"?`))
                          deleteMutation.mutate(k.id);
                      }}
                      data-testid={`button-delete-key-${k.id}`}
                    >
                      <Trash2 size={16} className="text-destructive" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
            <DialogDescription>
              Give your key a name so you can identify it later.
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder="e.g. Production server"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            data-testid="input-key-name"
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsCreateOpen(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={() =>
                createMutation.mutate(newName.trim() || "Untitled key")
              }
              disabled={createMutation.isPending}
              data-testid="button-confirm-create-key"
            >
              {createMutation.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reveal new key dialog */}
      <Dialog
        open={revealedKey !== null}
        onOpenChange={(open) => !open && setRevealedKey(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save your key</DialogTitle>
            <DialogDescription>
              This is the only time the full key will be shown. Copy it now and
              store it somewhere safe.
            </DialogDescription>
          </DialogHeader>
          <div className="bg-secondary border border-border rounded-md p-3 font-mono text-sm break-all">
            {revealedKey}
          </div>
          <DialogFooter>
            <Button
              onClick={() => {
                if (revealedKey) {
                  navigator.clipboard.writeText(revealedKey);
                  setCopied(true);
                  toast({ title: "Copied to clipboard" });
                  setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
                }
              }}
              className="gap-2"
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button variant="outline" onClick={() => setRevealedKey(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
