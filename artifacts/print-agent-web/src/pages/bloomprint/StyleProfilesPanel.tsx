import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Loader2, Plus, Sparkles, Check } from "lucide-react";
import {
  bloomprintErrorMessage,
  useBloomprintStyleProfiles,
  useCreateBloomprintStyleProfile,
} from "@/hooks/use-bloomprint";
import { Badge } from "@/components/ui/badge";
import { useUpload } from "@workspace/object-storage-web";
import { imageUrl } from "@/lib/imageUrl";
import { getClerkToken } from "@/lib/queryClient";
import { isPermissionError } from "@/lib/permissionError";

export function StyleProfilesPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const {
    data: profiles,
    error: profilesError,
    isError: isProfilesError,
    isFetching: isFetchingProfiles,
    isLoading,
    refetch: refetchProfiles,
  } = useBloomprintStyleProfiles();
  const createProfile = useCreateBloomprintStyleProfile();
  
  const [isCreating, setIsCreating] = useState(false);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [makeDefault, setMakeDefault] = useState(false);
  const [referenceImagePaths, setReferenceImagePaths] = useState<string[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const { uploadFile, isUploading } = useUpload({
    getAuthToken: getClerkToken,
    onSuccess: ({ objectPath }) => {
      setReferenceImagePaths((paths) => [...paths, objectPath].slice(0, 6));
      setUploadError(null);
    },
    onError: (error) => setUploadError(error.message),
  });

  const handleCreate = () => {
    if (!name || !prompt) return;
    setSaveError(null);
    createProfile.mutate(
      { name, prompt, make_default: makeDefault, reference_image_paths: referenceImagePaths },
      {
        onSuccess: () => {
          setIsCreating(false);
          setName("");
          setPrompt("");
          setMakeDefault(false);
          setReferenceImagePaths([]);
          setUploadError(null);
        },
        onError: (error) => {
          setSaveError(
            `Profile could not be saved: ${bloomprintErrorMessage(
              error,
              "Please try again.",
            )}`,
          );
        },
      }
    );
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader className="mb-6">
          <SheetTitle className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-primary" />
            House Style Profiles
          </SheetTitle>
          <SheetDescription>
            Manage the visual prompts applied when generating product imagery from drafts.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-6">
          {isCreating ? (
            <div className="space-y-4 bg-muted/30 p-4 rounded-xl border border-border">
              <h3 className="font-medium text-sm">New Style Profile</h3>
              <div className="space-y-2">
                <Label>Name</Label>
                <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Modern Minimalist" />
              </div>
              <div className="space-y-2">
                <Label>Private Visual References</Label>
                <p className="text-xs text-muted-foreground">Optional. Add up to six internal reference images to guide image editing for drafts using this profile.</p>
                <div className="flex flex-wrap gap-2">
                  {referenceImagePaths.map((path) => (
                    <div key={path} className="relative h-16 w-16 overflow-hidden rounded-md border">
                      <img src={imageUrl(path) || ""} alt="Style reference" className="h-full w-full object-cover" />
                      <button
                        type="button"
                        onClick={() => setReferenceImagePaths((paths) => paths.filter((value) => value !== path))}
                        className="absolute right-0 top-0 rounded-bl bg-background/90 px-1 text-xs"
                        aria-label="Remove reference image"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  {referenceImagePaths.length < 6 && (
                    <label className="flex h-16 w-16 cursor-pointer items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground hover:border-primary">
                      {isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add"}
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        className="sr-only"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) uploadFile(file);
                          event.currentTarget.value = "";
                        }}
                        disabled={isUploading}
                      />
                    </label>
                  )}
                </div>
                {uploadError && <p className="text-xs text-destructive">{uploadError}</p>}
              </div>
              <div className="space-y-2">
                <Label>Prompt Instructions</Label>
                <Textarea 
                  value={prompt} 
                  onChange={e => setPrompt(e.target.value)} 
                  placeholder="e.g. Bright lighting, soft shadows, neutral background..." 
                  className="min-h-[100px]"
                />
              </div>
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Make Default</Label>
                  <p className="text-xs text-muted-foreground">Use this style for all new drafts</p>
                </div>
                <Switch checked={makeDefault} onCheckedChange={setMakeDefault} />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="ghost" onClick={() => setIsCreating(false)}>Cancel</Button>
                <Button onClick={handleCreate} disabled={!name || !prompt || createProfile.isPending}>
                  {createProfile.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                  Save Profile
                </Button>
              </div>
            </div>
          ) : (
            <Button onClick={() => setIsCreating(true)} className="w-full" variant="outline">
              <Plus className="w-4 h-4 mr-2" />
              Create Profile
            </Button>
          )}

          <div className="space-y-3">
            {saveError && (
              <p className="text-sm text-destructive" role="alert">
                {saveError}
              </p>
            )}
            {isLoading ? (
              <div className="flex justify-center p-8">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : isProfilesError ? (
              <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-5 text-center" role="alert">
                <p className="text-sm font-medium text-destructive">
                  {isPermissionError(profilesError)
                    ? "You need Manage products access to view style profiles."
                    : "Couldn’t load style profiles."}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {bloomprintErrorMessage(
                    profilesError,
                    "Please try again.",
                  )}
                </p>
                {!isPermissionError(profilesError) && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="mt-3"
                    onClick={() => void refetchProfiles()}
                    disabled={isFetchingProfiles}
                  >
                    {isFetchingProfiles ? "Retrying…" : "Retry"}
                  </Button>
                )}
              </div>
            ) : !profiles || profiles.length === 0 ? (
              <div className="text-center p-8 border border-dashed rounded-xl">
                <p className="text-sm text-muted-foreground">No style profiles found.</p>
              </div>
            ) : (
              profiles.map(profile => (
                <div key={profile.id} className="p-4 rounded-xl border border-border bg-card shadow-sm hover:border-primary/20 transition-colors">
                  <div className="flex justify-between items-start mb-2">
                    <div>
                      <h4 className="font-medium flex items-center gap-2">
                        {profile.name}
                        {profile.is_default && (
                          <Badge variant="secondary" className="text-[10px] bg-primary/10 text-primary hover:bg-primary/20">Default</Badge>
                        )}
                      </h4>
                      <p className="text-xs text-muted-foreground">Version {profile.version}</p>
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground line-clamp-3">{profile.prompt}</p>
                  {!!profile.reference_image_paths?.length && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {profile.reference_image_paths.length} private reference image{profile.reference_image_paths.length === 1 ? "" : "s"}
                    </p>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
