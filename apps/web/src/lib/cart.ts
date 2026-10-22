import { useSyncExternalStore } from 'react';

/**
 * The cart lives in this browser (a per-visitor convenience): listing ids and quantities only.
 * Prices, stock and sellers are always read fresh from the API when the cart is shown, and the
 * server prices the order again at checkout.
 */
export interface CartItem {
  offerId: string;
  quantity: number;
}
const KEY = 'bz.cart';
export const MAX_CART_ITEMS = 20;

let items: CartItem[] = read();
const listeners = new Set<() => void>();

function read(): CartItem[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((i) => typeof i?.offerId === 'string' && i.quantity > 0) : [];
  } catch {
    return [];
  }
}
function write(next: CartItem[]) {
  items = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage blocked: the cart lasts for this visit */
  }
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => e.key === KEY && ((items = read()), l());
  window.addEventListener('storage', onStorage); // other tabs
  return () => {
    listeners.delete(l);
    window.removeEventListener('storage', onStorage);
  };
};

export const useCart = () => useSyncExternalStore(subscribe, () => items);
export const cartCount = (list: CartItem[]) => list.reduce((n, i) => n + i.quantity, 0);

/** Adds to an existing line rather than duplicating it. Returns false when the cart is full. */
export function addToCart(offerId: string, quantity: number) {
  const line = items.find((i) => i.offerId === offerId);
  if (!line && items.length >= MAX_CART_ITEMS) return false;
  write(line ? items.map((i) => (i.offerId === offerId ? { ...i, quantity: i.quantity + quantity } : i)) : [...items, { offerId, quantity }]);
  return true;
}
export const setQuantity = (offerId: string, quantity: number) => write(items.map((i) => (i.offerId === offerId ? { ...i, quantity: Math.max(1, quantity) } : i)));
export const removeFromCart = (offerId: string) => write(items.filter((i) => i.offerId !== offerId));
export const clearCart = () => write([]);
