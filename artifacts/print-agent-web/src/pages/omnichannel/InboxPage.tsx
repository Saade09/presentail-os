import { useState } from "react";
import { Redirect } from "wouter";
import ConversationListPanel from "./ConversationListPanel";
import ConversationThreadPanel from "./ConversationThreadPanel";
import ContactDetailsPanel from "./ContactDetailsPanel";
import { useOmnichannelSSEState } from "@/contexts/omnichannel-sse-context";

export default function InboxPage() {
  const [selectedConversationId, setSelectedConversationId] = useState<number | null>(null);
  const { reconnecting, backOnline } = useOmnichannelSSEState();

  return (
    <div className="flex flex-col h-[calc(100dvh-4rem)] overflow-hidden -mx-6 -mt-6">
      {reconnecting && (
        <div className="flex items-center justify-center gap-2 bg-yellow-50 border-b border-yellow-200 py-1.5 px-4 text-xs text-yellow-800">
          <span className="inline-block h-2 w-2 rounded-full bg-yellow-400 animate-pulse" />
          Reconnecting to live updates…
        </div>
      )}
      {backOnline && (
        <div className="flex items-center justify-center gap-2 bg-green-50 border-b border-green-200 py-1.5 px-4 text-xs text-green-800">
          <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
          Back online — receiving live updates
        </div>
      )}
      <div className="flex flex-1 overflow-hidden">
        <ConversationListPanel
          selectedId={selectedConversationId}
          onSelect={setSelectedConversationId}
        />

        {selectedConversationId ? (
          <>
            <ConversationThreadPanel conversationId={selectedConversationId} />
            <ContactDetailsPanel conversationId={selectedConversationId} />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
            Select a conversation to get started
          </div>
        )}
      </div>
    </div>
  );
}

export function OmnichannelIndexRedirect() {
  return <Redirect to="/omnichannel/inbox" />;
}
