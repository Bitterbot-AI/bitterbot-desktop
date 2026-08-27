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
    <Breadcrumb className="px-3 py-1.5 border-b border-border/30 bg-card/20">
      <BreadcrumbList className="text-2xs gap-1 flex-nowrap">
        {dirSegments.map((seg, i) => {
          const dirPath = segments.slice(0, i + 1).join("/");
          return (
            <BreadcrumbItem key={dirPath} className="gap-1">
              <BreadcrumbLink
                className="cursor-pointer text-muted-foreground hover:text-foreground transition-colors font-mono"
                onClick={() => onNavigateDir(dirPath)}
              >
                {seg}
              </BreadcrumbLink>
              <BreadcrumbSeparator className="[&>svg]:size-2.5" />
            </BreadcrumbItem>
          );
        })}
        <BreadcrumbItem>
          <BreadcrumbPage className="text-foreground font-mono text-2xs">{fileName}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
