import { inflateRawSync } from "node:zlib";

const ZIP_LOCAL_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;

const MAX_ENTRY_COUNT = 1_000;
const MAX_ENTRY_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;
const MAX_END_RECORD_SEARCH = 65_557;

const REQUIRED_XLSX_ENTRIES = new Set([
  "[Content_Types].xml",
  "_rels/.rels",
  "xl/workbook.xml",
]);

export type XlsxValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

function invalid(reason: string): XlsxValidationResult {
  return { valid: false, reason };
}

function findEndRecordOffset(buffer: Buffer): number {
  const start = Math.max(0, buffer.length - MAX_END_RECORD_SEARCH);
  for (let offset = buffer.length - 22; offset >= start; offset--) {
    if (buffer.readUInt32LE(offset) === ZIP_END_SIGNATURE) return offset;
  }
  return -1;
}

/**
 * Validate an XLSX ZIP container before ExcelJS parses it.
 *
 * This checks the central directory and required OOXML parts, rejects encrypted,
 * ZIP64, multi-disk, duplicate, traversal, and unsupported entries, caps archive
 * expansion, and verifies each deflate stream with a bounded output allocation.
 */
export function validateXlsxUpload(buffer: Buffer): XlsxValidationResult {
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== ZIP_LOCAL_HEADER_SIGNATURE) {
    return invalid("missing XLSX ZIP signature");
  }

  const endOffset = findEndRecordOffset(buffer);
  if (endOffset < 0 || endOffset + 22 > buffer.length) {
    return invalid("missing ZIP central directory");
  }

  const diskNumber = buffer.readUInt16LE(endOffset + 4);
  const centralDirectoryDisk = buffer.readUInt16LE(endOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(endOffset + 8);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralDirectorySize = buffer.readUInt32LE(endOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(endOffset + 16);
  const commentLength = buffer.readUInt16LE(endOffset + 20);

  if (endOffset + 22 + commentLength !== buffer.length) {
    return invalid("invalid ZIP end record");
  }
  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) {
    return invalid("multi-disk ZIP files are not supported");
  }
  if (
    entryCount === ZIP64_SENTINEL_16 ||
    centralDirectorySize === ZIP64_SENTINEL_32 ||
    centralDirectoryOffset === ZIP64_SENTINEL_32
  ) {
    return invalid("ZIP64 XLSX files are not supported");
  }
  if (entryCount === 0 || entryCount > MAX_ENTRY_COUNT) {
    return invalid("XLSX archive has too many entries");
  }
  if (
    centralDirectoryOffset > endOffset ||
    centralDirectorySize > endOffset - centralDirectoryOffset ||
    centralDirectoryOffset + centralDirectorySize !== endOffset
  ) {
    return invalid("invalid ZIP central directory bounds");
  }

  const seenEntries = new Set<string>();
  const localEntryRanges: Array<{ start: number; end: number }> = [];
  let totalUncompressedBytes = 0;
  let cursor = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > endOffset || buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_HEADER_SIGNATURE) {
      return invalid("invalid ZIP central directory entry");
    }

    const flags = buffer.readUInt16LE(cursor + 8);
    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const entryCommentLength = buffer.readUInt16LE(cursor + 32);
    const entryDisk = buffer.readUInt16LE(cursor + 34);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const nextCursor = cursor + 46 + fileNameLength + extraLength + entryCommentLength;

    if (nextCursor > endOffset) return invalid("invalid ZIP entry bounds");
    if (entryDisk !== 0 || localHeaderOffset === ZIP64_SENTINEL_32) {
      return invalid("multi-disk or ZIP64 entries are not supported");
    }
    if ((flags & 0x1) !== 0) return invalid("encrypted XLSX entries are not supported");
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      return invalid("unsupported XLSX compression method");
    }
    if (
      compressedSize === ZIP64_SENTINEL_32 ||
      uncompressedSize === ZIP64_SENTINEL_32
    ) {
      return invalid("ZIP64 XLSX entries are not supported");
    }
    if (uncompressedSize > MAX_ENTRY_UNCOMPRESSED_BYTES) {
      return invalid("XLSX entry exceeds the expanded size limit");
    }

    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      return invalid("XLSX archive exceeds the expanded size limit");
    }
    if (
      compressedSize === 0
        ? uncompressedSize !== 0
        : uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO
    ) {
      return invalid("XLSX entry exceeds the compression ratio limit");
    }

    const fileNameStart = cursor + 46;
    const fileName = buffer
      .subarray(fileNameStart, fileNameStart + fileNameLength)
      .toString("utf8");
    if (
      !fileName ||
      fileName.includes("\0") ||
      fileName.includes("\\") ||
      fileName.startsWith("/") ||
      fileName.split("/").includes("..")
    ) {
      return invalid("invalid XLSX entry path");
    }
    if (seenEntries.has(fileName)) return invalid("duplicate XLSX entry");
    seenEntries.add(fileName);

    if (
      localHeaderOffset + 30 > centralDirectoryOffset ||
      buffer.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_HEADER_SIGNATURE
    ) {
      return invalid("invalid XLSX local file header");
    }
    const localFlags = buffer.readUInt16LE(localHeaderOffset + 6);
    const localCompressionMethod = buffer.readUInt16LE(localHeaderOffset + 8);
    const localCompressedSize = buffer.readUInt32LE(localHeaderOffset + 18);
    const localUncompressedSize = buffer.readUInt32LE(localHeaderOffset + 22);
    const localFileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
    if (
      dataStart > centralDirectoryOffset ||
      compressedSize > centralDirectoryOffset - dataStart
    ) {
      return invalid("invalid XLSX compressed data bounds");
    }
    const localFileName = buffer
      .subarray(localHeaderOffset + 30, localHeaderOffset + 30 + localFileNameLength)
      .toString("utf8");
    if (
      localFlags !== flags ||
      localCompressionMethod !== compressionMethod ||
      localFileName !== fileName
    ) {
      return invalid("XLSX local header does not match central directory");
    }
    // When bit 3 is set, sizes are intentionally deferred to a data descriptor.
    if (
      (flags & 0x8) === 0 &&
      (localCompressedSize !== compressedSize ||
        localUncompressedSize !== uncompressedSize)
    ) {
      return invalid("XLSX local entry sizes do not match central directory");
    }

    localEntryRanges.push({
      start: localHeaderOffset,
      end: dataStart + compressedSize,
    });

    const compressedData = buffer.subarray(dataStart, dataStart + compressedSize);
    try {
      if (compressionMethod === 0) {
        if (compressedSize !== uncompressedSize) {
          return invalid("invalid stored XLSX entry size");
        }
      } else {
        const output = inflateRawSync(compressedData, {
          maxOutputLength: Math.min(
            uncompressedSize + 1,
            MAX_ENTRY_UNCOMPRESSED_BYTES + 1,
          ),
        });
        if (output.length !== uncompressedSize) {
          return invalid("XLSX entry size does not match its metadata");
        }
      }
    } catch {
      return invalid("invalid or oversized XLSX compressed data");
    }

    cursor = nextCursor;
  }

  if (cursor !== endOffset) return invalid("invalid ZIP central directory size");
  localEntryRanges.sort((a, b) => a.start - b.start);
  for (let index = 1; index < localEntryRanges.length; index++) {
    if (localEntryRanges[index].start < localEntryRanges[index - 1].end) {
      return invalid("overlapping XLSX local entries");
    }
  }
  for (const requiredEntry of REQUIRED_XLSX_ENTRIES) {
    if (!seenEntries.has(requiredEntry)) {
      return invalid(`missing required XLSX entry: ${requiredEntry}`);
    }
  }

  return { valid: true };
}