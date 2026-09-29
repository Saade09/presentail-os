import { useState, useRef } from "react";
import { apiFetch } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/hooks/use-toast";
import { ImageIcon, Sparkles, Send, RefreshCw, ExternalLink, Upload } from "lucide-react";

type GenerateResult = {
  imageUrl: string;
  productName: string;
  shortDescription: string;
  googlePostSummary: string;
  ctaActionType: string;
  ctaUrl: string;
};

type PublishResult = {
  postName: string;
  postId: string;
  state: string;
};

function stateBadgeVariant(state: string): "default" | "secondary" | "destructive" | "outline" {
  if (state === "LIVE") return "default";
  if (state === "REJECTED") return "destructive";
  return "secondary";
}

function stateColor(state: string): string {
  if (state === "LIVE") return "bg-green-100 text-green-800 border-green-200";
  if (state === "REJECTED") return "bg-red-100 text-red-800 border-red-200";
  return "bg-yellow-100 text-yellow-800 border-yellow-200";
}

export default function GoogleProductPostPage() {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [productName, setProductName] = useState("");
  const [productUrl, setProductUrl] = useState("");
  const [extraNotes, setExtraNotes] = useState("");

  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [generated, setGenerated] = useState<GenerateResult | null>(null);

  const [editedSummary, setEditedSummary] = useState("");

  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [published, setPublished] = useState<PublishResult | null>(null);

  const [checkingStatus, setCheckingStatus] = useState(false);
  const [postState, setPostState] = useState<string | null>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImageFile(file);
    setGenerated(null);
    setPublished(null);
    setPublishError(null);
    setGenerateError(null);
    const url = URL.createObjectURL(file);
    setImagePreviewUrl(url);
  }

  async function handleGenerate() {
    if (!imageFile) {
      toast({ title: "Please select an image first.", variant: "destructive" });
      return;
    }
    setGenerating(true);
    setGenerateError(null);
    setGenerated(null);
    setPublished(null);
    setPublishError(null);

    try {
      const formData = new FormData();
      formData.append("image", imageFile);
      if (productName.trim()) formData.append("productName", productName.trim());
      if (productUrl.trim()) formData.append("productUrl", productUrl.trim());
      if (extraNotes.trim()) formData.append("extraNotes", extraNotes.trim());

      const data = await apiFetch("/api/google-product-post/generate", {
        method: "POST",
        body: formData,
      });

      setGenerated(data as GenerateResult);
      setEditedSummary((data as GenerateResult).googlePostSummary);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to generate post.";
      setGenerateError(msg);
    } finally {
      setGenerating(false);
    }
  }

  async function handlePublish() {
    if (!generated) return;
    setPublishing(true);
    setPublishError(null);
    setPublished(null);

    try {
      const data = await apiFetch("/api/google-product-post/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          summary: editedSummary,
          imageUrl: generated.imageUrl,
          ctaUrl: generated.ctaUrl,
        }),
      });

      const result = data as PublishResult;
      setPublished(result);
      setPostState(result.state);
      toast({ title: "Post published to Google Business Profile!" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to publish post.";
      setPublishError(msg);
    } finally {
      setPublishing(false);
    }
  }

  async function handleCheckStatus() {
    if (!published?.postId) return;
    setCheckingStatus(true);
    try {
      const data = await apiFetch(`/api/google-product-post/status/${published.postId}`, {
        method: "GET",
      });
      const state = (data as { state: string }).state;
      setPostState(state);
      toast({ title: `Post status: ${state}` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to fetch status.";
      toast({ title: msg, variant: "destructive" });
    } finally {
      setCheckingStatus(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto py-8 px-4 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Google Business Profile Post</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Upload a product image, generate a post with AI, and publish it directly to Google Business Profile.
        </p>
      </div>

      {/* Step 1 — Upload & Context */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ImageIcon size={18} />
            Step 1 — Upload Image
          </CardTitle>
          <CardDescription>Upload a product photo (JPG, PNG, or WebP, max 5 MB).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            className="border-2 border-dashed border-border rounded-lg flex flex-col items-center justify-center gap-3 p-8 cursor-pointer hover:border-primary/60 transition-colors"
            onClick={() => fileInputRef.current?.click()}
          >
            {imagePreviewUrl ? (
              <img
                src={imagePreviewUrl}
                alt="Preview"
                className="max-h-48 rounded-md object-contain"
              />
            ) : (
              <>
                <Upload size={32} className="text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Click to select an image</span>
              </>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={handleFileChange}
          />

          <div className="grid grid-cols-1 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="productName">Product name (optional)</Label>
              <Input
                id="productName"
                placeholder="e.g. Rose Gold Bouquet"
                value={productName}
                onChange={(e) => setProductName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="productUrl">Product URL (optional)</Label>
              <Input
                id="productUrl"
                type="url"
                placeholder="https://..."
                value={productUrl}
                onChange={(e) => setProductUrl(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="extraNotes">Extra notes for AI (optional)</Label>
              <Input
                id="extraNotes"
                placeholder="e.g. perfect for Mother's Day, premium packaging"
                value={extraNotes}
                onChange={(e) => setExtraNotes(e.target.value)}
              />
            </div>
          </div>

          {generateError && (
            <p className="text-sm text-destructive rounded-md bg-destructive/10 px-3 py-2">
              {generateError}
            </p>
          )}

          <Button
            onClick={handleGenerate}
            disabled={!imageFile || generating}
            className="w-full gap-2"
          >
            {generating ? (
              <>
                <Spinner className="size-4" />
                Generating…
              </>
            ) : (
              <>
                <Sparkles size={16} />
                Generate Post
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Step 2 — Preview & Edit */}
      {generated && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles size={18} />
              Step 2 — Preview &amp; Edit
            </CardTitle>
            <CardDescription>Review the AI-generated content. Edit the post summary if needed.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-4 items-start">
              <img
                src={generated.imageUrl}
                alt={generated.productName}
                className="w-24 h-24 rounded-md object-cover shrink-0 border border-border"
              />
              <div className="space-y-1 min-w-0">
                <p className="font-semibold text-sm">{generated.productName}</p>
                <p className="text-sm text-muted-foreground">{generated.shortDescription}</p>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1">
                  <ExternalLink size={12} />
                  <a
                    href={generated.ctaUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="truncate underline underline-offset-2 hover:text-foreground transition-colors"
                  >
                    {generated.ctaUrl || "(no URL)"}
                  </a>
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="postSummary">
                Post summary{" "}
                <span className="text-muted-foreground font-normal">
                  ({editedSummary.length} chars)
                </span>
              </Label>
              <Textarea
                id="postSummary"
                rows={4}
                value={editedSummary}
                onChange={(e) => setEditedSummary(e.target.value)}
                className="resize-none"
              />
              <p className="text-xs text-muted-foreground">
                CTA: <strong>SHOP</strong> — {generated.ctaUrl || "(no URL)"}
              </p>
            </div>

            {publishError && (
              <p className="text-sm text-destructive rounded-md bg-destructive/10 px-3 py-2">
                {publishError}
              </p>
            )}

            <Button
              onClick={handlePublish}
              disabled={publishing || !editedSummary.trim() || !generated.ctaUrl}
              className="w-full gap-2"
            >
              {publishing ? (
                <>
                  <Spinner className="size-4" />
                  Publishing…
                </>
              ) : (
                <>
                  <Send size={16} />
                  Publish to Google Business Profile
                </>
              )}
            </Button>

            {!generated.ctaUrl && (
              <p className="text-xs text-muted-foreground text-center">
                A product URL is required to publish. Go back and add one.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Step 3 — Result */}
      {published && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Send size={18} />
              Step 3 — Published
            </CardTitle>
            <CardDescription>Your post was sent to Google Business Profile.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-muted-foreground">Status</span>
                <span
                  className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${stateColor(postState ?? published.state)}`}
                >
                  {postState ?? published.state}
                </span>
              </div>
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <span className="text-muted-foreground shrink-0">Post ID</span>
                <span className="font-mono text-xs break-all text-right">{published.postId}</span>
              </div>
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <span className="text-muted-foreground shrink-0">Resource name</span>
                <span className="font-mono text-xs break-all text-right">{published.postName}</span>
              </div>
            </div>

            <Button
              variant="outline"
              onClick={handleCheckStatus}
              disabled={checkingStatus}
              className="w-full gap-2"
            >
              {checkingStatus ? (
                <>
                  <Spinner className="size-4" />
                  Checking…
                </>
              ) : (
                <>
                  <RefreshCw size={16} />
                  Check Status
                </>
              )}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
