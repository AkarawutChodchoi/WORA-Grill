import { EventEmitter } from 'node:events';

/** Realtime domain events (SPEC §6). Payloads are small; clients refetch details. */
export type DomainEventType =
  | 'order.created'
  | 'order.updated'
  | 'order_item.status_changed'
  | 'table.status_changed'
  | 'menu.sold_out'
  | 'menu.updated'
  | 'call_waiter'
  | 'service_request.updated'
  | 'payment.confirmed'
  | 'kitchen.ticket'
  | 'stock.low'
  | 'reservation.updated'
  | 'waitlist.updated'
  | 'notification';

export interface DomainEvent {
  type: DomainEventType;
  organizationId: string;
  branchId: string | null;
  payload: Record<string, unknown>;
  at: string;
}

/**
 * In-process pub/sub. One API node is enough for a single restaurant; for horizontal scaling
 * replace with Redis pub/sub behind the same publish/subscribe interface (SPEC §7).
 */
export class EventBus {
  private emitter = new EventEmitter();
  constructor() {
    this.emitter.setMaxListeners(0);
  }
  publish(e: Omit<DomainEvent, 'at'>) {
    this.emitter.emit('event', { ...e, at: new Date().toISOString() } satisfies DomainEvent);
  }
  subscribe(fn: (e: DomainEvent) => void): () => void {
    this.emitter.on('event', fn);
    return () => this.emitter.off('event', fn);
  }
}
