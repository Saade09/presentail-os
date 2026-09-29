import { useState, useEffect } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { AttributeImageUpload } from "./AttributeImageUpload";
import type { AttributeHooksConfig } from "./attributeHooks";
import type { CatalogAttribute } from "@workspace/api-client-react";

type AttributeFormSheetProps = {
  hooksConfig: AttributeHooksConfig;
  typeSingular: string;
  attributeType?: string;
  item?: CatalogAttribute | null;
  onClose: () => void;
};

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/['']/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

export function AttributeFormSheet({ hooksConfig, typeSingular, attributeType, item, onClose }: AttributeFormSheetProps) {
  const { toast } = useToast();
  const isEdit = !!item;
  const isBrand = attributeType === "brand";
  const isCategory = attributeType === "category";

  const [name, setName] = useState(item?.name ?? "");
  const [slug, setSlug] = useState(item?.slug ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [imageUrl, setImageUrl] = useState<string | null>(item?.image_url ?? null);
  const [bannerImageUrl, setBannerImageUrl] = useState<string | null>(
    isBrand ? ((item as any)?.banner_image_url ?? null) : null,
  );
  const [sortOrder, setSortOrder] = useState(String(item?.sort_order ?? 0));
  const [isActive, setIsActive] = useState(item?.is_active ?? true);
  const [isUpsell, setIsUpsell] = useState<boolean>(
    isCategory ? ((item as any)?.is_upsell ?? false) : false,
  );
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isBannerUploading, setIsBannerUploading] = useState(false);

  const createMutation = hooksConfig.useCreate();
  const updateMutation = hooksConfig.useUpdate();

  const isPending = createMutation.isPending || updateMutation.isPending;

  useEffect(() => {
    if (!slugManuallyEdited && !isEdit) {
      setSlug(slugify(name));
    }
  }, [name, slugManuallyEdited, isEdit]);

  function invalidateList() {
    queryClient.invalidateQueries({ queryKey: hooksConfig.getListQueryKey() });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    const body: Record<string, unknown> = {
      name: name.trim(),
      slug: slug.trim() || slugify(name.trim()),
      description: description.trim() || null,
      image_url: imageUrl || null,
      sort_order: parseInt(sortOrder, 10) || 0,
      is_active: isActive,
    };

    if (isBrand) {
      body.banner_image_url = bannerImageUrl || null;
    }

    if (isCategory) {
      body.is_upsell = isUpsell;
    }

    if (isEdit) {
      updateMutation.mutate(
        { id: item!.id, data: body as any },
        {
          onSuccess: () => {
            toast({ title: `${typeSingular} updated` });
            invalidateList();
            onClose();
          },
          onError: (err: unknown) => {
            const msg = err instanceof Error ? err.message : "An error occurred";
            toast({ title: msg, variant: "destructive" });
          },
        },
      );
    } else {
      createMutation.mutate(
        { data: body as any },
        {
          onSuccess: () => {
            toast({ title: `${typeSingular} created` });
            invalidateList();
            onClose();
          },
          onError: (err: unknown) => {
            const msg = err instanceof Error ? err.message : "An error occurred";
            toast({ title: msg, variant: "destructive" });
          },
        },
      );
    }
  }

  const anyUploading = isUploading || isBannerUploading;

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/40" onClick={onClose} />
      <div className="w-full max-w-md bg-background border-l border-border flex flex-col h-full shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold">{isEdit ? `Edit ${typeSingular}` : `New ${typeSingular}`}</h2>
          <Button variant="ghost" size="icon" onClick={onClose}><X size={18} /></Button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto">
          <div className="p-6 space-y-5">
            <div className="space-y-1.5">
              <Label htmlFor="attr-name">Name <span className="text-destructive">*</span></Label>
              <Input
                id="attr-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={`e.g. ${typeSingular} name`}
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="attr-slug">Slug</Label>
              <Input
                id="attr-slug"
                value={slug}
                onChange={(e) => { setSlug(e.target.value); setSlugManuallyEdited(true); }}
                placeholder="auto-generated-slug"
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">Used in URLs and API filters. Auto-generated from name.</p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="attr-description">Description</Label>
              <textarea
                id="attr-description"
                className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional description..."
              />
            </div>

            <AttributeImageUpload
              currentImageUrl={imageUrl}
              onChange={setImageUrl}
              onUploadingChange={setIsUploading}
              label="Logo Image"
              disabled={isPending}
            />

            {isBrand && (
              <AttributeImageUpload
                currentImageUrl={bannerImageUrl}
                onChange={setBannerImageUrl}
                onUploadingChange={setIsBannerUploading}
                label="Banner Image"
                disabled={isPending}
              />
            )}

            <div className="space-y-1.5">
              <Label htmlFor="attr-sort">Sort Order</Label>
              <Input
                id="attr-sort"
                type="number"
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value)}
                placeholder="0"
                className="w-32"
              />
              <p className="text-xs text-muted-foreground">Lower numbers appear first.</p>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <Label htmlFor="attr-active">Globally Active</Label>
                <p className="text-xs text-muted-foreground">When off, hidden from all public catalogs</p>
              </div>
              <Switch id="attr-active" checked={isActive} onCheckedChange={setIsActive} />
            </div>

            {isCategory && (
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="attr-upsell">Upsell</Label>
                  <p className="text-xs text-muted-foreground">When on, this category defines an upsell section on the website</p>
                </div>
                <Switch id="attr-upsell" checked={isUpsell} onCheckedChange={setIsUpsell} />
              </div>
            )}
          </div>

          <div className="px-6 py-4 border-t border-border flex gap-3">
            <Button type="button" variant="outline" className="flex-1" onClick={onClose}>Cancel</Button>
            <Button type="submit" className="flex-1" disabled={!name.trim() || isPending || anyUploading}>
              {isPending ? "Saving…" : isEdit ? "Save Changes" : `Create ${typeSingular}`}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
