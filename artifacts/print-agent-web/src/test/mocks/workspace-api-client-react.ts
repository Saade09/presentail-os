import { vi } from "vitest";

export const usePutCountryFlag = vi.fn(() => ({ mutate: vi.fn(), isPending: false }));
export const useDeleteCountryFlag = vi.fn(() => ({ mutate: vi.fn(), isPending: false }));
