export interface Env {
  // Bindings
  DB: D1Database;
  EVENTS: Queue<FbEvent>;

  // Vars
  FB_GRAPH_VERSION: string;
  GEMINI_MODEL: string;
  LOG_LEVEL: string;

  // Secrets
  FB_APP_SECRET: string;
  FB_VERIFY_TOKEN: string;
  FB_PAGE_ACCESS_TOKEN: string;
  FB_PAGE_ID: string;
  GEMINI_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  ADMIN_TOKEN: string;
}

export type FbEvent =
  | { kind: 'comment'; postId: string; commentId: string; fromId: string; fromName?: string; message: string; createdTime: number; parentId?: string }
  | { kind: 'message'; senderId: string; recipientId: string; mid: string; text?: string; timestamp: number }
  | { kind: 'feed_other'; raw: unknown };
