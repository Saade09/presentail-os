import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getOmnichannelSavedReplies,
  listOmniKnowledgeBase,
  createOmniKnowledgeBaseArticle,
  updateOmniKnowledgeBaseArticle,
  deleteOmniKnowledgeBaseArticle,
} from "@workspace/api-client-react";
import type {
  OmniKnowledgeBaseArticle,
  OmniKnowledgeBaseArticleInput,
  OmniKnowledgeBaseArticleUpdateInput,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Trash2, Plus, Pencil, Search, BookOpen, MessageSquare } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// ---------------------------------------------------------------------------
// Variable token preview helper
// ---------------------------------------------------------------------------

const VARIABLE_TOKENS = [
  { token: "{{contact_name}}", label: "Contact name" },
  { token: "{{contact_phone}}", label: "Contact phone" },
  { token: "{{agent_name}}", label: "Agent name" },
  { token: "{{conversation_id}}", label: "Conversation ID" },
];

function previewContent(content: string): string {
  return content
    .replace(/\{\{contact_name\}\}/g, "John Doe")
    .replace(/\{\{contact_phone\}\}/g, "+1 555-0100")
    .replace(/\{\{agent_name\}\}/g, "Sarah")
    .replace(/\{\{conversation_id\}\}/g, "#1234");
}

// ---------------------------------------------------------------------------
// Saved Replies tab
// ---------------------------------------------------------------------------

