import { useState, useEffect } from "react";
import { useParams, useLocation, Link } from "wouter";
import { 
  useBloomprintDraft, 
  useUpdateBloomprintDraft, 
  useRenderBloomprintDraft, 
  useApproveBloomprintDraft, 
  useDeleteBloomprintDraft 
} from "@/hooks/use-bloomprint";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { 
  Loader2, ArrowLeft, Wand2, Check, Trash2, Image as ImageIcon, 
  AlertCircle, Sparkles, ChevronsUpDown
} from "lucide-react";
import { imageUrl } from "@/lib/imageUrl";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { BaseItemImageThumbnail } from "@/components/BaseItemImageThumbnail";

type BaseItemOption = {
  id: number;
  name: string;
  code: string;
  image_url: string | null;
};

export default function BloomprintDraftDetail() {
  const { id } = useParams();
  const [, setLocation] = useLocation();
  const { data: draft, isLoading } = useBloomprintDraft(id);
  const updateDraft = useUpdateBloomprintDraft(id as string);
  const renderDraft = useRenderBloomprintDraft(id as string);
  const approveDraft = useApproveBloomprintDraft(id as string);
  const deleteDraft = useDeleteBloomprintDraft(id as string);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [priceUsd, setPriceUsd] = useState("");
  const [priceAed, setPriceAed] = useState("");
  const [boxColor, setBoxColor] = useState<"black" | "white" | "blush_pink" | "natural_kraft">("black");
  const [substitutionNotes, setSubstitutionNotes] = useState("");
  const [recipeItems, setRecipeItems] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<"details" | "recipe">("details");

  useEffect(() => {
    if (draft) {
      setName(draft.name || "");
      setDescription(draft.description || "");
      setPriceUsd(draft.price_usd || "");
      setPriceAed(draft.price_aed || "");
      setBoxColor(draft.box_color || "black");
      setSubstitutionNotes(draft.substitution_notes || "");
      if (draft.recipe_lines) {
        setRecipeItems(draft.recipe_lines);
      }
    }
  }, [draft]);

  if (isLoading || !draft) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const handleSave = () => {
    updateDraft.mutate({
      name,
      description,
      price_usd: priceUsd === "" ? undefined : Number(priceUsd),
      price_aed: priceAed === "" ? undefined : Number(priceAed),
      box_color: boxColor,
      substitution_notes: substitutionNotes,
      recipe_items: recipeItems
    });
  };

  const isRecipeResolved = recipeItems.length > 0 && recipeItems.every(item => item.proposed_base_item_id);
  const canRender = isRecipeResolved && name && description && priceUsd;
  const canApprove = draft.status === "rendered";

  return (
    <div className="max-w-7xl mx-auto px-4 py-8 flex flex-col h-[calc(100vh-80px)]">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 mb-6 shrink-0">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => setLocation("/bloomprint")}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
              {draft.name || "Untitled Draft"}
              <Badge variant={draft.status === "approved" ? "default" : "secondary"}>
                {draft.status.toUpperCase()}
              </Badge>
            </h1>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button 
            variant="outline" 
            className="text-destructive hover:bg-destructive/10"
            onClick={() => {
              if (confirm("Are you sure you want to discard this draft?")) {
                deleteDraft.mutate(undefined, {
                  onSuccess: () => setLocation("/bloomprint")
                });
              }
            }}
            disabled={deleteDraft.isPending}
          >
            <Trash2 className="w-4 h-4 mr-2" />
            Discard
          </Button>
          
          <Button 
            variant="secondary" 
            onClick={handleSave}
            disabled={updateDraft.isPending || draft.status === "approved"}
          >
            {updateDraft.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Save Changes
          </Button>

          {draft.status !== "approved" && (
            <Button 
              onClick={() => renderDraft.mutate()}
              disabled={!canRender || renderDraft.isPending}
              className={draft.status === "draft" ? "bg-primary text-primary-foreground" : ""}
            >
              {renderDraft.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Wand2 className="w-4 h-4 mr-2" />}
              Render Imagery
            </Button>
          )}

          {draft.status === "rendered" && (
            <Button 
              onClick={() => approveDraft.mutate(undefined, {
                onSuccess: ({ product_id }) => setLocation(`/products/${product_id}`),
              })}
              disabled={approveDraft.isPending}
              className="bg-green-600 hover:bg-green-700 text-white"
            >
              {approveDraft.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Check className="w-4 h-4 mr-2" />}
              Approve Product
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-8 flex-1 min-h-0">
        {/* Left Column - Imagery */}
        <div className="w-full lg:w-[45%] flex flex-col gap-4 overflow-y-auto pr-2 pb-8">
          <div className="bg-card rounded-2xl border border-border p-4 shadow-sm">
            <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-primary" /> Generated Output
            </h3>
            <div className="aspect-[4/5] rounded-xl overflow-hidden bg-muted border border-border flex items-center justify-center">
              {draft.generated_image_path ? (
                <img 
                  src={imageUrl(draft.generated_image_path) || ""} 
                  alt="Generated Product" 
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="text-center p-6">
                  <ImageIcon className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
                  <p className="text-sm text-muted-foreground">
                    Image not yet generated.<br/>Complete details and recipe to render.
                  </p>
                </div>
              )}
            </div>
            {draft.render_attempts?.find((attempt) => attempt.status === "failed")?.error_message && (
              <div className="mt-3 rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
                <span className="font-medium">Most recent render issue: </span>
                {draft.render_attempts.find((attempt) => attempt.status === "failed")?.error_message}
              </div>
            )}
            {!!draft.render_attempts?.length && (
              <div className="mt-4 border-t border-border pt-4">
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Render attempts</h4>
                <div className="space-y-2">
                  {draft.render_attempts.map((attempt) => (
                    <div key={attempt.id} className="flex items-start justify-between gap-3 rounded-lg bg-muted/50 px-3 py-2 text-xs">
                      <div>
                        <p className="font-medium capitalize">{attempt.status.replace("_", " ")}</p>
                        <p className="mt-0.5 text-muted-foreground">
                          {attempt.generation_mode === "reference_edit"
                            ? `Reference-guided edit · ${attempt.reference_image_count} style image${attempt.reference_image_count === 1 ? "" : "s"}`
                            : "Text-only generation"}
                          {" · "}{attempt.model}
                        </p>
                        {attempt.error_message && <p className="mt-0.5 text-destructive">{attempt.error_message}</p>}
                      </div>
                      <span className="shrink-0 text-muted-foreground">{new Date(attempt.created_at).toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="bg-card rounded-2xl border border-border p-4 shadow-sm opacity-80">
            <h3 className="text-sm font-semibold mb-3 text-muted-foreground">Original Inspiration</h3>
            <div className="aspect-square max-w-[200px] rounded-xl overflow-hidden bg-muted border border-border">
              <img 
                src={imageUrl(draft.inspiration_image_path) || ""} 
                alt="Inspiration" 
                className="w-full h-full object-cover"
              />
            </div>
            {draft.analysis?.visual_summary && (
              <p className="text-xs text-muted-foreground mt-3 italic">
                "{draft.analysis.visual_summary}"
              </p>
            )}
          </div>
        </div>

        {/* Right Column - Data & Recipe */}
        <div className="w-full lg:w-[55%] flex flex-col border border-border rounded-2xl bg-card shadow-sm overflow-hidden">
          <div className="flex border-b border-border">
            <button 
              className={`flex-1 py-3 text-sm font-medium transition-colors ${activeTab === "details" ? "border-b-2 border-primary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => setActiveTab("details")}
            >
              Product Details
            </button>
            <button 
              className={`flex-1 py-3 text-sm font-medium transition-colors ${activeTab === "recipe" ? "border-b-2 border-primary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => setActiveTab("recipe")}
            >
              Recipe & Build
              {!isRecipeResolved && (
                <span className="ml-2 inline-flex w-2 h-2 rounded-full bg-destructive" />
              )}
            </button>
          </div>

          <div className="p-6 overflow-y-auto flex-1">
            {activeTab === "details" ? (
              <div className="space-y-5">
                <div className="space-y-2">
                  <Label>Product Name</Label>
                  <Input 
                    value={name} 
                    onChange={e => setName(e.target.value)} 
                    placeholder="e.g. The Spring Blossom"
                    disabled={draft.status === "approved"}
                  />
                </div>
                
                <div className="space-y-2">
                  <Label>Marketing Description</Label>
                  <Textarea 
                    value={description} 
                    onChange={e => setDescription(e.target.value)} 
                    placeholder="Craft a beautiful description..."
                    className="h-32"
                    disabled={draft.status === "approved"}
                  />
                </div>
                
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Price (USD)</Label>
                    <Input 
                      type="number" 
                      value={priceUsd} 
                      onChange={e => setPriceUsd(e.target.value)} 
                      placeholder="0.00"
                      disabled={draft.status === "approved"}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Price (AED)</Label>
                    <Input 
                      type="number" 
                      value={priceAed} 
                      onChange={e => setPriceAed(e.target.value)} 
                      placeholder="0.00"
                      disabled={draft.status === "approved"}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="bloomprint-box-color">Presentail Box Colour</Label>
                  <select
                    id="bloomprint-box-color"
                    value={boxColor}
                    onChange={(event) => setBoxColor(event.target.value as typeof boxColor)}
                    disabled={draft.status === "approved"}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm"
                  >
                    <option value="black">Black</option>
                    <option value="white">White</option>
                    <option value="blush_pink">Blush pink</option>
                    <option value="natural_kraft">Natural kraft</option>
                  </select>
                  <p className="text-xs text-muted-foreground">Used in the next render prompt and printed Presentail box direction.</p>
                </div>

                <div className="space-y-2">
                  <Label>Substitution Notes (Internal)</Label>
                  <Textarea 
                    value={substitutionNotes} 
                    onChange={e => setSubstitutionNotes(e.target.value)} 
                    placeholder="e.g. If pink roses are unavailable, substitute with white..."
                    disabled={draft.status === "approved"}
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-6">
                {!isRecipeResolved && (
                  <div className="bg-destructive/10 text-destructive text-sm p-3 rounded-lg flex items-start gap-2 border border-destructive/20">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-medium">Recipe requires resolution</p>
                      <p className="opacity-90">Please assign a specific Base Item to every extracted requirement before rendering.</p>
                    </div>
                  </div>
                )}

                <div className="space-y-4">
                  {recipeItems.map((item, idx) => (
                    <div key={idx} className={`p-4 rounded-xl border ${item.proposed_base_item_id ? 'border-border' : 'border-destructive/50 bg-destructive/5'} space-y-3`}>
                      <div className="flex justify-between items-start">
                        <div>
                          <p className="font-medium text-sm flex items-center gap-2">
                            Extracted: <span className="text-primary">{item.extracted_requirement}</span>
                          </p>
                          {item.rationale && (
                            <p className="text-xs text-muted-foreground mt-1">{item.rationale}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Label className="text-xs">Qty</Label>
                          <Input 
                            type="number" 
                            className="w-16 h-8 text-sm" 
                            value={item.quantity || ""}
                            onChange={e => {
                              const newItems = [...recipeItems];
                              newItems[idx].quantity = parseInt(e.target.value) || 0;
                              setRecipeItems(newItems);
                            }}
                            disabled={draft.status === "approved"}
                          />
                        </div>
                      </div>

                      <div className="pt-2">
                        <Label className="text-xs mb-1 block">Resolved Base Item</Label>
                        <ResolvedBaseItemCombobox
                          value={
                            item.proposed_base_item_id
                              ? { id: item.proposed_base_item_id, name: item.proposed_base_item_name || "" }
                              : null
                          }
                          onSelect={selected => {
                            const newItems = [...recipeItems];
                            newItems[idx].proposed_base_item_id = selected.id;
                            newItems[idx].proposed_base_item_name = selected.name;
                            setRecipeItems(newItems);
                          }}
                          disabled={draft.status === "approved"}
                        />
                      </div>
                    </div>
                  ))}

                  {recipeItems.length === 0 && (
                    <div className="text-center p-8 border border-dashed rounded-xl text-muted-foreground text-sm">
                      No recipe items generated yet.
                    </div>
                  )}

                  {draft.status !== "approved" && (
                    <Button 
                      variant="outline" 
                      className="w-full border-dashed"
                      onClick={() => {
                        setRecipeItems([...recipeItems, {
                          id: Date.now(),
                          line_order: recipeItems.length + 1,
                          proposed_base_item_id: null,
                          proposed_base_item_name: null,
                          quantity: 1,
                          extracted_requirement: "New Item",
                          match_confidence: null,
                          source_type: "manual",
                          rationale: "Manually added"
                        }]);
                      }}
                    >
                      Add Recipe Line
                    </Button>
                  )}
                </div>
                {draft.status === "approved" && draft.approved_product_id && (
                  <Link href={`/products/${draft.approved_product_id}`} className="block text-center text-sm font-medium text-primary hover:underline">
                    Open approved product
                  </Link>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ResolvedBaseItemCombobox({
  value,
  onSelect,
  disabled,
}: {
  value: { id: number; name: string } | null;
  onSelect: (item: BaseItemOption) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const { data } = useQuery({
    queryKey: ["base-items-search", search],
    queryFn: () =>
      apiFetch<{ items: BaseItemOption[] }>(
        `/api/base-items?limit=100${search.trim() ? `&q=${encodeURIComponent(search.trim())}` : ""}`,
      ),
    staleTime: 10_000,
  });

  const { data: selectedData } = useQuery({
    queryKey: ["base-item", value?.id],
    queryFn: () => apiFetch<{ item: BaseItemOption }>(`/api/base-items/${value!.id}`),
    enabled: !!value?.id,
    staleTime: 30_000,
  });

  const items = data?.items ?? [];
  const selectedImageUrl = selectedData?.item ? imageUrl(selectedData.item.image_url) : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full h-9 justify-between font-normal px-3"
        >
          <span className="flex items-center gap-2 min-w-0">
            <BaseItemImageThumbnail imageUrl={selectedImageUrl} name={value?.name || "?"} size={6} />
            <span className={`truncate ${value?.name ? "" : "text-muted-foreground"}`}>
              {value?.name || "-- Select Base Item --"}
            </span>
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search base items…"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            {items.length === 0 ? (
              <CommandEmpty className="text-xs text-muted-foreground py-4 text-center">
                {search.trim() ? "No matching base items" : "No base items yet"}
              </CommandEmpty>
            ) : (
              <CommandGroup>
                {items.map(bi => {
                  const url = imageUrl(bi.image_url);
                  return (
                    <CommandItem
                      key={bi.id}
                      value={String(bi.id)}
                      onSelect={() => {
                        onSelect(bi);
                        setOpen(false);
                        setSearch("");
                      }}
                      className="gap-2"
                    >
                      <BaseItemImageThumbnail imageUrl={url} name={bi.name} size={6} />
                      <span className="min-w-0 truncate">{bi.name}</span>
                      <span className="text-xs text-muted-foreground font-mono shrink-0">{bi.code}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
