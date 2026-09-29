export interface ImageDimensions {
  width: number;
  height: number;
  type: string;
}

export function imageSize(input: Buffer | Uint8Array | string): ImageDimensions;

export default imageSize;