function SavedRepliesTab() {
  const [search, setSearch] = useState("");
  const [previewId, setPreviewId] = useState<number | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["omni-saved-replies", search],
    queryFn: () => getOmnichannelSavedReplies({ q: search || undefined }),
  });

  const replies = data?.saved_replies ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 flex-1 max-w-sm">
          <Search className="h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search saved replies…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <p className="text-sm text-muted-foreground">
          {replies.length} saved {replies.length === 1 ? "reply" : "replies"}
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground py-8 text-center">Loading…</p>
      ) : replies.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground space-y-2">
          <MessageSquare className="h-8 w-8 mx-auto opacity-40" />
          <p className="text-sm">No saved replies yet.</p>
          <p className="text-xs">Saved replies are created by agents from the inbox composer.</p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-32">Shortcut</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Content preview</TableHead>
              <TableHead className="w-24">Scope</TableHead>
              <TableHead className="w-24">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {replies.map((reply) => (
              <TableRow key={reply.id}>
                <TableCell>
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded">/{reply.shortcut}</code>
                </TableCell>
                <TableCell className="font-medium text-sm">{reply.title}</TableCell>
                <TableCell className="text-sm text-muted-foreground max-w-xs truncate">
                  {previewId === reply.id
                    ? previewContent(reply.content)
                    : reply.content.slice(0, 100)}
                  {reply.content.length > 100 && previewId !== reply.id ? "…" : ""}
                </TableCell>
                <TableCell>
                  <Badge variant={reply.is_global ? "secondary" : "outline"} className="text-xs">
                    {reply.is_global ? "Global" : "Personal"}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPreviewId(previewId === reply.id ? null : reply.id)}
                  >
                    {previewId === reply.id ? "Raw" : "Preview"}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {/* Variable tokens reference */}
      <div className="border rounded-lg p-4 bg-muted/30 mt-4">
        <p className="text-xs font-medium text-muted-foreground mb-2">Available variable tokens</p>
        <div className="flex flex-wrap gap-3">
          {VARIABLE_TOKENS.map((v) => (
            <div key={v.token} className="flex items-center gap-1.5">
              <code className="text-xs bg-background border px-1.5 py-0.5 rounded">{v.token}</code>
              <span className="text-xs text-muted-foreground">{v.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Knowledge Base tab
// ---------------------------------------------------------------------------

type ArticleFormState = {
  title: string;
  content: string;
  category: string;
  tags: string;
  is_published: boolean;
};

const EMPTY_FORM: ArticleFormState = {
  title: "",
  content: "",
  category: "",
  tags: "",
  is_published: true,
};

function KnowledgeBaseTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingArticle, setEditingArticle] = useState<OmniKnowledgeBaseArticle | null>(null);
  const [form, setForm] = useState<ArticleFormState>(EMPTY_FORM);
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["omni-knowledge-base", search],
    queryFn: () => listOmniKnowledgeBase({ q: search || undefined }),
  });

  const articles: OmniKnowledgeBaseArticle[] = (data?.articles ?? []) as OmniKnowledgeBaseArticle[];

  const createMutation = useMutation({
    mutationFn: (input: OmniKnowledgeBaseArticleInput) =>
      createOmniKnowledgeBaseArticle(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["omni-knowledge-base"] });
      toast({ title: "Article created" });
      setDialogOpen(false);
      setForm(EMPTY_FORM);
    },
    onError: () => toast({ title: "Failed to create article", variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, input }: { id: number; input: OmniKnowledgeBaseArticleUpdateInput }) =>
      updateOmniKnowledgeBaseArticle(id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["omni-knowledge-base"] });
      toast({ title: "Article updated" });
      setDialogOpen(false);
      setEditingArticle(null);
      setForm(EMPTY_FORM);
    },
    onError: () => toast({ title: "Failed to update article", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteOmniKnowledgeBaseArticle(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["omni-knowledge-base"] });
      toast({ title: "Article deleted" });
      setDeleteConfirm(null);
    },
    onError: () => toast({ title: "Failed to delete article", variant: "destructive" }),
  });

  function openCreate() {
    setEditingArticle(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }

  function openEdit(article: OmniKnowledgeBaseArticle) {
    setEditingArticle(article);
    const rawTags = article.tags;
    const tagsStr = Array.isArray(rawTags) ? (rawTags as string[]).join(", ") : "";
    setForm({
      title: article.title,
      content: article.content,
      category: article.category ?? "",
      tags: tagsStr,
      is_published: article.is_published,
    });
    setDialogOpen(true);
  }

  function buildInput(f: ArticleFormState): OmniKnowledgeBaseArticleInput {
    const tags = f.tags ? f.tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
    return {
      title: f.title,
      content: f.content,
      category: f.category || undefined,
      tags: tags ?? undefined,
      is_published: f.is_published,
    };
  }

  function handleSave() {
    if (!form.title.trim() || !form.content.trim()) {
      toast({ title: "Title and content are required", variant: "destructive" });
      return;
    }
    if (editingArticle) {
      updateMutation.mutate({ id: editingArticle.id, input: buildInput(form) });
    } else {
      createMutation.mutate(buildInput(form));
    }
  }

  const isSaving = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 flex-1 max-w-sm">
          <Search className="h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search articles…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button size="sm" onClick={openCreate}>
          <Plus className="h-4 w-4 mr-1.5" />
          New article
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground py-8 text-center">Loading…</p>
      ) : articles.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground space-y-2">
          <BookOpen className="h-8 w-8 mx-auto opacity-40" />
          <p className="text-sm">No knowledge base articles yet.</p>
          <p className="text-xs">Articles are used by the AI to draft contextual replies.</p>
          <Button size="sm" variant="outline" onClick={openCreate} className="mt-2">
            <Plus className="h-4 w-4 mr-1.5" />
            Create first article
          </Button>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead className="w-32">Category</TableHead>
              <TableHead className="w-24">Status</TableHead>
              <TableHead className="w-32">Updated</TableHead>
              <TableHead className="w-20">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {articles.map((article) => (
              <TableRow key={article.id}>
                <TableCell>
                  <div>
                    <p className="font-medium text-sm">{article.title}</p>
                    <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
                      {article.content.slice(0, 120)}
                      {article.content.length > 120 ? "…" : ""}
                    </p>
                  </div>
                </TableCell>
                <TableCell>
                  {article.category ? (
                    <Badge variant="outline" className="text-xs">
                      {article.category}
                    </Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <Badge
                    variant={article.is_published ? "default" : "secondary"}
                    className="text-xs"
                  >
                    {article.is_published ? "Published" : "Draft"}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {new Date(article.updated_at).toLocaleDateString()}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => openEdit(article)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
                      onClick={() => setDeleteConfirm(article.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {/* Create / Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editingArticle ? "Edit article" : "New knowledge base article"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label htmlFor="kb-title">Title</Label>
              <Input
                id="kb-title"
                placeholder="e.g. Refund policy"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              />
            </div>
            <div>
              <Label htmlFor="kb-content">Content</Label>
              <Textarea
                id="kb-content"
                placeholder="Write the article content here. The AI will use this when drafting replies."
                value={form.content}
                onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
                rows={8}
                className="resize-y"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="kb-category">Category (optional)</Label>
                <Input
                  id="kb-category"
                  placeholder="e.g. Payments, Shipping"
                  value={form.category}
                  onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                />
              </div>
              <div>
                <Label htmlFor="kb-tags">Tags (comma-separated, optional)</Label>
                <Input
                  id="kb-tags"
                  placeholder="e.g. refund, policy"
                  value={form.tags}
                  onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))}
                />
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Switch
                id="kb-published"
                checked={form.is_published}
                onCheckedChange={(checked) => setForm((f) => ({ ...f, is_published: checked }))}
              />
              <Label htmlFor="kb-published" className="font-normal">
                Published — AI will use this article when drafting replies
              </Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving ? "Saving…" : editingArticle ? "Save changes" : "Create article"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog open={deleteConfirm !== null} onOpenChange={() => setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete article?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This article will be permanently removed from the knowledge base.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteConfirm !== null && deleteMutation.mutate(deleteConfirm)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WhatsApp Templates tab (read-only placeholder; real sync requires Phase 7)
// ---------------------------------------------------------------------------

const MOCK_WA_TEMPLATES = [
  {
    name: "welcome_message",
    category: "UTILITY",
    status: "APPROVED",
    language: "en",
    body: "Hello {{1}}, welcome to our service! How can we help you today?",
  },
  {
    name: "order_confirmation",
    category: "TRANSACTIONAL",
    status: "APPROVED",
    language: "en",
    body: "Hi {{1}}, your order #{{2}} has been confirmed. Expected delivery: {{3}}.",
  },
  {
    name: "shipping_update",
    category: "TRANSACTIONAL",
    status: "PENDING",
    language: "en",
    body: "Good news {{1}}, your order is on its way! Track it here: {{2}}",
  },
];

const STATUS_VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  APPROVED: "default",
  PENDING: "secondary",
  REJECTED: "destructive",
};

function WhatsAppTemplatesTab() {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-amber-50 border-amber-200 p-4 text-sm text-amber-800">
        <strong>Note:</strong> Real-time WhatsApp template approval sync requires the WhatsApp
        provider adapter (coming in the next release). The templates shown here are placeholders.
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Template name</TableHead>
            <TableHead className="w-36">Category</TableHead>
            <TableHead className="w-24">Status</TableHead>
            <TableHead className="w-20">Language</TableHead>
            <TableHead>Body (with variable placeholders)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {MOCK_WA_TEMPLATES.map((tpl) => (
            <TableRow key={tpl.name}>
              <TableCell>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{tpl.name}</code>
              </TableCell>
              <TableCell>
                <Badge variant="outline" className="text-xs">
                  {tpl.category}
                </Badge>
              </TableCell>
              <TableCell>
                <Badge variant={STATUS_VARIANTS[tpl.status] ?? "secondary"} className="text-xs">
                  {tpl.status}
                </Badge>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">{tpl.language}</TableCell>
              <TableCell className="text-sm text-muted-foreground">{tpl.body}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main TemplatesPage
// ---------------------------------------------------------------------------

export default function TemplatesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Templates</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Manage saved replies, knowledge base articles, and WhatsApp templates.
        </p>
      </div>

      <Tabs defaultValue="saved-replies">
        <TabsList>
          <TabsTrigger value="saved-replies">
            <MessageSquare className="h-4 w-4 mr-1.5" />
            Saved Replies
          </TabsTrigger>
          <TabsTrigger value="knowledge-base">
            <BookOpen className="h-4 w-4 mr-1.5" />
            Knowledge Base
          </TabsTrigger>
          <TabsTrigger value="whatsapp-templates">WhatsApp Templates</TabsTrigger>
        </TabsList>

        <TabsContent value="saved-replies" className="mt-4">
          <SavedRepliesTab />
        </TabsContent>

        <TabsContent value="knowledge-base" className="mt-4">
          <KnowledgeBaseTab />
        </TabsContent>

        <TabsContent value="whatsapp-templates" className="mt-4">
          <WhatsAppTemplatesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
