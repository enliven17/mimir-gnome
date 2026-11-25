import { isGnoAddress } from "@/lib/gno/config";

export type ApiErrorShape = {
  error: {
    code: string;
    message: string;
  };
};

export function createApiError(code: string, message: string): ApiErrorShape {
  return {
    error: {
      code,
      message,
    },
  };
}

export function parsePositiveIntegerParam(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

/** A well-formed gno.land address (g1…), lowercase, or null. */
export function parseAddressParam(value: string | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed || !isGnoAddress(trimmed)) {
    return null;
  }

  return trimmed;
}
