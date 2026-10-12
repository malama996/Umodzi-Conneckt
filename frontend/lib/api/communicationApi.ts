import { get, post, patch, ApiError } from './client';

/**
 * Communication API client (Task 28.4B).
 *
 * Follows the same boundary rule as every other API module: all calls go
 * through the single HTTP client in `./client`, which attaches the session
 * token and performs exactly one coordinated refresh. No fetch calls are
 * scattered elsewhere, and no identifier is sent that the server does not
 * already derive from the authenticated session itself.
 *
 * Plain-text messages are the only payload a client ever submits — sender,
 * timestamps and read state are always server-derived.
 */

import type {
  ChatMessage,
  ConversationDetail,
  ConversationSummary,
  MessagePage,
  SendMessageInput,
} from '@/lib/types/communication';

interface Envelope<T> {
  data: T;
}

/** The conversation for a service request, or null when not available yet. */
export async function getRequestConversation(
  requestId: string,
): Promise<ConversationDetail | null> {
  try {
    const body = await get<Envelope<ConversationDetail>>(`/requests/${requestId}/conversation`);
    return body.data;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** The conversation detail keyed by its OWN id, or null when absent/foreign. */
export async function getConversationDetail(
  conversationId: string,
): Promise<ConversationDetail | null> {
  try {
    const body = await get<Envelope<ConversationDetail>>(`/conversations/${conversationId}`);
    return body.data;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) return null;
    throw error;
  }
}

/**
 * Resolve whatever id the dashboard handed us.
 *
 * Two real entry points exist and they carry different ids: the conversation
 * list links the SERVICE REQUEST id, while a notification deep link carries
 * the CONVERSATION id. Both are tried, in that order; an id matching neither
 * resolves to null, which the page renders as "not available" rather than as
 * a fabricated conversation.
 */
export async function resolveConversation(id: string): Promise<ConversationDetail | null> {
  const byRequest = await getRequestConversation(id);
  if (byRequest) return byRequest;
  return getConversationDetail(id);
}

/** One page of messages (newest page first when `before` is omitted). */
export async function getConversationMessages(
  conversationId: string,
  options: { limit?: number; before?: string } = {},
): Promise<MessagePage> {
  const params = new URLSearchParams();
  if (options.limit) params.set('limit', String(options.limit));
  if (options.before) params.set('before', options.before);
  const query = params.toString();
  const body = await get<Envelope<MessagePage>>(
    `/conversations/${conversationId}/messages${query ? `?${query}` : ''}`,
  );
  return body.data;
}

/**
 * Send a message. Only the trimmed text is sent — sender, created_at and
 * read_at are all derived server-side and rejected if supplied.
 */
export async function sendConversationMessage(
  conversationId: string,
  input: SendMessageInput,
): Promise<ChatMessage> {
  const body = await post<Envelope<ChatMessage>>(`/conversations/${conversationId}/messages`, {
    message: input.message,
  });
  return body.data;
}

/** Mark the other participant's messages read; returns how many changed. */
export async function markConversationRead(conversationId: string): Promise<number> {
  const body = await patch<Envelope<{ updated: number }>>(`/conversations/${conversationId}/read`);
  return body.data.updated;
}

/** The authenticated user's conversations (already ownership-filtered). */
export async function listMyConversations(): Promise<ConversationSummary[]> {
  const body = await get<Envelope<{ conversations: ConversationSummary[] }>>('/me/conversations');
  return body.data.conversations;
}

/** Safe, user-facing message for a communication failure. */
export function communicationErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    try {
      const parsed = JSON.parse(error.body) as { error?: string };
      if (parsed.error) return parsed.error;
    } catch {
      /* non-JSON body */
    }
    if (error.status === 403) return 'You are not part of this conversation.';
    if (error.status === 404) return 'This conversation is not available.';
    if (error.status === 429) return 'Too many messages — wait a moment and try again.';
    if (error.status >= 500) return 'Something went wrong on our side. Please try again.';
  }
  return 'Unable to reach the server. Check your connection and try again.';
}

/** Build the `tel:` link for a validated number returned by the backend. */
export function toTelLink(phone: string): string {
  // The backend returns an already-normalized number; this only guards
  // against an unexpected value reaching the href.
  const cleaned = phone.replace(/[^0-9+]/g, '');
  return `tel:${cleaned}`;
}
