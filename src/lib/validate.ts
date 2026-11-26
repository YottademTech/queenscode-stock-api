import { AppError } from '../errors.ts';
import { tidyLines } from './text.ts';

// Checks on what a request sends. Each throws an AppError whose message names the field in plain
// words, because the app shows it to the person who typed the value.

export const MAX_QUANTITY = 1_000_000;

export function requiredText(value: unknown, label: string, maxLength: number): string {
  const text = optionalText(value, label, maxLength);
  if (text === '') throw new AppError('invalid_request', `Enter the ${label}.`);
  return text;
}

export function optionalText(value: unknown, label: string, maxLength: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new AppError('invalid_request', `The ${label} must be text.`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length > maxLength) throw new AppError('invalid_request', `The ${label} is too long (max ${maxLength}).`);
  return text;
}

/** Like optionalText, for fields that keep their line breaks. */
export function optionalLines(value: unknown, label: string, maxLength: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new AppError('invalid_request', `The ${label} must be text.`);
  const text = tidyLines(value);
  if (text.length > maxLength) throw new AppError('invalid_request', `The ${label} is too long (max ${maxLength}).`);
  return text;
}

export function wholeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_QUANTITY) {
    throw new AppError('invalid_request', `The ${label} must be a whole number from 0 to ${MAX_QUANTITY}.`);
  }
  return value;
}

export function optionalWholeNumber(value: unknown, label: string): number | null {
  return value === undefined || value === null ? null : wholeNumber(value, label);
}

export function oneOf<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new AppError('invalid_request', `Choose a valid ${label}.`);
  }
  return value as T;
}

/** The ID a phone gives a save, so the same save arriving twice is written once. */
export function requestIdOf(request: Record<string, unknown>): string {
  const requestId = String(request.requestId || '');
  if (!/^[A-Za-z0-9-]{8,64}$/.test(requestId)) throw new AppError('invalid_request', 'The save had no valid request ID.');
  return requestId;
}
