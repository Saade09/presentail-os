import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { useState, useCallback } from "react";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Search, Users, ChevronRight } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface Contact {
  id: number;
  display_name: string;
  email: string | null;
  phone: string | null;
  avatar_url: string | null;
  is_blocked: boolean;
  last_seen_at: string | null;
  conversation_count: number;
  created_at: string;
}

interface ContactsResponse {
  success: boolean;
  contacts: Contact[];
  total: number;
  limit: number;
  offset: number;
}

const PAGE_SIZE = 50;

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export default function ContactsPage() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(0);
  const [isBlockedFilter, setIsBlockedFilter] = useState<boolean | null>(null);

  const debounceSearch = useCallback((val: string) => {
    setDebouncedSearch(val);
    setPage(0);
  }, []);

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearch(e.target.value);
    clearTimeout((window as unknown as { _searchTimer?: ReturnType<typeof setTimeout> })._searchTimer);
    (window as unknown as { _searchTimer?: ReturnType<typeof setTimeout> })._searchTimer = setTimeout(
      () => debounceSearch(e.target.value),
      300,
    );
  };

  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(page * PAGE_SIZE),
  });
  if (debouncedSearch) params.set("q", debouncedSearch);
  if (isBlockedFilter !== null) params.set("is_blocked", String(isBlockedFilter));

  const { data, isLoading, isError } = useQuery<ContactsResponse>({
    queryKey: ["omnichannel-contacts", debouncedSearch, page, isBlockedFilter],
    queryFn: () => apiFetch(`/api/omnichannel/contacts?${params}`),
  });

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Users className="w-6 h-6" />
            Contacts
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            {data ? `${data.total.toLocaleString()} contacts` : "Manage your omnichannel contacts"}
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search name, email, phone…"
            value={search}
            onChange={handleSearchChange}
            className="pl-9"
          />
        </div>
        <Button
          variant={isBlockedFilter === null ? "default" : "outline"}
          size="sm"
          onClick={() => { setIsBlockedFilter(null); setPage(0); }}
        >
          All
        </Button>
        <Button
          variant={isBlockedFilter === false ? "default" : "outline"}
          size="sm"
          onClick={() => { setIsBlockedFilter(false); setPage(0); }}
        >
          Active
        </Button>
        <Button
          variant={isBlockedFilter === true ? "default" : "outline"}
          size="sm"
          onClick={() => { setIsBlockedFilter(true); setPage(0); }}
        >
          Blocked
        </Button>
      </div>

      {isLoading && (
        <div className="flex justify-center py-16">
          <Spinner className="size-8 text-primary" />
        </div>
      )}

      {isError && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Failed to load contacts.
          </CardContent>
        </Card>
      )}

      {data && !isLoading && (
        <>
          {data.contacts.length === 0 ? (
            <Card>
              <CardContent className="py-16 text-center">
                <Users className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                <p className="text-muted-foreground">No contacts found</p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <div className="divide-y divide-border">
                {data.contacts.map((contact) => (
                  <Link key={contact.id} href={`/omnichannel/contacts/${contact.id}`}>
                    <div className="flex items-center gap-3 px-4 py-3 hover:bg-muted/50 cursor-pointer transition-colors">
                      <Avatar className="w-9 h-9 shrink-0">
                        <AvatarImage src={contact.avatar_url ?? undefined} />
                        <AvatarFallback className="text-xs">
                          {getInitials(contact.display_name)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-sm truncate">{contact.display_name}</p>
                          {contact.is_blocked && (
                            <Badge variant="destructive" className="text-[10px] py-0 h-4">
                              Blocked
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                          {contact.email && <span className="truncate">{contact.email}</span>}
                          {contact.phone && <span>{contact.phone}</span>}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-xs text-muted-foreground">
                          {contact.last_seen_at
                            ? formatDistanceToNow(new Date(contact.last_seen_at), { addSuffix: true })
                            : "—"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {contact.conversation_count} conv.
                        </p>
                      </div>
                      <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                    </div>
                  </Link>
                ))}
              </div>
            </Card>
          )}

          {totalPages > 1 && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                {data.offset + 1}–{Math.min(data.offset + data.limit, data.total)} of {data.total}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
