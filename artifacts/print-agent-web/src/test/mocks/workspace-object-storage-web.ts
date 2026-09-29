import { vi } from "vitest";

export const ObjectUploader = vi.fn(() => null);
export const useUpload = vi.fn(() => ({ openUploader: vi.fn() }));
