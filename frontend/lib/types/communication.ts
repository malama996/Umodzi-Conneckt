/**
 * Communication domain types (Task 28.4B).
 *
 * Mirrors the backend contract exactly:
 *   - senderId is the server-derived subject, never a client claim
 *   - createdAt/readAt are server timestamps
 *   - conversation status is 'active' | 'closed'
 *
 * No `any` here: every field maps to a real backend response field.
 */

export type ConversationStatus = 'active' | 'closed';

/** A single persisted chat message. */
export interface ChatMessage {
  id: string;
  senderId: string;
  message: string;
  createdAt: string;
  readAt: string | null;
}

/** The other party in a conversation, as disclosed by the backend. */
export interface ConversationParticipant {
  userId: string | null;
  displayName: string;
  isTechnician: boolean;
}

/** The service request a conversation belongs to. */
export interface ConversationRequest {
  id: string;
  city: string | null;
  category: string | null;
}

/** Full conversation payload from GET /requests/:id/conversation. */
export interface ConversationDetail {
  conversation: {
    id: string;
    serviceRequestId: string;
    customerId: string;
    technicianId: string;
    status: ConversationStatus;
    createdAt: string;
    updatedAt: string;
  };
  otherParticipant: ConversationParticipant;
  request: ConversationRequest;
  canCommunicate: boolean;
}

/** Cursor-paginated message page from GET /conversations/:id/messages. */
export interface MessagePage {
  messages: ChatMessage[];
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
}

/** Request body for POST /conversations/:id/messages. */
export interface SendMessageInput {
  message: string;
}

/** Conversation list entry from GET /me/conversations. */
export interface ConversationSummary {
  id: string;
  serviceRequestId: string;
  status: ConversationStatus;
  createdAt: string;
  updatedAt: string;
  otherParticipant: ConversationParticipant;
  request: ConversationRequest;
  unreadCount: number;
  lastMessage: { message: string; createdAt: string | null; senderId: string | null } | null;
}

/** Realtime event shape emitted by the WebSocket server. */
export type ChatRealtimeEvent =
  | {
      type: 'message';
      conversationId: string;
      messageId: string;
      senderId: string;
      createdAt: string;
    }
  | { type: 'read'; conversationId: string; messageIds: string[] }
  | { type: 'error'; error: string }
  | { type: 'subscribed'; conversationId: string };
