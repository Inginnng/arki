import { Buffer } from "node:buffer";
import { randomBytes as secureRandomBytes } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import {
  OpaqueIdSchema,
  RelativePathSchema,
  Sha256DigestSchema,
} from "@aimd/contracts";

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const DEFAULT_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_MAX_RECORDS = 4_096;
const MAX_TOKEN_ATTEMPTS = 8;
const BINDING_KEYS = Object.freeze([
  "sessionId",
  "sourceHash",
  "diffHash",
  "targetPath",
] as const);

export type ApprovalBinding = Readonly<{
  sessionId: string;
  sourceHash: string;
  diffHash: string;
  targetPath: string;
}>;

export type ApprovalAuthorityOptions = Readonly<{
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
  ttlMs?: number;
  maxRecords?: number;
}>;

declare const APPROVAL_RESERVATION_BRAND: unique symbol;

export type ApprovalReservation = Readonly<{
  readonly [APPROVAL_RESERVATION_BRAND]: true;
}>;

export type ApprovalAuthorityErrorCode =
  | "APPROVAL_BINDING_INVALID"
  | "APPROVAL_CLOCK_INVALID"
  | "APPROVAL_OPTIONS_INVALID"
  | "APPROVAL_CAPACITY_EXCEEDED"
  | "APPROVAL_RANDOMNESS_INVALID"
  | "APPROVAL_TOKEN_COLLISION";

const ERROR_MESSAGES: Readonly<Record<ApprovalAuthorityErrorCode, string>> = Object.freeze({
  APPROVAL_BINDING_INVALID: "The approval binding is invalid.",
  APPROVAL_CLOCK_INVALID: "The approval clock is invalid.",
  APPROVAL_OPTIONS_INVALID: "The approval authority options are invalid.",
  APPROVAL_CAPACITY_EXCEEDED: "The approval capacity has been reached.",
  APPROVAL_RANDOMNESS_INVALID: "The approval randomness source is invalid.",
  APPROVAL_TOKEN_COLLISION: "A unique approval token could not be issued.",
});

export class ApprovalAuthorityError extends Error {
  readonly code: ApprovalAuthorityErrorCode;

  constructor(code: ApprovalAuthorityErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ApprovalAuthorityError";
    this.code = code;
  }
}

type ApprovalRecord = ApprovalBinding & {
  readonly expiresAt: number;
  state: "available" | "reserved" | "consumed";
};

type ReservationEntry = {
  readonly record: ApprovalRecord;
  active: boolean;
};

function readExactBinding(input: unknown): ApprovalBinding {
  if (typeof input !== "object" || input === null) {
    throw new ApprovalAuthorityError("APPROVAL_BINDING_INVALID");
  }
  if (nodeUtilTypes.isProxy(input)) {
    throw new ApprovalAuthorityError("APPROVAL_BINDING_INVALID");
  }
  if (Array.isArray(input)) {
    throw new ApprovalAuthorityError("APPROVAL_BINDING_INVALID");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ApprovalAuthorityError("APPROVAL_BINDING_INVALID");
  }
  const ownKeys = Reflect.ownKeys(input);
  if (
    ownKeys.length !== BINDING_KEYS.length ||
    ownKeys.some((key) => typeof key !== "string") ||
    BINDING_KEYS.some((key) => !ownKeys.includes(key))
  ) {
    throw new ApprovalAuthorityError("APPROVAL_BINDING_INVALID");
  }

  const values: Record<(typeof BINDING_KEYS)[number], unknown> = {
    sessionId: undefined,
    sourceHash: undefined,
    diffHash: undefined,
    targetPath: undefined,
  };
  for (const key of BINDING_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new ApprovalAuthorityError("APPROVAL_BINDING_INVALID");
    }
    values[key] = descriptor.value;
  }

  try {
    return Object.freeze({
      sessionId: OpaqueIdSchema.parse(values.sessionId),
      sourceHash: Sha256DigestSchema.parse(values.sourceHash),
      diffHash: Sha256DigestSchema.parse(values.diffHash),
      targetPath: RelativePathSchema.parse(values.targetPath),
    });
  } catch {
    throw new ApprovalAuthorityError("APPROVAL_BINDING_INVALID");
  }
}

