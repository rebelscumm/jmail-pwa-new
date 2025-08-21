// Minimal types for Google Identity Services (GIS)
// Enough for our usage without pulling external type packages

declare namespace google {
  namespace accounts {
    namespace oauth2 {
      type OAuth2TokenResponse = {
        access_token?: string;
        expires_in?: number;
        token_type?: string;
        error?: string;
      };
      interface TokenClient {
        callback: (res: OAuth2TokenResponse) => void;
        requestAccessToken: (options?: { prompt?: string; hint?: string }) => void;
      }
      function initTokenClient(options: {
        client_id: string;
        scope: string;
        prompt?: string;
        callback: (res: OAuth2TokenResponse) => void;
      }): TokenClient;
    }
  }
}

declare interface Window {
  google: typeof google;
}

