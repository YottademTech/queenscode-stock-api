import { z } from 'zod';

const replySchema = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
]);
export type GatewayReply = z.infer<typeof replySchema>;

/** The Apps Script could not be reached, or did not answer in its own format. Worth trying again. */
export class GatewayUnreachable extends Error {}

/**
 * The Apps Script web app bound to the Google Sheet. This server uses it for two things only:
 * copying saved changes to the Sheet, and storing product photos in Google Drive.
 */
export type SheetGateway = {
  call(action: string, payload: Record<string, unknown>, timeoutMs: number): Promise<GatewayReply>;
};

export function sheetGateway(url: string, secret: string): SheetGateway {
  return {
    async call(action, payload, timeoutMs) {
      let text: string;
      try {
        const response = await fetch(url, {
          method: 'POST',
          // The form the Apps Script reads; it answers through a redirect, which fetch follows.
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ ...payload, action, secret }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = await response.text();
      } catch (error) {
        throw new GatewayUnreachable(`The Apps Script could not be reached: ${error instanceof Error ? error.message : String(error)}`);
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        // Google answers with an HTML page when the deployment is missing or its access is wrong.
        throw new GatewayUnreachable('The Apps Script sent a reply that is not JSON. Check its deployment and access setting.');
      }
      const reply = replySchema.safeParse(json);
      if (!reply.success) throw new GatewayUnreachable('The Apps Script sent a reply in an unknown format.');
      return reply.data;
    },
  };
}
