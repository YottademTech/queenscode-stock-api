import { AppError } from '../errors.ts';
import { isRecord } from '../lib/text.ts';
import type { SheetGateway } from '../sheet/gateway.ts';

export const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const;
export type ImageMediaType = keyof typeof IMAGE_TYPES;
export type EncodedImage = { data: string; mediaType: ImageMediaType };

const MAX_IMAGE_BASE64_LENGTH = 7_000_000; // about 5 MB of image, the Claude API per-image limit

/** A photo in a request: base64 of a JPEG, PNG or WebP. */
export function parseImage(image: unknown): EncodedImage {
  if (!isRecord(image) || typeof image.data !== 'string' || typeof image.mediaType !== 'string' || !Object.hasOwn(IMAGE_TYPES, image.mediaType)) {
    throw new AppError('invalid_request', 'The photo must be a JPEG, PNG or WebP image.');
  }
  if (image.data.length === 0 || image.data.length > MAX_IMAGE_BASE64_LENGTH) {
    throw new AppError('invalid_request', 'The photo is empty or too large.');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) {
    throw new AppError('invalid_request', 'The photo data is not valid.');
  }
  return { data: image.data, mediaType: image.mediaType as ImageMediaType };
}

/**
 * Where product photos are kept. Google Drive for now; moving to blob storage later means a second
 * implementation of this, and nothing else changes.
 */
export type PhotoStore = {
  /** Stores the photos and returns a link for each, in order. `code` only names the files. */
  store(code: string, images: readonly EncodedImage[]): Promise<string[]>;
  /** Removes photos no product refers to any more. */
  trash(urls: readonly string[]): Promise<void>;
};

const GATEWAY_TIMEOUT_MS = 90_000;

/** Google Drive, reached through the Apps Script: it owns the folder, so only it may add files. */
export function drivePhotoStore(gateway: SheetGateway | null): PhotoStore {
  const connected = (): SheetGateway => {
    if (!gateway) throw new AppError('not_configured', 'Photos cannot be saved yet: the server is not connected to Google Drive (SHEET_GATEWAY_URL).');
    return gateway;
  };
  return {
    async store(code, images) {
      const reply = await connected().call('storeImages', { code, images }, GATEWAY_TIMEOUT_MS);
      if (!reply.ok) {
        throw reply.error.code === 'invalid_request'
          ? new AppError('invalid_request', reply.error.message)
          : new AppError('busy', 'The photos could not be stored just now. Try again in a moment.');
      }
      const urls = isRecord(reply.data) && Array.isArray(reply.data.urls) ? reply.data.urls.map(String) : [];
      if (urls.length !== images.length) throw new AppError('busy', 'The photos could not be stored just now. Try again in a moment.');
      return urls;
    },
    async trash(urls) {
      const reply = await connected().call('trashImages', { urls }, GATEWAY_TIMEOUT_MS);
      if (!reply.ok) throw new Error(`Drive did not trash the photos: ${reply.error.code}`);
    },
  };
}