function sameBinding(left: ApprovalBinding, right: ApprovalBinding): boolean {
  return left.sessionId === right.sessionId &&
    left.sourceHash === right.sourceHash &&
    left.diffHash === right.diffHash &&
    left.targetPath === right.targetPath;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export class ApprovalAuthority {
  readonly #records = new Map<string, ApprovalRecord>();
  readonly #reservations = new WeakMap<object, ReservationEntry>();
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #ttlMs: number;
  readonly #maxRecords: number;

  constructor(options: ApprovalAuthorityOptions = {}) {
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    const now = options.now ?? Date.now;
    const randomBytes = options.randomBytes ?? secureRandomBytes;
    if (
      !positiveSafeInteger(ttlMs) ||
      !positiveSafeInteger(maxRecords) ||
      typeof now !== "function" ||
      typeof randomBytes !== "function"
    ) {
      throw new ApprovalAuthorityError("APPROVAL_OPTIONS_INVALID");
    }
    this.#ttlMs = ttlMs;
    this.#maxRecords = maxRecords;
    this.#now = now;
    this.#randomBytes = randomBytes;
  }

  #currentTime(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - this.#ttlMs) {
      throw new ApprovalAuthorityError("APPROVAL_CLOCK_INVALID");
    }
    return now;
  }

  #pruneExpired(now: number): void {
    for (const [token, record] of this.#records) {
      if (record.state !== "reserved" && record.expiresAt <= now) {
        this.#records.delete(token);
      }
    }
  }

  #newToken(): string {
    for (let attempt = 0; attempt < MAX_TOKEN_ATTEMPTS; attempt += 1) {
      let bytes: Uint8Array;
      try {
        bytes = this.#randomBytes(TOKEN_BYTES);
      } catch {
        throw new ApprovalAuthorityError("APPROVAL_RANDOMNESS_INVALID");
      }
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== TOKEN_BYTES) {
        throw new ApprovalAuthorityError("APPROVAL_RANDOMNESS_INVALID");
      }
      const token = Buffer.from(bytes).toString("base64url");
      if (TOKEN_PATTERN.test(token) && !this.#records.has(token)) return token;
    }
    throw new ApprovalAuthorityError("APPROVAL_TOKEN_COLLISION");
  }

  issue(input: ApprovalBinding): string {
    const binding = readExactBinding(input);
    const now = this.#currentTime();
    this.#pruneExpired(now);
    if (this.#records.size >= this.#maxRecords) {
      throw new ApprovalAuthorityError("APPROVAL_CAPACITY_EXCEEDED");
    }
    const token = this.#newToken();
    this.#records.set(token, {
      ...binding,
      expiresAt: now + this.#ttlMs,
      state: "available",
    });
    return token;
  }

  verify(token: string, input: ApprovalBinding): boolean {
    if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return false;
    let binding: ApprovalBinding;
    let now: number;
    try {
      binding = readExactBinding(input);
      now = this.#currentTime();
    } catch {
      return false;
    }
    this.#pruneExpired(now);
    const record = this.#records.get(token);
    return record !== undefined &&
      record.state === "available" &&
      record.expiresAt > now &&
      sameBinding(record, binding);
  }

  reserve(token: string, input: ApprovalBinding): ApprovalReservation | false {
    if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return false;
    let binding: ApprovalBinding;
    let now: number;
    try {
      binding = readExactBinding(input);
      now = this.#currentTime();
    } catch {
      return false;
    }
    this.#pruneExpired(now);
    const record = this.#records.get(token);
    if (
      record === undefined ||
      record.state !== "available" ||
      record.expiresAt <= now ||
      !sameBinding(record, binding)
    ) {
      return false;
    }

    const reservation = Object.freeze(Object.create(null)) as ApprovalReservation;
    record.state = "reserved";
    this.#reservations.set(reservation, { record, active: true });
    return reservation;
  }

  commit(reservation: ApprovalReservation): boolean {
    if ((typeof reservation !== "object" && typeof reservation !== "function") || reservation === null) {
      return false;
    }
    const entry = this.#reservations.get(reservation);
    if (entry === undefined || !entry.active || entry.record.state !== "reserved") return false;
    entry.record.state = "consumed";
    entry.active = false;
    return true;
  }

  release(reservation: ApprovalReservation): boolean {
    if ((typeof reservation !== "object" && typeof reservation !== "function") || reservation === null) {
      return false;
    }
    const entry = this.#reservations.get(reservation);
    if (entry === undefined || !entry.active || entry.record.state !== "reserved") return false;
    entry.record.state = "available";
    entry.active = false;
    return true;
  }

  consume(token: string, input: ApprovalBinding): boolean {
    if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return false;
    let binding: ApprovalBinding;
    let now: number;
    try {
      binding = readExactBinding(input);
      now = this.#currentTime();
    } catch {
      return false;
    }
    this.#pruneExpired(now);
    const record = this.#records.get(token);
    if (
      record === undefined ||
      record.state !== "available" ||
      record.expiresAt <= now ||
      !sameBinding(record, binding)
    ) {
      return false;
    }
    record.state = "consumed";
    return true;
  }
}

export function createApprovalAuthority(
  options: ApprovalAuthorityOptions = {},
): ApprovalAuthority {
  return new ApprovalAuthority(options);
}
