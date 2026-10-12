// Minimal ambient types for `web-push` (v3.6.7), which ships no bundled
// declarations and has no @types package installed in this workspace. Only
// the surface the backend actually uses is declared. This file is a global
// ambient module declaration (no top-level import/export), so tsconfig's
// `include: src/**/*.ts` picks it up under NodeNext.
declare module 'web-push' {
  export interface WebPushSubscription {
    endpoint: string;
    keys?: {
      p256dh: string;
      auth: string;
    };
  }

  export interface SendOptions {
    TTL?: number;
    urgency?: 'very-low' | 'low' | 'normal' | 'high';
    topic?: string;
    proxy?: string;
    headers?: Record<string, string>;
  }

  export interface VapidKeys {
    publicKey: string;
    privateKey: string;
  }

  const webpush: {
    setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
    generateVAPIDKeys(): VapidKeys;
    sendNotification(
      subscription: WebPushSubscription,
      payload?: string,
      options?: SendOptions
    ): Promise<void>;
  };

  export default webpush;
}
