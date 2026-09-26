import { buildFolderTree } from "@openfield/core";
import { useQuery } from "@tanstack/react-query";
import { foldersQuery } from "../api/hooks/folders";

/**
 * The folder tree for the library, rebuilt only when the flat list changes. Structural sharing is
 * off: the tree links each folder to its parent and back, and TanStack's deep compare of two such
 * trees walks those links without end, which froze and crashed the tab on the second change.
 */
export const useLibraryTree = () =>
  useQuery({ ...foldersQuery, select: buildFolderTree, structuralSharing: false });
