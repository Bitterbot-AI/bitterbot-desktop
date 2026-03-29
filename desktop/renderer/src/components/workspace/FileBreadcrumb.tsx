import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "../ui/breadcrumb";

export function FileBreadcrumb({
  filePath,
  onNavigateDir,
}: {
  filePath: string;
  onNavigateDir: (dirPath: string) => void;
}) {
  const segments = filePath.split("/");
  const fileName = segments[segments.length - 1];
  const dirSegments = segments.slice(0, -1);

  return (
    <Breadcrumb className="px-3 py-1.5 border-b border-zinc-800/30 bg-zinc-900/20">
      <BreadcrumbList className="text-[11px] gap-1 flex-nowrap">
        {dirSegments.map((seg, i) => {
          const dirPath = segments.slice(0, i + 1).join("/");
          return (
            <BreadcrumbItem key={dirPath} className="gap-1">
              <BreadcrumbLink
                className="cursor-pointer text-zinc-500 hover:text-zinc-300 transition-colors font-mono"
                onClick={() => onNavigateDir(dirPath)}
              >
                {seg}
              </BreadcrumbLink>
              <BreadcrumbSeparator className="[&>svg]:size-2.5" />
            </BreadcrumbItem>
          );
        })}
        <BreadcrumbItem>
          <BreadcrumbPage className="text-zinc-300 font-mono text-[11px]">
            {fileName}
          </BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
