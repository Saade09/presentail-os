/**
 * Shared type definitions for integration tests.
 *
 * Import these instead of re-declaring inline so that the narrow union is
 * enforced in one place and TypeScript catches any widening (e.g. `string`)
 * at compile time across every integration test file.
 */

/**
 * The two workspace roles that integration test stubs can assume.
 * Matches WorkspaceRequest["workspaceRole"] from ../lib/workspace.
 */
export type WorkspaceRole = "owner" | "member";
