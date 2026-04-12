import { useMemo } from "react";
import { useWorkspaceStore } from "../../stores/workspace-store";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "../ui/command";
import { flattenTree, getFileIcon } from "./workspace-utils";

export function QuickOpenDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const tree = useWorkspaceStore((s) => s.tree);
  const openFile = useWorkspaceStore((s) => s.openFile);

  const filePaths = useMemo(() => flattenTree(tree), [tree]);

  const handleSelect = (path: string) => {
    openFile(path);
    onOpenChange(false);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Quick Open"
      description="Search for a file to open..."
    >
      <CommandInput placeholder="Type a filename..." />
      <CommandList>
        <CommandEmpty>No files found.</CommandEmpty>
        <CommandGroup heading="Files">
          {filePaths.map((filePath) => {
            const fileName = filePath.split("/").pop() ?? filePath;
            const Icon = getFileIcon(fileName);
            return (
              <CommandItem key={filePath} value={filePath} onSelect={() => handleSelect(filePath)}>
                <Icon className="w-4 h-4 text-blue-400/60 flex-shrink-0" />
                <span className="font-mono text-xs truncate">{filePath}</span>
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
