// SPDX-FileCopyrightText: 2026 David Rukahu
// SPDX-License-Identifier: Apache-2.0

/**
 * In-memory store implementations.
 *
 * These are the reference semantics the Postgres-backed stores must reproduce, and what the test
 * suite runs against. They are not a production path — PRD §12.3 puts raw payloads in object
 * storage and canonical state in Postgres.
 */

import type { RawReceipt } from '../import/receipt.js'
import type {
  ObservationStore,
  QuarantineStore,
  ReceiptStore,
} from '../import/batch.js'
import type { QuarantinedRow } from '../import/quarantine.js'

export class MemoryReceiptStore implements ReceiptStore {
  private readonly items: RawReceipt[] = []

  async append(receipt: RawReceipt): Promise<void> {
    // Append-only: a receipt is never updated or removed (PRD §7.3).
    this.items.push(receipt)
  }

  async count(): Promise<number> {
    return this.items.length
  }

  async all(): Promise<readonly RawReceipt[]> {
    return [...this.items]
  }
}

export class MemoryObservationStore implements ObservationStore {
  private readonly items = new Map<string, Record<string, unknown>>()

  async putIfAbsent(key: string, observation: Record<string, unknown>): Promise<boolean> {
    if (this.items.has(key)) return false
    this.items.set(key, observation)
    return true
  }

  async count(): Promise<number> {
    return this.items.size
  }

  async get(key: string): Promise<Record<string, unknown> | undefined> {
    return this.items.get(key)
  }

  async keys(): Promise<readonly string[]> {
    return [...this.items.keys()]
  }
}

export class MemoryQuarantineStore implements QuarantineStore {
  private readonly items: QuarantinedRow[] = []

  async append(row: QuarantinedRow): Promise<void> {
    this.items.push(row)
  }

  async list(): Promise<readonly QuarantinedRow[]> {
    return [...this.items]
  }
}

export function createMemoryStores(): {
  receipts: MemoryReceiptStore
  observations: MemoryObservationStore
  quarantine: MemoryQuarantineStore
} {
  return {
    receipts: new MemoryReceiptStore(),
    observations: new MemoryObservationStore(),
    quarantine: new MemoryQuarantineStore(),
  }
}
