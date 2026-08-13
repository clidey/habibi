export type WhatsAppChatKind = 'individual' | 'group' | 'channel' | 'status' | 'broadcast' | 'unknown';

export interface WhatsAppMedia {
  mimetype?: string;
  filename?: string;
  data?: string;
  omitted?: boolean;
}

export interface WhatsAppMessage {
  id: string;
  chatId: string;
  body?: string;
  type: 'text' | 'image' | 'video' | 'audio' | 'voice' | 'document' | 'unknown';
  direction: 'incoming' | 'outgoing';
  timestamp?: number;
  metadata?: { media?: WhatsAppMedia };
}

export interface WhatsAppChat {
  id: string;
  name: string;
  kind: WhatsAppChatKind;
  timestamp: number;
  lastMessage?: string;
  unreadCount?: number;
  archived?: boolean;
  avatar?: string;
}

export interface OpenwaSession {
  id: string;
  name: string;
  status: 'created' | 'initializing' | 'qr_ready' | 'authenticating' | 'ready' | 'disconnected' | 'failed';
  connectedAt?: string | null;
  phone?: string | null;
  pushName?: string | null;
}
