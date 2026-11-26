import Anthropic from '@anthropic-ai/sdk';
import { AppError } from '../errors.ts';
import type { EncodedImage } from '../photos/store.ts';

export type VisionQuestion = {
  instructions: string;
  question: string;
  images: readonly EncodedImage[];
  /** How many of the images, from the first, show the stock to count. The rest are detail photos. */
  views: number;
  /** JSON Schema the answer must follow. */
  schema: Record<string, unknown>;
  effort: 'medium' | 'high';
};

/** Something that looks at photos and answers in the asked-for shape. Claude in production; a stand-in in tests. */
export type VisionModel = { ask(question: VisionQuestion): Promise<unknown> };

const UNREADABLE = 'The photo could not be read this time. Try the photo again.';

export function claudeVision(apiKey: string, model: string): VisionModel {
  // Reading a photo has no side effect beyond its cost, so the SDK retries rate limits, server
  // errors and dropped connections by itself: three attempts in all.
  const client = apiKey === '' ? null : new Anthropic({ apiKey, maxRetries: 2, timeout: 100_000 });

  return {
    async ask({ instructions, question, images, views, schema, effort }) {
      if (!client) throw new AppError('not_configured', 'The server has no CLAUDE_API_KEY.');

      let message: Anthropic.Message;
      try {
        message = await client.messages.create({
          model,
          max_tokens: 16000,
          system: instructions,
          output_config: { effort, format: { type: 'json_schema', schema } },
          messages: [{ role: 'user', content: [...photoBlocks(images, views), { type: 'text', text: question }] }],
        });
      } catch (error) {
        throw claudeFailure(error);
      }

      if (message.stop_reason === 'refusal') throw new AppError('claude_declined', 'This photo could not be read. Count it by hand.');
      if (message.stop_reason === 'max_tokens') throw new AppError('claude_unavailable', 'The answer was cut off. Try a photo with fewer products.');

      // Thinking blocks can come first, so the answer is found by type, not position.
      const answer = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
      try {
        return JSON.parse(answer);
      } catch {
        throw new AppError('claude_unavailable', UNREADABLE);
      }
    },
  };
}

/**
 * The photos as Claude receives them. With more than one, each is named so the instructions can
 * refer to it. The first `views` show the stock to count; the rest are detail photos.
 */
export function photoBlocks(images: readonly EncodedImage[], views: number): Anthropic.ContentBlockParam[] {
  return images.flatMap((image, index): Anthropic.ContentBlockParam[] => [
    ...(images.length > 1 ? [{ type: 'text' as const, text: photoLabel(index, views) }] : []),
    { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
  ]);
}

function photoLabel(index: number, views: number): string {
  if (views > 1) return index < views ? `View ${index + 1} of ${views} of the stock:` : `Detail photo ${index - views + 1}:`;
  return `Photo ${index + 1}${index === 0 ? ', the count photo:' : ', a detail photo:'}`;
}

function claudeFailure(error: unknown): AppError {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new AppError('not_configured', 'The API key was rejected. Check CLAUDE_API_KEY on the server.');
  }
  const busy = new AppError('claude_unavailable', 'The photo reader is busy or unreachable. Wait a moment and try again.');
  if (error instanceof Anthropic.RateLimitError || error instanceof Anthropic.InternalServerError) return busy;
  // Before the next check: a dropped connection or a timeout is an APIError with no status.
  if (error instanceof Anthropic.APIConnectionError) return busy;
  if (error instanceof Anthropic.APIError) {
    console.error(`Claude replied ${error.status}: ${error.message}`);
    return typeof error.status === 'number' && error.status >= 500
      ? busy
      : new AppError('claude_unavailable', `This photo could not be read (error ${error.status}).`);
  }
  console.error('Claude request failed before a reply:', error);
  return busy;
}
