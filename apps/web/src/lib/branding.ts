// The product's name as users see it (sign-in page, browser tab, sidebar fallback).
// Set VITE_PRODUCT_NAME at build time to rename it without touching code.
export const PRODUCT_NAME: string = (import.meta.env['VITE_PRODUCT_NAME'] as string | undefined)?.trim() || 'Twisha Transport POS'
